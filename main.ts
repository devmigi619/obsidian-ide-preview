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

  /** 리본 버튼 더블클릭 시 기대하는 뷰 타입 (null이면 비활성) */
  private ribbonDoubleClickExpectedViewType: string | null = null;

  /** 그래프 뷰 드래그 감지용 */
  private graphDragStartPos: { x: number; y: number } | null = null;

  /** 새로 생성된 파일들 (제목편집모드 통일용) */
  private newlyCreatedFiles = new Set<string>();

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
    this.patchSetPinned();
    this.patchVaultCreate();
  }

  private registerEventHandlers() {
    this.registerFileOpenHandler();
    this.registerClickHandlers();
    this.registerPromotionTriggers();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 디버깅: File Explorer 상태 출력
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * File Explorer의 내부 상태와 DOM 상태를 상세히 출력
   */
  private debugFileExplorerState(context: string) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`${CONFIG.LOG_PREFIX} DEBUG: ${context}`);
    console.log(`${"=".repeat(60)}`);

    // 1. File Explorer View 가져오기
    const explorerLeaves = this.app.workspace.getLeavesOfType("file-explorer");
    const explorerView = explorerLeaves[0]?.view as any;

    console.log("1. File Explorer View 존재:", !!explorerView);

    if (explorerView) {
      // 2. activeDom 상태
      const activeDom = explorerView.activeDom;
      console.log("2. activeDom:", activeDom);
      console.log("   activeDom.file:", activeDom?.file);
      console.log("   activeDom.file?.path:", activeDom?.file?.path);
      console.log("   activeDom.el:", activeDom?.el);
      console.log("   activeDom.selfEl:", activeDom?.selfEl);

      // 3. focusedItem 상태 (있다면)
      const focusedItem = explorerView.focusedItem;
      console.log("3. focusedItem:", focusedItem);
      console.log("   focusedItem?.file?.path:", focusedItem?.file?.path);
    }

    // 4. DOM 상태: is-active 클래스가 있는 요소들
    const activeItems = document.querySelectorAll(".nav-file-title.is-active, .tree-item-self.is-active");
    console.log("4. DOM에서 is-active 클래스 개수:", activeItems.length);
    activeItems.forEach((item, idx) => {
      const path = item.getAttribute("data-path") || item.closest("[data-path]")?.getAttribute("data-path");
      console.log(`   [${idx}] path: ${path}`);
      console.log(`   [${idx}] classList:`, Array.from(item.classList));
    });

    // 5. DOM 상태: has-focus 클래스가 있는 요소들
    const focusedItems = document.querySelectorAll(".nav-file-title.has-focus, .tree-item-self.has-focus");
    console.log("5. DOM에서 has-focus 클래스 개수:", focusedItems.length);
    focusedItems.forEach((item, idx) => {
      const path = item.getAttribute("data-path") || item.closest("[data-path]")?.getAttribute("data-path");
      console.log(`   [${idx}] path: ${path}`);
      console.log(`   [${idx}] classList:`, Array.from(item.classList));
    });

    // 6. 현재 열린 탭 정보
    const activeLeaf = this.getActiveLeaf();
    console.log("6. 현재 활성 Leaf:", activeLeaf ? this.getLeafDebugId(activeLeaf) : "null");
    console.log("   viewType:", activeLeaf?.view?.getViewType());
    console.log("   filePath:", activeLeaf ? this.getFilePath(activeLeaf) : "null");
    console.log("   isPreview:", activeLeaf ? this.previewLeaves.has(activeLeaf) : false);

    // 7. 모든 열린 탭 목록
    console.log("7. 열린 모든 탭:");
    let tabIndex = 0;
    this.app.workspace.iterateAllLeaves((leaf) => {
      const location = this.getLeafLocation(leaf);
      if (location === "main") {
        const filePath = this.getFilePath(leaf);
        const viewType = leaf.view?.getViewType();
        const isPreview = this.previewLeaves.has(leaf);
        console.log(`   [${tabIndex}] id: ${this.getLeafDebugId(leaf)}, type: ${viewType}, path: ${filePath}, preview: ${isPreview}`);
        tabIndex++;
      }
    });

    console.log(`${"=".repeat(60)}\n`);
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
   * 같은 탭 그룹 내에서 특정 뷰 타입이 열린 탭 찾기
   */
  private findLeafWithViewType(
    viewType: string,
    inSameGroupAs: WorkspaceLeaf
  ): WorkspaceLeaf | null {
    const siblings = this.getSiblingLeaves(inSameGroupAs);

    for (const sibling of siblings) {
      if (sibling.view?.getViewType() === viewType) {
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

  private isFileOpenInAnyLeaf(
    filePath: string,
    excludeLeaf?: WorkspaceLeaf
  ): boolean {
    let found = false;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (found) return;
      if (excludeLeaf && leaf === excludeLeaf) return;
      if (this.getFilePath(leaf) === filePath) {
        found = true;
      }
    });
    return found;
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
    // ★ 디버그: openFile 진입
    console.log(`\n${"-".repeat(40)}`);
    console.log(`${CONFIG.LOG_PREFIX} handleOpenFile 진입`);
    console.log(`  file.path: ${file.path}`);
    console.log(`  leaf.id: ${this.getLeafDebugId(leaf)}`);
    this.debugFileExplorerState("handleOpenFile 진입 시점");

    // 새로 생성된 파일인 경우 → 제목편집모드 강제 적용
    if (this.newlyCreatedFiles.has(file.path)) {
      this.newlyCreatedFiles.delete(file.path);
      openState = openState || {};
      openState.eState = openState.eState || {};
      openState.eState.rename = "all";
    }

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
        const result = await this.openInNewTab(leaf, file, openState, true, originalMethod);
        // ★ 디버그: openInNewTab (permanent) 완료 후
        this.debugFileExplorerState("openInNewTab (permanent) 완료 후");
        return result;
      }
      // Empty 탭: 현재 탭에서 Permanent로 열기
      this.markAsProcessed(leaf);
      const result = await originalMethod.call(leaf, file, openState);
      this.setAsPermanent(leaf);
      // ★ 디버그: Empty → Permanent 완료 후
      this.debugFileExplorerState("Empty → Permanent 완료 후");
      return result;
    }

    // Preview로 열어야 하는 경우: 기존 Preview 탭 재사용
    const existingPreview = this.findPreviewLeaf(leaf);
    if (existingPreview) {
      log("  → Reusing existing preview tab");
      this.markAsProcessed(existingPreview);
      const result = await originalMethod.call(existingPreview, file, openState);
      this.app.workspace.setActiveLeaf(existingPreview, { focus: true });
      // ★ 디버그: Preview 재사용 완료 후
      this.debugFileExplorerState("Preview 재사용 완료 후");
      return result;
    }

    // Preview가 없는 경우
    if (currentState === "permanent") {
      // Permanent 탭 보존: 새 Preview 탭 생성
      const result = await this.openInNewTab(leaf, file, openState, false, originalMethod);
      // ★ 디버그: openInNewTab (preview) 완료 후
      this.debugFileExplorerState("openInNewTab (preview) 완료 후");
      return result;
    }

    // Empty 또는 Preview 탭: 현재 탭에서 Preview로 열기
    this.markAsProcessed(leaf);
    const result = await originalMethod.call(leaf, file, openState);
    this.setAsPreview(leaf);
    // ★ 디버그: Empty/Preview → Preview 완료 후
    this.debugFileExplorerState("Empty/Preview → Preview 완료 후");
    return result;
  }

  private async openInNewTab(
    _fromLeaf: WorkspaceLeaf,
    file: TFile,
    openState: any,
    asPermanent: boolean,
    originalMethod: Function
  ) {
    // openState가 originalMethod에 의해 mutate될 수 있으므로 미리 저장
    const shouldApplyRename = openState?.eState?.rename === "all";

    const newLeaf = this.app.workspace.getLeaf("tab");
    this.markAsProcessed(newLeaf);
    const result = await originalMethod.call(newLeaf, file, openState);

    if (asPermanent) {
      this.setAsPermanent(newLeaf);
    } else {
      this.setAsPreview(newLeaf);
    }

    this.app.workspace.setActiveLeaf(newLeaf, { focus: true });

    // 저장해둔 값으로 판단 (originalMethod가 openState를 mutate하므로)
    if (shouldApplyRename) {
      this.applyRenameMode(newLeaf);
    }

    return result;
  }

  /**
   * 제목편집모드 수동 적용
   * - 새 탭에서 파일을 열 때 eState.rename이 무시되는 문제 해결
   */
  private applyRenameMode(leaf: WorkspaceLeaf) {
    const view = leaf.view as any;
    if (view?.setEphemeralState) {
      view.setEphemeralState({ rename: "all" });
    }
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
    const shouldBePermanent = this.consumeRibbonDoubleClickFlag(viewType);
    const leafId = this.getLeafDebugId(leaf);
    log(`setViewState: type=${viewType}, state=${currentState}, permanent=${shouldBePermanent}, leafId=${leafId}`);

    // 현재 탭이 이미 같은 뷰 타입이면 무시 (단, Permanent로 승격 요청 시 승격)
    if (leaf.view?.getViewType() === viewType) {
      if (shouldBePermanent && this.previewLeaves.has(leaf)) {
        log(`  → Same view type, promoting to permanent`);
        this.promoteToPermament(leaf);
      } else {
        log(`  → Same view type, skipping`);
      }
      return;
    }

    // 같은 뷰 타입이 이미 열려있으면 포커스만 이동 (단, Permanent로 승격 요청 시 승격)
    const existingLeaf = this.findLeafWithViewType(viewType, leaf);
    if (existingLeaf) {
      log(`  → Already open: ${viewType}, focusing existing tab`);
      if (shouldBePermanent && this.previewLeaves.has(existingLeaf)) {
        this.promoteToPermament(existingLeaf);
      }
      this.app.workspace.setActiveLeaf(existingLeaf, { focus: true });
      return;
    }

    // Permanent로 열어야 하는 경우
    if (shouldBePermanent) {
      if (currentState === "permanent" || currentState === "preview") {
        const newLeaf = this.app.workspace.getLeaf("tab");
        const result = await originalMethod.call(newLeaf, viewState, eState);
        this.setAsPermanent(newLeaf);
        this.app.workspace.setActiveLeaf(newLeaf, { focus: true });
        return result;
      }
      // Empty 탭: 현재 탭에서 Permanent로 열기
      const result = await originalMethod.call(leaf, viewState, eState);
      this.setAsPermanent(leaf);
      return result;
    }

    // 기존 Preview 탭 재사용
    const existingPreview = this.findPreviewLeaf(leaf);
    if (existingPreview) {
      const previewId = this.getLeafDebugId(existingPreview);
      log(`  → Reusing existing preview tab (leafId=${previewId})`);
      const result = await originalMethod.call(existingPreview, viewState, eState);
      // 뷰가 변경되어도 Preview 상태 유지 확인
      log(`  → After setViewState, isPreview=${this.previewLeaves.has(existingPreview)}`);
      this.app.workspace.setActiveLeaf(existingPreview, { focus: true });
      return result;
    }

    // Preview가 없는 경우
    if (currentState === "permanent") {
      const newLeaf = this.app.workspace.getLeaf("tab");
      const newLeafId = this.getLeafDebugId(newLeaf);
      log(`  → Creating new preview tab (leafId=${newLeafId})`);
      const result = await originalMethod.call(newLeaf, viewState, eState);
      this.setAsPreview(newLeaf);
      log(`  → After setAsPreview, isPreview=${this.previewLeaves.has(newLeaf)}`);
      this.app.workspace.setActiveLeaf(newLeaf, { focus: true });
      return result;
    }

    // Empty 또는 Preview 탭: 현재 탭에서 열기
    log(`  → Using current tab (leafId=${leafId})`);
    const result = await originalMethod.call(leaf, viewState, eState);
    this.setAsPreview(leaf);
    log(`  → After setAsPreview, isPreview=${this.previewLeaves.has(leaf)}`);
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
          const filePath = plugin.getFilePath(this);
          const leafId = plugin.getLeafDebugId(this);

          // ★ 디버그: detach 진입
          console.log(`\n${"-".repeat(40)}`);
          console.log(`${CONFIG.LOG_PREFIX} detach 진입`);
          console.log(`  닫히는 탭 leaf.id: ${leafId}`);
          console.log(`  닫히는 탭 filePath: ${filePath}`);
          plugin.debugFileExplorerState("detach 진입 시점 (clearAllSidebarSelections 호출 전)");

          // 탭이 닫힐 때 사이드바 선택 상태 해제 (SPEC 7.5)
          plugin.clearAllSidebarSelections();

          // ★ 디버그: clearAllSidebarSelections 호출 후
          plugin.debugFileExplorerState("clearAllSidebarSelections 호출 후");

          const result = original.call(this);

          // ★ 디버그: original.call 완료 후
          plugin.debugFileExplorerState("original detach 완료 후");

          return result;
        };
      },
    });

    this.cleanupFunctions.push(uninstall);
    log("Patched detach");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // setPinned 패치 (탭 고정 시 승격)
  // ─────────────────────────────────────────────────────────────────────────

  private patchSetPinned() {
    const plugin = this;

    const uninstall = around(WorkspaceLeaf.prototype, {
      setPinned(original) {
        return function (this: WorkspaceLeaf, pinned: boolean) {
          // 탭 고정 시 Preview → Permanent 승격
          if (pinned && plugin.previewLeaves.has(this)) {
            log("Tab pinned → promote");
            plugin.promoteToPermament(this);
          }

          return original.call(this, pinned);
        };
      },
    });

    this.cleanupFunctions.push(uninstall);
    log("Patched setPinned");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // vault.create 패치 (새 파일 생성 감지)
  // ─────────────────────────────────────────────────────────────────────────

  private patchVaultCreate() {
    const plugin = this;
    const vault = this.app.vault;
    const originalCreate = vault.create.bind(vault);

    // vault.create 패치: 파일 생성 직전에 경로를 기록 (제목편집모드 통일용)
    vault.create = async function (path: string, data: string, options?: any) {
      plugin.newlyCreatedFiles.add(path);
      return originalCreate(path, data, options);
    };

    this.cleanupFunctions.push(() => {
      vault.create = originalCreate;
    });

    log("Patched vault.create");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 이벤트 핸들러
  // ─────────────────────────────────────────────────────────────────────────

  private registerFileOpenHandler() {
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        // ★ 디버그: file-open 이벤트
        console.log(`\n${"-".repeat(40)}`);
        console.log(`${CONFIG.LOG_PREFIX} file-open 이벤트`);
        console.log(`  file: ${file?.path ?? "null"}`);
        this.debugFileExplorerState("file-open 이벤트 발생");

        if (!file) return;

        const activeLeaf = this.getActiveLeaf();
        if (activeLeaf?.view?.getViewType() === "markdown") {
          this.lastActiveLeaf = activeLeaf;
        }

        // 파일 탐색기 선택 상태는 Obsidian이 자동으로 처리
        // 수동으로 설정하면 Obsidian 내부 상태와 충돌함
      })
    );

    // 리본 더블클릭 후 뷰가 활성화될 때 승격 처리
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (!this.ribbonDoubleClickExpectedViewType || !leaf) {
          return;
        }

        const viewType = leaf.view?.getViewType();
        const expectedType = this.ribbonDoubleClickExpectedViewType;

        // 기대한 뷰 타입과 일치하고 Preview면 승격
        if (viewType === expectedType && this.previewLeaves.has(leaf)) {
          log(`Active leaf change → promoting expected ${viewType} view`);
          this.promoteToPermament(leaf);
        }

        // 어떤 경우든 기대값 초기화 (다음 이벤트에 영향 안 주도록)
        this.ribbonDoubleClickExpectedViewType = null;
      })
    );
  }

  private registerClickHandlers() {
    // 싱글 클릭 감지 (디버깅용)
    this.registerDomEvent(document, "click", (evt: MouseEvent) => {
      const target = evt.target as HTMLElement;
      const fileEl = target.closest("[data-path]") as HTMLElement | null;

      if (fileEl) {
        const path = fileEl.getAttribute("data-path");
        // ★ 디버그: 파일 요소 클릭
        console.log(`\n${"-".repeat(40)}`);
        console.log(`${CONFIG.LOG_PREFIX} 파일 요소 클릭`);
        console.log(`  클릭된 파일 path: ${path}`);
        console.log(`  Ctrl/Meta 키: ${evt.ctrlKey || evt.metaKey}`);
        this.debugFileExplorerState("파일 요소 클릭 시점");
      }

      // Ctrl+Click 감지
      if ((evt.ctrlKey || evt.metaKey) && this.isFileElement(evt.target)) {
        this.isCtrlClickPending = true;
      }
    }, true);

    // 더블클릭 처리
    this.registerDomEvent(document, "dblclick", (evt: MouseEvent) => {
      const target = evt.target as HTMLElement;
      const fileEl = target.closest("[data-path]") as HTMLElement | null;

      if (fileEl) {
        const path = fileEl.getAttribute("data-path");
        // ★ 디버그: 파일 요소 더블클릭
        console.log(`\n${"-".repeat(40)}`);
        console.log(`${CONFIG.LOG_PREFIX} 파일 요소 더블클릭`);
        console.log(`  더블클릭된 파일 path: ${path}`);
        this.debugFileExplorerState("파일 요소 더블클릭 시점");
      }

      this.handleDoubleClick(evt);
    }, true);

    // 그래프 뷰 드래그 감지
    this.registerDomEvent(document, "mousedown", (evt: MouseEvent) => {
      const target = evt.target as HTMLElement;
      const activeLeaf = this.getActiveLeaf();
      const viewType = activeLeaf?.view?.getViewType();

      // 디버깅: 그래프 뷰에서 마우스다운 시 정보 출력
      if (viewType === "graph") {
        const leafId = activeLeaf ? this.getLeafDebugId(activeLeaf) : "null";
        console.log("[IDE Preview] mousedown debug:");
        console.log("  leafId:", leafId);
        console.log("  target.tagName:", target.tagName);
        console.log("  activeLeaf viewType:", viewType);
        console.log("  isPreview:", activeLeaf ? this.previewLeaves.has(activeLeaf) : false);
      }

      // 그래프 뷰가 활성화된 상태에서 마우스다운
      if (viewType === "graph") {
        this.graphDragStartPos = { x: evt.clientX, y: evt.clientY };
        console.log("[IDE Preview] graphDragStartPos set:", this.graphDragStartPos);
      }
    }, true);

    this.registerDomEvent(document, "mouseup", (evt: MouseEvent) => {
      if (!this.graphDragStartPos) return;

      const activeLeaf = this.getActiveLeaf();
      const viewType = activeLeaf?.view?.getViewType();

      const leafId = activeLeaf ? this.getLeafDebugId(activeLeaf) : "null";
      console.log("[IDE Preview] mouseup debug:");
      console.log("  leafId:", leafId);
      console.log("  viewType:", viewType);

      if (viewType === "graph") {
        const dx = evt.clientX - this.graphDragStartPos.x;
        const dy = evt.clientY - this.graphDragStartPos.y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        console.log("  drag distance:", distance);
        console.log("  isPreview:", activeLeaf ? this.previewLeaves.has(activeLeaf) : false);

        // 최소 드래그 거리 (10px) 이상 이동했으면 조작으로 판단
        if (distance > 10) {
          if (activeLeaf && this.previewLeaves.has(activeLeaf)) {
            log("Graph drag detected → promote");
            this.promoteToPermament(activeLeaf);
          }
        }
      }

      this.graphDragStartPos = null;
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
        // Preview면 승격
        if (this.lastActiveLeaf && this.previewLeaves.has(this.lastActiveLeaf)) {
          log("Sidebar double-click → promote");
          this.promoteToPermament(this.lastActiveLeaf);
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
      return;
    }

    // 리본 버튼 더블클릭 → 다음 뷰를 Permanent로
    const ribbonButton = target.closest(".side-dock-ribbon-action");
    if (ribbonButton) {
      const ariaLabel = ribbonButton.getAttribute("aria-label") ?? "";
      const activeLeaf = this.getActiveLeaf();
      const activeViewType = activeLeaf?.view?.getViewType();

      log("Ribbon button double-click");
      log(`  aria-label: "${ariaLabel}"`);
      log(`  activeLeaf viewType: ${activeViewType}`);
      log(`  isPreview: ${activeLeaf ? this.previewLeaves.has(activeLeaf) : false}`);

      // 현재 활성 탭이 Preview면 즉시 승격 (aria-label 무관하게)
      if (activeLeaf && this.previewLeaves.has(activeLeaf)) {
        log(`  → Promoting active preview tab`);
        this.promoteToPermament(activeLeaf);
        return;
      }

      // 뷰가 아직 열리지 않은 경우, active-leaf-change에서 처리하도록 설정
      // aria-label에서 뷰 타입 추출
      const ariaLower = ariaLabel.toLowerCase();
      let viewType: string | null = null;

      if (ariaLower.includes("graph") || ariaLabel.includes("그래프")) {
        viewType = "graph";
      } else if (ariaLower.includes("canvas") || ariaLabel.includes("캔버스")) {
        viewType = "canvas";
      }

      if (viewType) {
        const activeLeaf = this.getActiveLeaf();
        if (activeLeaf?.view?.getViewType() === viewType && this.previewLeaves.has(activeLeaf)) {
          log(`  → Promoting existing ${viewType} view`);
          this.promoteToPermament(activeLeaf);
          return;
        }
      }

      // 뷰가 아직 열리지 않은 경우, active-leaf-change에서 처리하도록 설정
      if (viewType) {
        this.ribbonDoubleClickExpectedViewType = viewType;
        log(`  → Expecting ${viewType} view on next active-leaf-change`);
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
  // 사이드바 선택 상태 정리
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * 사이드바의 모든 파일 선택 상태 해제 (SPEC 7.5)
   * - 탭이 닫힐 때 호출
   * - DOM 클래스만 제거
   */
  private clearAllSidebarSelections() {
    log("=== clearAllSidebarSelections ===");

    // ★ 디버그: 현재 File Explorer의 activeDom 상태
    const explorerLeaves = this.app.workspace.getLeavesOfType("file-explorer");
    const explorerView = explorerLeaves[0]?.view as any;

    if (explorerView) {
      console.log("  clearAllSidebarSelections 내부:");
      console.log("    explorerView.activeDom:", explorerView.activeDom);
      console.log("    explorerView.activeDom?.file?.path:", explorerView.activeDom?.file?.path);
    }

    // 사이드바 영역 내의 모든 선택 상태 DOM 클래스 제거
    const sidebars = document.querySelectorAll(
      ".workspace-split.mod-left-split, .workspace-split.mod-right-split"
    );

    sidebars.forEach((sidebar) => {
      const activeItems = sidebar.querySelectorAll(
        ".tree-item-self.is-active, .tree-item-self.has-focus"
      );
      console.log(`    sidebar에서 찾은 active/focus 요소 수: ${activeItems.length}`);
      activeItems.forEach((item) => {
        const path = item.closest("[data-path]")?.getAttribute("data-path");
        console.log(`      제거 대상: ${path}`);
        item.classList.remove("is-active");
        item.classList.remove("has-focus");
      });
    });
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

  private consumeRibbonDoubleClickFlag(viewType: string): boolean {
    if (this.ribbonDoubleClickExpectedViewType === viewType) {
      this.ribbonDoubleClickExpectedViewType = null;
      return true;
    }
    return false;
  }
}