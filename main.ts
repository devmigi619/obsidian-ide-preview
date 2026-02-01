import {
  Plugin,
  WorkspaceLeaf,
  TFile,
  FileView,
  Notice,
  WorkspaceSplit,
} from "obsidian";
import { around } from "monkey-around";

// ═══════════════════════════════════════════════════════════════════════════
// 타입 정의
// ═══════════════════════════════════════════════════════════════════════════

/** 탭의 상태 */
type TabState = "empty" | "preview" | "permanent";

/** Leaf의 위치 */
type LeafLocation = "sidebar" | "main";

/** 파일 열기 의도 */
type OpenIntent = "browse" | "create";

/** 내부 API 타입 (Obsidian이 노출하지 않는 타입) */
interface InternalLeaf {
  id?: string;
  tabHeaderEl?: HTMLElement;
  parent?: {
    children?: WorkspaceLeaf[];
  };
  containerEl?: HTMLElement;
}

interface InternalWorkspace {
  rootSplit: WorkspaceSplit;
  leftSplit: WorkspaceSplit;
  rightSplit: WorkspaceSplit;
}

interface FileExplorerView {
  activeDom?: {
    file?: { path: string };
  } | null;
}

// ═══════════════════════════════════════════════════════════════════════════
// 설정
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG = {
  /** 인라인 제목 변경 시 파일명 반영 대기 시간 */
  TITLE_RENAME_DEBOUNCE_MS: 300,

  /** Daily Note 파일명 패턴 */
  DAILY_NOTE_PATTERN: /^\d{4}-\d{2}-\d{2}\.md$/,

  /** CSS 클래스명 */
  CSS_CLASSES: {
    PREVIEW_TAB: "is-preview-tab",
    ACTIVE: "is-active",
    HAS_FOCUS: "has-focus",
  },

  /** 로그 프리픽스 */
  LOG_PREFIX: "[IDE Preview]",
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// 유틸리티 함수
// ═══════════════════════════════════════════════════════════════════════════

function log(message: string, ...args: unknown[]) {
  console.log(`${CONFIG.LOG_PREFIX} ${message}`, ...args);
}

// ═══════════════════════════════════════════════════════════════════════════
// 메인 플러그인
// ═══════════════════════════════════════════════════════════════════════════

/**
 * IDE Style Preview Plugin
 *
 * VS Code 스타일의 Preview 탭 동작을 Obsidian에 구현
 * - 탐색(싱글 클릭): Preview 탭 (이탤릭, 재사용됨)
 * - 확정(더블 클릭/편집): Permanent 탭
 */
export default class IDEStylePreviewPlugin extends Plugin {
  // ─────────────────────────────────────────────────────────────────────────
  // 상태
  // ─────────────────────────────────────────────────────────────────────────

  /** Preview 상태인 탭들 */
  private previewLeaves = new WeakSet<WorkspaceLeaf>();

  /** openFile에서 이미 처리한 탭 (setViewState 중복 방지) */
  private processedByOpenFile = new WeakSet<WorkspaceLeaf>();

  /** Ctrl+Click 감지 플래그 */
  private isCtrlClickPending = false;

  /** 더블클릭으로 연 파일들 (탭 닫을 때 탐색기 정리용) */
  private filesOpenedByDoubleClick = new Set<string>();

  /** 가장 최근에 열린 leaf */
  private lastActiveLeaf: WorkspaceLeaf | null = null;

  /** 제목 변경 debounce 타이머 */
  private titleRenameTimer: number | null = null;

  /** 패치 해제 함수들 */
  private cleanupFunctions: (() => void)[] = [];

  // ─────────────────────────────────────────────────────────────────────────
  // 라이프사이클
  // ─────────────────────────────────────────────────────────────────────────

  async onload() {
    log("Plugin loaded");

    this.installPatches();
    this.registerEventHandlers();
  }

  onunload() {
    this.cleanupFunctions.forEach((cleanup) => cleanup());
    this.cleanupFunctions = [];

    this.removeAllPreviewStyles();

    log("Plugin unloaded");
  }

  private installPatches() {
    this.patchOpenFile();
    this.patchSetViewState();
    this.patchDetach();
  }

  private registerEventHandlers() {
    this.registerFileOpenHandler();
    this.registerClickHandlers();
    this.registerPromotionTriggers();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 탭 상태 관리
  // ─────────────────────────────────────────────────────────────────────────

  private getTabState(leaf: WorkspaceLeaf): TabState {
    if (leaf.view?.getViewType() === "empty") return "empty";
    if (this.previewLeaves.has(leaf)) return "preview";
    return "permanent";
  }

  private setAsPreview(leaf: WorkspaceLeaf) {
    this.previewLeaves.add(leaf);
    this.updateTabStyle(leaf);
  }

  private setAsPermanent(leaf: WorkspaceLeaf) {
    this.previewLeaves.delete(leaf);
    this.updateTabStyle(leaf);
  }

  private promoteToPermament(leaf: WorkspaceLeaf) {
    if (!this.previewLeaves.has(leaf)) return;

    this.setAsPermanent(leaf);
    log("Promoted to permanent:", this.getLeafDebugId(leaf));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 위치 판단 (사용자 멘탈 모델 기반)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Leaf가 사이드바에 있는지 판단
   * - 사용자 관점: "왼쪽/오른쪽 패널"
   * - 구현 세부사항(file-explorer, bookmarks 등)에 의존하지 않음
   */
  private getLeafLocation(leaf: WorkspaceLeaf): LeafLocation {
    const workspace = this.app.workspace as unknown as InternalWorkspace;
    const root = leaf.getRoot();

    if (root === workspace.leftSplit || root === workspace.rightSplit) {
      return "sidebar";
    }
    return "main";
  }

  private isInSidebar(leaf: WorkspaceLeaf): boolean {
    return this.getLeafLocation(leaf) === "sidebar";
  }


  // ─────────────────────────────────────────────────────────────────────────
  // 의도 판별
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * 파일 열기 의도 판별
   * - create: 새 노트 생성, Daily Note 등 → Permanent
   * - browse: 탐색 목적 → Preview
   */
  private determineOpenIntent(file: TFile, openState?: any): OpenIntent {
    // 새 노트 생성 (이름 변경 모드로 열림)
    if (openState?.eState?.rename === "all") {
      return "create";
    }

    // Daily Note (source 모드 + 날짜 패턴)
    if (openState?.state?.mode === "source") {
      if (CONFIG.DAILY_NOTE_PATTERN.test(file.name)) {
        return "create";
      }
    }

    return "browse";
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Leaf 탐색
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * 같은 탭 그룹 내에서 특정 파일이 열린 탭 찾기
   */
  private findLeafWithFile(
    filePath: string,
    inSameGroupAs: WorkspaceLeaf
  ): WorkspaceLeaf | null {
    const siblings = this.getSiblingLeaves(inSameGroupAs);

    for (const sibling of siblings) {
      if (this.getFilePath(sibling) === filePath) {
        return sibling;
      }
    }
    return null;
  }

  /**
   * 같은 탭 그룹 내에서 Preview 탭 찾기
   */
  private findPreviewLeaf(inSameGroupAs: WorkspaceLeaf): WorkspaceLeaf | null {
    const siblings = this.getSiblingLeaves(inSameGroupAs);

    for (const sibling of siblings) {
      if (this.previewLeaves.has(sibling)) {
        return sibling;
      }
    }
    return null;
  }

  /**
   * 같은 탭 그룹의 형제 탭들 가져오기
   */
  private getSiblingLeaves(leaf: WorkspaceLeaf): WorkspaceLeaf[] {
    const internal = leaf as InternalLeaf;
    const children = internal.parent?.children;

    if (!children) return [];
    return children.filter((child) => child !== leaf);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // openFile 패치
  // ─────────────────────────────────────────────────────────────────────────

  private patchOpenFile() {
    const plugin = this;

    const uninstall = around(WorkspaceLeaf.prototype, {
      openFile(original) {
        return async function (
          this: WorkspaceLeaf,
          file: TFile,
          openState?: any
        ) {
          return plugin.handleOpenFile(this, file, openState, original);
        };
      },
    });

    this.cleanupFunctions.push(uninstall);
    log("Patched openFile");
  }

  private async handleOpenFile(
    leaf: WorkspaceLeaf,
    file: TFile,
    openState: any,
    originalMethod: Function
  ) {
    const currentState = this.getTabState(leaf);
    const intent = this.determineOpenIntent(file, openState);
    const isCtrlClick = this.consumeCtrlClickFlag();
    const shouldBePermanent = intent === "create" || isCtrlClick;

    log(`openFile: ${file.path}`);
    log(`  state=${currentState}, intent=${intent}, permanent=${shouldBePermanent}`);

    // 이미 같은 파일이 열려있으면 무시
    if (this.getFilePath(leaf) === file.path) {
      log("  → Same file, skipping");
      return;
    }

    // 다른 탭에 이미 열려있으면 포커스만 이동
    const existingLeaf = this.findLeafWithFile(file.path, leaf);
    if (existingLeaf && intent === "browse" && !isCtrlClick) {
      log("  → Already open, focusing existing tab");
      this.app.workspace.setActiveLeaf(existingLeaf, { focus: true });
      return;
    }

    // Permanent로 열어야 하는 경우
    if (shouldBePermanent) {
      // Permanent/Preview 탭 보존: 새 탭에서 열기
      if (currentState === "permanent" || currentState === "preview") {
        return this.openInNewTab(leaf, file, openState, true, originalMethod);
      }
      // Empty 탭: 현재 탭에서 Permanent로 열기
      this.markAsProcessed(leaf);
      const result = await originalMethod.call(leaf, file, openState);
      this.setAsPermanent(leaf);
      return result;
    }

    // Preview로 열어야 하는 경우: 기존 Preview 탭 재사용
    const existingPreview = this.findPreviewLeaf(leaf);
    if (existingPreview) {
      log("  → Reusing existing preview tab");
      this.markAsProcessed(existingPreview);
      const result = await originalMethod.call(existingPreview, file, openState);
      this.app.workspace.setActiveLeaf(existingPreview, { focus: true });
      return result;
    }

    // Preview가 없는 경우
    if (currentState === "permanent") {
      // Permanent 탭 보존: 새 Preview 탭 생성
      return this.openInNewTab(leaf, file, openState, false, originalMethod);
    }

    // Empty 또는 Preview 탭: 현재 탭에서 Preview로 열기
    this.markAsProcessed(leaf);
    const result = await originalMethod.call(leaf, file, openState);
    this.setAsPreview(leaf);
    return result;
  }

  private async openInNewTab(
    _fromLeaf: WorkspaceLeaf,
    file: TFile,
    openState: any,
    asPermanent: boolean,
    originalMethod: Function
  ) {
    log("  → Opening in new tab");

    const newLeaf = this.app.workspace.getLeaf("tab");
    this.markAsProcessed(newLeaf);
    const result = await originalMethod.call(newLeaf, file, openState);

    if (asPermanent) {
      this.setAsPermanent(newLeaf);
    } else {
      this.setAsPreview(newLeaf);
    }

    this.app.workspace.setActiveLeaf(newLeaf, { focus: true });
    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // setViewState 패치 (비파일 뷰 처리)
  // ─────────────────────────────────────────────────────────────────────────

  private patchSetViewState() {
    const plugin = this;

    const uninstall = around(WorkspaceLeaf.prototype, {
      setViewState(original) {
        return async function (this: WorkspaceLeaf, viewState: any, eState?: any) {
          return plugin.handleSetViewState(this, viewState, eState, original);
        };
      },
    });

    this.cleanupFunctions.push(uninstall);
    log("Patched setViewState");
  }

  private async handleSetViewState(
    leaf: WorkspaceLeaf,
    viewState: any,
    eState: any,
    originalMethod: Function
  ) {
    // openFile에서 이미 처리했으면 패스
    if (this.wasProcessed(leaf)) {
      this.clearProcessed(leaf);
      return originalMethod.call(leaf, viewState, eState);
    }

    const viewType = viewState?.type;

    // 파일 뷰나 empty는 openFile에서 처리됨
    if (viewType === "markdown" || viewType === "empty") {
      return originalMethod.call(leaf, viewState, eState);
    }

    // 사이드바의 뷰는 그대로 유지
    if (this.isInSidebar(leaf)) {
      return originalMethod.call(leaf, viewState, eState);
    }

    // 메인 영역의 비파일 뷰 (graph, canvas, pdf 등)
    const currentState = this.getTabState(leaf);
    log(`setViewState: type=${viewType}, state=${currentState}`);

    if (currentState === "permanent") {
      const newLeaf = this.app.workspace.getLeaf("tab");
      const result = await originalMethod.call(newLeaf, viewState, eState);
      this.setAsPreview(newLeaf);
      return result;
    }

    const result = await originalMethod.call(leaf, viewState, eState);
    this.setAsPreview(leaf);
    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // detach 패치 (탭 닫힘 처리)
  // ─────────────────────────────────────────────────────────────────────────

  private patchDetach() {
    const plugin = this;

    const uninstall = around(WorkspaceLeaf.prototype, {
      detach(original) {
        return function (this: WorkspaceLeaf) {
          const path = plugin.getFilePath(this);

          // 더블클릭으로 열었던 파일이면 탐색기 정리
          if (path && plugin.filesOpenedByDoubleClick.has(path)) {
            plugin.clearFileExplorerSelection(path);
            plugin.filesOpenedByDoubleClick.delete(path);
          }

          return original.call(this);
        };
      },
    });

    this.cleanupFunctions.push(uninstall);
    log("Patched detach");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 이벤트 핸들러
  // ─────────────────────────────────────────────────────────────────────────

  private registerFileOpenHandler() {
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (!file) return;

        const activeLeaf = this.getActiveLeaf();
        if (activeLeaf?.view?.getViewType() === "markdown") {
          this.lastActiveLeaf = activeLeaf;
        }
      })
    );
  }

  private registerClickHandlers() {
    // Ctrl+Click 감지
    this.registerDomEvent(document, "click", (evt: MouseEvent) => {
      if ((evt.ctrlKey || evt.metaKey) && this.isFileElement(evt.target)) {
        this.isCtrlClickPending = true;
      }
    }, true);

    // 더블클릭 처리
    this.registerDomEvent(document, "dblclick", (evt: MouseEvent) => {
      this.handleDoubleClick(evt);
    }, true);
  }

  private handleDoubleClick(evt: MouseEvent) {
    const target = evt.target as HTMLElement;

    // 탭 헤더 더블클릭 → 승격
    if (target.closest(".workspace-tab-header")) {
      const activeLeaf = this.getActiveLeaf();
      if (activeLeaf && this.previewLeaves.has(activeLeaf)) {
        log("Tab header double-click → promote");
        this.promoteToPermament(activeLeaf);
      }
      return;
    }

    // 사이드바에서 더블클릭 → 승격
    const sidebarContent = target.closest(".workspace-leaf-content");
    if (sidebarContent) {
      const leaf = this.findLeafByContentEl(sidebarContent as HTMLElement);
      if (leaf && this.isInSidebar(leaf)) {
        if (this.lastActiveLeaf && this.previewLeaves.has(this.lastActiveLeaf)) {
          const path = this.getFilePath(this.lastActiveLeaf);
          log("Sidebar double-click → promote:", path);
          this.promoteToPermament(this.lastActiveLeaf);

          // 탐색기 정리용 추적
          if (path) {
            this.filesOpenedByDoubleClick.add(path);
          }
        }
        return;
      }
    }

    // 그래프 뷰 더블클릭 → 승격
    if (target.closest(".graph-view-container")) {
      if (this.lastActiveLeaf && this.previewLeaves.has(this.lastActiveLeaf)) {
        log("Graph double-click → promote");
        this.promoteToPermament(this.lastActiveLeaf);
      }
    }
  }

  private registerPromotionTriggers() {
    // 편집 시 승격
    this.registerEvent(
      this.app.workspace.on("editor-change", (editor, info) => {
        const leaf = (info as any).leaf as WorkspaceLeaf | undefined;
        if (leaf && this.previewLeaves.has(leaf)) {
          log("Editor change → promote");
          this.promoteToPermament(leaf);
        }
      })
    );

    // 파일명 변경 시 승격
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        this.app.workspace.iterateAllLeaves((leaf) => {
          if (this.getFilePath(leaf) === file.path && this.previewLeaves.has(leaf)) {
            log("File renamed → promote");
            this.promoteToPermament(leaf);
          }
        });
      })
    );

    // 인라인 제목 편집 시
    this.registerDomEvent(document, "input", (evt: Event) => {
      this.handleInlineTitleEdit(evt);
    }, true);
  }

  private handleInlineTitleEdit(evt: Event) {
    const target = evt.target as HTMLElement;
    if (!target.classList.contains("inline-title")) return;

    const activeLeaf = this.getActiveLeaf();
    if (!activeLeaf) return;

    // Preview면 승격
    if (this.previewLeaves.has(activeLeaf)) {
      log("Inline title edit → promote");
      this.promoteToPermament(activeLeaf);
    }

    // 실시간 파일명 변경
    this.scheduleFileRename(activeLeaf, target.textContent?.trim() ?? "");
  }

  private scheduleFileRename(leaf: WorkspaceLeaf, newTitle: string) {
    const currentPath = this.getFilePath(leaf);
    if (!currentPath || !newTitle) return;

    if (this.titleRenameTimer) {
      window.clearTimeout(this.titleRenameTimer);
    }

    this.titleRenameTimer = window.setTimeout(async () => {
      await this.renameFile(currentPath, newTitle);
    }, CONFIG.TITLE_RENAME_DEBOUNCE_MS);
  }

  private async renameFile(currentPath: string, newTitle: string) {
    const file = this.app.vault.getAbstractFileByPath(currentPath);
    if (!(file instanceof TFile)) return;

    const folder = file.parent?.path ?? "";
    const newPath = folder ? `${folder}/${newTitle}.md` : `${newTitle}.md`;

    if (newPath === currentPath) return;

    try {
      log(`Renaming: ${currentPath} → ${newPath}`);
      await this.app.fileManager.renameFile(file, newPath);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log(`Rename failed: ${message}`);
      new Notice(`파일명 변경 실패: ${message}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 스타일 관리
  // ─────────────────────────────────────────────────────────────────────────

  private updateTabStyle(leaf: WorkspaceLeaf) {
    const tabHeaderEl = (leaf as unknown as InternalLeaf).tabHeaderEl;
    if (!tabHeaderEl) return;

    if (this.previewLeaves.has(leaf)) {
      tabHeaderEl.classList.add(CONFIG.CSS_CLASSES.PREVIEW_TAB);
    } else {
      tabHeaderEl.classList.remove(CONFIG.CSS_CLASSES.PREVIEW_TAB);
    }
  }

  private removeAllPreviewStyles() {
    this.app.workspace.iterateAllLeaves((leaf) => {
      const tabHeaderEl = (leaf as unknown as InternalLeaf).tabHeaderEl;
      tabHeaderEl?.classList.remove(CONFIG.CSS_CLASSES.PREVIEW_TAB);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 파일 탐색기 정리
  // ─────────────────────────────────────────────────────────────────────────

  private clearFileExplorerSelection(path: string) {
    const explorerView = this.getFileExplorerView();
    const fileExplorer = document.querySelector(".nav-files-container");

    // Obsidian 내부 상태 정리
    if (explorerView?.activeDom?.file?.path === path) {
      log("Clearing explorer activeDom:", path);
      explorerView.activeDom = null;
    }

    // DOM 상태 정리
    if (fileExplorer) {
      const fileItem = fileExplorer.querySelector(`[data-path="${path}"]`);
      if (fileItem) {
        fileItem.classList.remove(CONFIG.CSS_CLASSES.ACTIVE);
        fileItem.classList.remove(CONFIG.CSS_CLASSES.HAS_FOCUS);
      }
    }
  }

  private getFileExplorerView(): FileExplorerView | null {
    let view: FileExplorerView | null = null;

    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view?.getViewType() === "file-explorer") {
        view = leaf.view as unknown as FileExplorerView;
      }
    });

    return view;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 유틸리티
  // ─────────────────────────────────────────────────────────────────────────

  private getFilePath(leaf: WorkspaceLeaf): string | null {
    const view = leaf.view;
    if (view instanceof FileView && view.file) {
      return view.file.path;
    }
    return null;
  }

  private getLeafDebugId(leaf: WorkspaceLeaf): string {
    return (leaf as unknown as InternalLeaf).id ?? "unknown";
  }

  /** activeLeaf의 대체 (deprecated 회피) */
  private getActiveLeaf(): WorkspaceLeaf | null {
    return this.app.workspace.getMostRecentLeaf();
  }

  private isFileElement(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return !!target.closest("[data-path]");
  }

  private findLeafByContentEl(contentEl: HTMLElement): WorkspaceLeaf | null {
    let found: WorkspaceLeaf | null = null;

    this.app.workspace.iterateAllLeaves((leaf) => {
      if ((leaf as any).containerEl?.contains(contentEl)) {
        found = leaf;
      }
    });

    return found;
  }

  private markAsProcessed(leaf: WorkspaceLeaf) {
    this.processedByOpenFile.add(leaf);
  }

  private wasProcessed(leaf: WorkspaceLeaf): boolean {
    return this.processedByOpenFile.has(leaf);
  }

  private clearProcessed(leaf: WorkspaceLeaf) {
    this.processedByOpenFile.delete(leaf);
  }

  private consumeCtrlClickFlag(): boolean {
    if (this.isCtrlClickPending) {
      this.isCtrlClickPending = false;
      return true;
    }
    return false;
  }
}
