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
// Type Definitions / 타입 정의
// ═══════════════════════════════════════════════════════════════════════════

/** Tab state / 탭 상태 */
type TabState = "empty" | "preview" | "permanent";

/** Leaf location / 탭 위치 */
type LeafLocation = "sidebar" | "main";

/** File open intent / 파일 열기 의도 */
type OpenIntent = "browse" | "create";

/** Original openFile method signature / openFile 원본 메서드 시그니처 */
type OpenFileFn = (file: TFile, openState?: any) => Promise<void>;

/** Original setViewState method signature / setViewState 원본 메서드 시그니처 */
type SetViewStateFn = (viewState: any, eState?: any) => Promise<void>;

/** Internal Leaf properties (not exposed by Obsidian) / Obsidian이 노출하지 않는 Leaf 내부 속성 */
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

/**
 * File explorer view internal structure / 파일 탐색기 뷰 내부 구조
 * Note: explorerView.activeDom and tree.activeDom are separate objects synced by onFileOpen
 * 참고: explorerView.activeDom과 tree.activeDom은 별개 객체이며 onFileOpen이 동기화함
 */
interface ExplorerView {
  activeDom: { file?: TFile; selfEl?: HTMLElement } | null;
  tree?: {
    activeDom: any;
    focusedItem: any;
    setFocusedItem?: (item: any) => void;
  };
  containerEl?: HTMLElement;
  onFileOpen?: (file: TFile | null) => void;
}

// ═══════════════════════════════════════════════════════════════════════════
// Constants / 상수
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG = {
  /** Debounce delay for inline title rename / 인라인 제목 변경 시 파일명 반영 대기 시간 */
  TITLE_RENAME_DEBOUNCE_MS: 300,

  /** Min pixel distance to distinguish drag from click in graph view / 그래프뷰에서 드래그와 클릭을 구분하는 최소 px 거리 */
  GRAPH_DRAG_THRESHOLD: 10,

  VIEW_TYPES: {
    EMPTY: "empty",
    MARKDOWN: "markdown",
    CANVAS: "canvas",
    PDF: "pdf",
    GRAPH: "graph",
    FILE_EXPLORER: "file-explorer",
  },

  CSS_CLASSES: {
    PREVIEW_TAB: "is-preview-tab",
  },

  CSS_SELECTORS: {
    TAB_HEADER: ".workspace-tab-header",
    LEAF_CONTENT: ".workspace-leaf-content",
    GRAPH_CONTAINER: ".graph-view-container",
    RIBBON_ACTION: ".side-dock-ribbon-action",
    INLINE_TITLE: ".inline-title",
    STALE_ACTIVE: ".tree-item-self.is-active",
    STALE_FOCUS: ".tree-item-self.has-focus",
  },

  LOG_PREFIX: "[IDE Preview]",
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// Utility / 유틸리티
// ═══════════════════════════════════════════════════════════════════════════

function log(message: string, ...args: unknown[]) {
  console.log(`${CONFIG.LOG_PREFIX} ${message}`, ...args);
}

// ═══════════════════════════════════════════════════════════════════════════
// Main Plugin / 메인 플러그인
// ═══════════════════════════════════════════════════════════════════════════

/**
 * IDE Style Preview Plugin
 *
 * Implements VS Code-style preview tab behavior in Obsidian.
 * Obsidian에 VS Code 스타일의 Preview 탭 동작을 구현합니다.
 *
 * - Browse (single click): Preview tab (italic, reusable) / 탐색(싱글클릭): Preview 탭 (이탤릭, 재사용)
 * - Commit (double click/edit): Permanent tab / 확정(더블클릭/편집): Permanent 탭
 */
export default class IDEStylePreviewPlugin extends Plugin {
  // ─────────────────────────────────────────────────────────────────────────
  // State / 상태
  // ─────────────────────────────────────────────────────────────────────────

  /** Leaves currently in preview state / Preview 상태인 탭들 */
  private previewLeaves = new WeakSet<WorkspaceLeaf>();

  /** Leaves already handled by openFile (prevents setViewState double-processing) */
  /** openFile에서 이미 처리한 탭 (setViewState 중복 방지) */
  private processedByOpenFile = new WeakSet<WorkspaceLeaf>();

  /** Ctrl/Cmd+Click detection flag / Ctrl+Click 감지 플래그 */
  private isCtrlClickPending = false;

  /** Expected view type for ribbon double-click promotion (null = inactive) */
  /** 리본 버튼 더블클릭 시 기대하는 뷰 타입 (null이면 비활성) */
  private ribbonDoubleClickExpectedViewType: string | null = null;

  /** Graph view drag detection / 그래프 뷰 드래그 감지용 */
  private graphDragStartPos: { x: number; y: number } | null = null;

  /** Newly created files awaiting title-edit mode / 새로 생성된 파일들 (제목편집모드 통일용) */
  private newlyCreatedFiles = new Set<string>();

  /** Most recently opened leaf (for double-click promotion in sidebar/graph) */
  /** 가장 최근에 열린 leaf (사이드바/그래프 더블클릭 승격 시 사용) */
  private lastActiveLeaf: WorkspaceLeaf | null = null;

  /** Inline title rename debounce timer / 제목 변경 debounce 타이머 */
  private titleRenameTimer: number | null = null;

  /** Patch cleanup functions / 패치 해제 함수들 */
  private cleanupFunctions: (() => void)[] = [];

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle / 라이프사이클
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

  // ─────────────────────────────────────────────────────────────────────────
  // Patch Installation / 패치 설치
  // ─────────────────────────────────────────────────────────────────────────

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
  // Tab State Management / 탭 상태 관리
  // ─────────────────────────────────────────────────────────────────────────

  private getTabState(leaf: WorkspaceLeaf): TabState {
    if (leaf.view?.getViewType() === CONFIG.VIEW_TYPES.EMPTY) return "empty";
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

  private promoteToPermanent(leaf: WorkspaceLeaf) {
    if (!this.previewLeaves.has(leaf)) return;
    this.setAsPermanent(leaf);
    log("Promoted to permanent:", this.getLeafId(leaf));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Location / 위치 판단
  // ─────────────────────────────────────────────────────────────────────────

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
  // Intent Detection / 의도 판별
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Determine file open intent: browse (view) or create (new file).
   * 파일 열기 의도 판별: 탐색(조회) 또는 생성(새 파일).
   */
  private determineOpenIntent(file: TFile, openState?: any): OpenIntent {
    // rename="all" → newly created file / rename="all" → 새로 생성된 파일
    if (openState?.eState?.rename === "all") {
      return "create";
    }

    // Canvas/PDF always browse (creation handled by vault.create patch)
    // Canvas/PDF는 항상 탐색 (생성은 vault.create 패치에서 처리)
    if (file.extension === CONFIG.VIEW_TYPES.CANVAS || file.extension === CONFIG.VIEW_TYPES.PDF) {
      return "browse";
    }

    // Daily Notes → always create (even when reopening existing ones)
    // Daily Notes → 항상 생성 (이미 존재하는 파일을 다시 열 때도)
    if (openState?.state?.mode === "source") {
      if (this.isDailyNote(file)) {
        return "create";
      }
    }

    return "browse";
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Leaf Search / Leaf 탐색
  // ─────────────────────────────────────────────────────────────────────────

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

  private findPreviewLeaf(inSameGroupAs: WorkspaceLeaf): WorkspaceLeaf | null {
    const siblings = this.getSiblingLeaves(inSameGroupAs);

    for (const sibling of siblings) {
      if (this.previewLeaves.has(sibling)) {
        return sibling;
      }
    }
    return null;
  }

  private getSiblingLeaves(leaf: WorkspaceLeaf): WorkspaceLeaf[] {
    const internal = leaf as InternalLeaf;
    const children = internal.parent?.children;

    if (!children) return [];
    return children.filter((child) => child !== leaf);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // openFile Patch / openFile 패치
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
          return plugin.handleOpenFile(this, file, openState, original as unknown as OpenFileFn);
        };
      },
    });

    this.cleanupFunctions.push(uninstall);
    log("Patched openFile");
  }

  /**
   * Core open-file handler. Decides Preview vs Permanent based on intent.
   * 핵심 파일 열기 핸들러. 의도에 따라 Preview/Permanent를 결정합니다.
   *
   * Flow / 흐름:
   * 1. Apply rename mode for newly created files / 새 파일에 제목편집모드 적용
   * 2. Skip if same file already open / 같은 파일이면 무시
   * 3. Focus existing tab if duplicate / 중복 시 기존 탭 포커스
   * 4. Permanent: create/ctrl-click → new tab / Permanent: 생성/Ctrl클릭 → 새 탭
   * 5. Preview: reuse existing preview tab / Preview: 기존 Preview 탭 재사용
   * 6. Fallback: use current tab / 폴백: 현재 탭 사용
   */
  private async handleOpenFile(
    leaf: WorkspaceLeaf,
    file: TFile,
    openState: any,
    originalMethod: OpenFileFn
  ) {
    // [1] Newly created files → force title-edit mode (except Daily Notes)
    // 새로 생성된 파일 → 제목편집모드 강제 적용 (Daily Notes 제외)
    if (this.newlyCreatedFiles.has(file.path)) {
      this.newlyCreatedFiles.delete(file.path);
      if (!this.isDailyNote(file)) {
        openState = openState || {};
        openState.eState = openState.eState || {};
        openState.eState.rename = "all";
      }
    }

    const currentState = this.getTabState(leaf);
    const intent = this.determineOpenIntent(file, openState);
    const isCtrlClick = this.consumeCtrlClickFlag();
    const shouldBePermanent = intent === "create" || isCtrlClick;

    // [2] Same file already open → skip
    if (this.getFilePath(leaf) === file.path) {
      return;
    }

    // [3] Duplicate prevention: focus existing tab in same panel
    // 중복 방지: 같은 패널 내 기존 탭으로 포커스 이동
    const existingLeaf = this.findLeafWithFile(file.path, leaf);
    if (existingLeaf && !isCtrlClick) {
      this.app.workspace.setActiveLeaf(existingLeaf, { focus: true });
      return;
    }

    // [4] Permanent intent → open in new tab (preserving existing tabs)
    if (shouldBePermanent) {
      if (currentState === "permanent" || currentState === "preview") {
        return await this.openInNewTab(file, openState, true, originalMethod);
      }
      this.markAsProcessed(leaf);
      const result = await originalMethod.call(leaf, file, openState);
      this.setAsPermanent(leaf);
      return result;
    }

    // [5] Browse intent: reuse existing preview tab if available
    // 탐색 의도: 기존 Preview 탭이 있으면 재사용
    const existingPreview = this.findPreviewLeaf(leaf);
    if (existingPreview) {
      this.markAsProcessed(existingPreview);
      const result = await originalMethod.call(existingPreview, file, openState);
      this.app.workspace.setActiveLeaf(existingPreview, { focus: true });
      return result;
    }

    // [5b] No preview, current is Permanent → create new preview tab
    if (currentState === "permanent") {
      return await this.openInNewTab(file, openState, false, originalMethod);
    }

    // [6] Empty or Preview tab → open as Preview in current tab
    this.markAsProcessed(leaf);
    const result = await originalMethod.call(leaf, file, openState);
    this.setAsPreview(leaf);
    this.ensureExplorerActiveState(file);
    return result;
  }

  private async openInNewTab(
    file: TFile,
    openState: any,
    asPermanent: boolean,
    originalMethod: OpenFileFn
  ) {
    // Save before originalMethod call (openState.eState may mutate)
    // originalMethod 호출 전 저장 (openState.eState가 변이될 수 있음)
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

    if (shouldApplyRename) {
      this.applyRenameMode(newLeaf);
    }

    return result;
  }

  private applyRenameMode(leaf: WorkspaceLeaf) {
    const view = leaf.view as any;
    if (view?.setEphemeralState) {
      view.setEphemeralState({ rename: "all" });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // setViewState Patch (non-file views) / setViewState 패치 (비파일 뷰 처리)
  // ─────────────────────────────────────────────────────────────────────────

  private patchSetViewState() {
    const plugin = this;

    const uninstall = around(WorkspaceLeaf.prototype, {
      setViewState(original) {
        return async function (this: WorkspaceLeaf, viewState: any, eState?: any) {
          return plugin.handleSetViewState(this, viewState, eState, original as unknown as SetViewStateFn);
        };
      },
    });

    this.cleanupFunctions.push(uninstall);
    log("Patched setViewState");
  }

  /**
   * Handle non-file views (Graph, Canvas, etc.) with same Preview/Permanent logic.
   * 비파일 뷰(Graph, Canvas 등)를 동일한 Preview/Permanent 로직으로 처리합니다.
   *
   * processedByOpenFile flag: when openFile already handled this leaf,
   * skip our logic and pass through to original setViewState.
   * processedByOpenFile 플래그: openFile에서 이미 처리한 경우 원본 setViewState로 통과.
   */
  private async handleSetViewState(
    leaf: WorkspaceLeaf,
    viewState: any,
    eState: any,
    originalMethod: SetViewStateFn
  ) {
    if (this.wasProcessed(leaf)) {
      this.clearProcessed(leaf);
      return originalMethod.call(leaf, viewState, eState);
    }

    const viewType = viewState?.type;

    // Markdown and empty views are handled by openFile patch
    if (viewType === CONFIG.VIEW_TYPES.MARKDOWN || viewType === CONFIG.VIEW_TYPES.EMPTY) {
      return originalMethod.call(leaf, viewState, eState);
    }

    // Sidebar views don't need Preview/Permanent logic
    if (this.isInSidebar(leaf)) {
      return originalMethod.call(leaf, viewState, eState);
    }

    const currentState = this.getTabState(leaf);
    const shouldBePermanent = this.consumeRibbonDoubleClickFlag(viewType);

    // Same view type already open → promote if needed, skip opening
    if (leaf.view?.getViewType() === viewType) {
      if (shouldBePermanent && this.previewLeaves.has(leaf)) {
        this.promoteToPermanent(leaf);
      }
      return;
    }

    // Duplicate: same view type in sibling tabs → focus existing
    const existingLeaf = this.findLeafWithViewType(viewType, leaf);
    if (existingLeaf) {
      if (shouldBePermanent && this.previewLeaves.has(existingLeaf)) {
        this.promoteToPermanent(existingLeaf);
      }
      this.app.workspace.setActiveLeaf(existingLeaf, { focus: true });
      return;
    }

    // Permanent intent
    if (shouldBePermanent) {
      if (currentState === "permanent" || currentState === "preview") {
        const newLeaf = this.app.workspace.getLeaf("tab");
        const result = await originalMethod.call(newLeaf, viewState, eState);
        this.setAsPermanent(newLeaf);
        this.app.workspace.setActiveLeaf(newLeaf, { focus: true });
        return result;
      }
      const result = await originalMethod.call(leaf, viewState, eState);
      this.setAsPermanent(leaf);
      return result;
    }

    // Browse: reuse existing preview
    const existingPreview = this.findPreviewLeaf(leaf);
    if (existingPreview) {
      const result = await originalMethod.call(existingPreview, viewState, eState);
      this.app.workspace.setActiveLeaf(existingPreview, { focus: true });
      return result;
    }

    // Browse: Permanent → new preview tab
    if (currentState === "permanent") {
      const newLeaf = this.app.workspace.getLeaf("tab");
      const result = await originalMethod.call(newLeaf, viewState, eState);
      this.setAsPreview(newLeaf);
      this.app.workspace.setActiveLeaf(newLeaf, { focus: true });
      return result;
    }

    // Browse: use current tab as preview
    const result = await originalMethod.call(leaf, viewState, eState);
    this.setAsPreview(leaf);
    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // detach Patch (tab close cleanup) / detach 패치 (탭 닫힘 처리)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Two-phase sidebar cleanup on tab close:
   * 탭 닫힘 시 2단계 사이드바 정리:
   *
   * Phase 1 (before detach): Reset internal state via onFileOpen(null)
   *   detach 전: onFileOpen(null)로 내부 상태 리셋
   * Phase 2 (after detach, async): Clean stale DOM classes
   *   detach 후(비동기): 잔류 DOM 클래스 정리
   */
  private patchDetach() {
    const plugin = this;

    const uninstall = around(WorkspaceLeaf.prototype, {
      detach(original) {
        return function (this: WorkspaceLeaf) {
          plugin.clearSidebarInternalState();
          const result = original.call(this);
          setTimeout(() => plugin.cleanStaleSidebarDOM(), 0);
          return result;
        };
      },
    });

    this.cleanupFunctions.push(uninstall);
    log("Patched detach");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // setPinned Patch (pin → promote) / setPinned 패치 (탭 고정 시 승격)
  // ─────────────────────────────────────────────────────────────────────────

  private patchSetPinned() {
    const plugin = this;

    const uninstall = around(WorkspaceLeaf.prototype, {
      setPinned(original) {
        return function (this: WorkspaceLeaf, pinned: boolean) {
          if (pinned && plugin.previewLeaves.has(this)) {
            plugin.promoteToPermanent(this);
          }
          return original.call(this, pinned);
        };
      },
    });

    this.cleanupFunctions.push(uninstall);
    log("Patched setPinned");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // vault.create Patch (new file detection) / vault.create 패치 (새 파일 생성 감지)
  // ─────────────────────────────────────────────────────────────────────────

  private patchVaultCreate() {
    const plugin = this;
    const vault = this.app.vault;
    const originalCreate = vault.create.bind(vault);

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
  // Event Handlers / 이벤트 핸들러
  // ─────────────────────────────────────────────────────────────────────────

  private registerFileOpenHandler() {
    // Track most recently opened file leaf for double-click promotion
    // 더블클릭 승격을 위해 가장 최근에 열린 파일 leaf를 추적
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (!file) return;

        const activeLeaf = this.getActiveLeaf();
        const viewType = activeLeaf?.view?.getViewType();
        if (
          viewType === CONFIG.VIEW_TYPES.MARKDOWN ||
          viewType === CONFIG.VIEW_TYPES.CANVAS ||
          viewType === CONFIG.VIEW_TYPES.PDF
        ) {
          this.lastActiveLeaf = activeLeaf;
        }
      })
    );

    // Handle ribbon double-click: promote preview after active-leaf-change
    // 리본 더블클릭 처리: active-leaf-change 후 Preview 승격
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (!this.ribbonDoubleClickExpectedViewType || !leaf) {
          return;
        }

        const viewType = leaf.view?.getViewType();
        const expectedType = this.ribbonDoubleClickExpectedViewType;

        if (viewType === expectedType && this.previewLeaves.has(leaf)) {
          this.promoteToPermanent(leaf);
        }

        this.ribbonDoubleClickExpectedViewType = null;
      })
    );
  }

  private registerClickHandlers() {
    // Ctrl+Click: set flag on mousedown capture phase
    // Obsidian opens files on mousedown, so we must set the flag before that
    // Ctrl+Click: mousedown 캡처 페이즈에서 플래그 설정
    // Obsidian은 mousedown에서 파일을 열므로 그 전에 플래그를 설정해야 함
    this.registerDomEvent(document, "mousedown", (evt: MouseEvent) => {
      if ((evt.ctrlKey || evt.metaKey) && this.isFileElement(evt.target)) {
        this.isCtrlClickPending = true;
      }
    }, true);

    // Double-click handler / 더블클릭 핸들러
    this.registerDomEvent(document, "dblclick", (evt: MouseEvent) => {
      this.handleDoubleClick(evt);
    }, true);

    // Graph view drag detection (for promotion on drag)
    // 그래프 뷰 드래그 감지 (드래그 시 승격)
    this.registerDomEvent(document, "mousedown", (evt: MouseEvent) => {
      const activeLeaf = this.getActiveLeaf();
      if (activeLeaf?.view?.getViewType() === CONFIG.VIEW_TYPES.GRAPH) {
        this.graphDragStartPos = { x: evt.clientX, y: evt.clientY };
      }
    }, true);

    this.registerDomEvent(document, "mouseup", (evt: MouseEvent) => {
      if (!this.graphDragStartPos) return;

      const activeLeaf = this.getActiveLeaf();
      if (activeLeaf?.view?.getViewType() === CONFIG.VIEW_TYPES.GRAPH) {
        const dx = evt.clientX - this.graphDragStartPos.x;
        const dy = evt.clientY - this.graphDragStartPos.y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance > CONFIG.GRAPH_DRAG_THRESHOLD && activeLeaf && this.previewLeaves.has(activeLeaf)) {
          this.promoteToPermanent(activeLeaf);
        }
      }

      this.graphDragStartPos = null;
    }, true);
  }

  /**
   * Handle double-click across different UI regions.
   * 다양한 UI 영역의 더블클릭을 처리합니다.
   *
   * Tab header: promotes activeLeaf directly / 탭 헤더: activeLeaf를 직접 승격
   * Sidebar/Graph: promotes lastActiveLeaf (set by file-open event)
   * 사이드바/그래프: lastActiveLeaf를 승격 (file-open 이벤트에서 설정됨)
   */
  private handleDoubleClick(evt: MouseEvent) {
    const target = evt.target as HTMLElement;

    // Tab header double-click / 탭 헤더 더블클릭
    if (target.closest(CONFIG.CSS_SELECTORS.TAB_HEADER)) {
      const activeLeaf = this.getActiveLeaf();
      if (activeLeaf && this.previewLeaves.has(activeLeaf)) {
        this.promoteToPermanent(activeLeaf);
      }
      return;
    }

    // Sidebar double-click / 사이드바 더블클릭
    const sidebarContent = target.closest(CONFIG.CSS_SELECTORS.LEAF_CONTENT);
    if (sidebarContent) {
      const leaf = this.findLeafByContentEl(sidebarContent as HTMLElement);
      if (leaf && this.isInSidebar(leaf)) {
        if (this.lastActiveLeaf && this.previewLeaves.has(this.lastActiveLeaf)) {
          this.promoteToPermanent(this.lastActiveLeaf);
        }
        return;
      }
    }

    // Graph view double-click / 그래프 뷰 더블클릭
    if (target.closest(CONFIG.CSS_SELECTORS.GRAPH_CONTAINER)) {
      if (this.lastActiveLeaf && this.previewLeaves.has(this.lastActiveLeaf)) {
        this.promoteToPermanent(this.lastActiveLeaf);
      }
      return;
    }

    // Ribbon button double-click / 리본 버튼 더블클릭
    const ribbonButton = target.closest(CONFIG.CSS_SELECTORS.RIBBON_ACTION);
    if (ribbonButton) {
      this.handleRibbonDoubleClick(ribbonButton as HTMLElement);
    }
  }

  /**
   * Ribbon double-click: promote current preview or set flag for pending view.
   * 리본 더블클릭: 현재 Preview를 승격하거나, 아직 열리지 않은 뷰를 위해 플래그 설정.
   */
  private handleRibbonDoubleClick(ribbonButton: HTMLElement) {
    const ariaLabel = ribbonButton.getAttribute("aria-label") ?? "";
    const activeLeaf = this.getActiveLeaf();

    // If current active leaf is preview, promote it immediately
    if (activeLeaf && this.previewLeaves.has(activeLeaf)) {
      this.promoteToPermanent(activeLeaf);
      return;
    }

    // Detect view type from aria-label (supports both EN and KR labels)
    // aria-label에서 뷰 타입 감지 (영문/한글 라벨 모두 지원)
    const ariaLower = ariaLabel.toLowerCase();
    let viewType: string | null = null;

    if (ariaLower.includes("graph") || ariaLabel.includes("그래프")) {
      viewType = CONFIG.VIEW_TYPES.GRAPH;
    } else if (ariaLower.includes("canvas") || ariaLabel.includes("캔버스")) {
      viewType = CONFIG.VIEW_TYPES.CANVAS;
    }

    if (viewType) {
      const currentActiveLeaf = this.getActiveLeaf();
      if (currentActiveLeaf?.view?.getViewType() === viewType && this.previewLeaves.has(currentActiveLeaf)) {
        this.promoteToPermanent(currentActiveLeaf);
        return;
      }
    }

    // View not yet open → set flag for active-leaf-change handler
    // 뷰가 아직 열리지 않음 → active-leaf-change 핸들러를 위해 플래그 설정
    if (viewType) {
      this.ribbonDoubleClickExpectedViewType = viewType;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Promotion Triggers / 승격 트리거
  // ─────────────────────────────────────────────────────────────────────────

  private registerPromotionTriggers() {
    // Editor content change → promote / 본문 편집 → 승격
    this.registerEvent(
      this.app.workspace.on("editor-change", (editor, info) => {
        const leaf = (info as any).leaf as WorkspaceLeaf | undefined;
        if (leaf && this.previewLeaves.has(leaf)) {
          this.promoteToPermanent(leaf);
        }
      })
    );

    // File rename → promote / 파일 이름 변경 → 승격
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        this.app.workspace.iterateAllLeaves((leaf) => {
          if (this.getFilePath(leaf) === file.path && this.previewLeaves.has(leaf)) {
            this.promoteToPermanent(leaf);
          }
        });
      })
    );

    // Canvas content modify → promote / Canvas 수정 → 승격
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!(file instanceof TFile)) return;
        if (file.extension !== CONFIG.VIEW_TYPES.CANVAS) return;

        this.app.workspace.iterateAllLeaves((leaf) => {
          if (this.getFilePath(leaf) === file.path && this.previewLeaves.has(leaf)) {
            this.promoteToPermanent(leaf);
          }
        });
      })
    );

    // Inline title edit → promote + debounced rename
    // 인라인 제목 편집 → 승격 + 디바운스된 이름 변경
    this.registerDomEvent(document, "input", (evt: Event) => {
      this.handleInlineTitleEdit(evt);
    }, true);
  }

  private handleInlineTitleEdit(evt: Event) {
    const target = evt.target as HTMLElement;
    if (!target.classList.contains(CONFIG.CSS_SELECTORS.INLINE_TITLE.slice(1))) return;

    const activeLeaf = this.getActiveLeaf();
    if (!activeLeaf) return;

    if (this.previewLeaves.has(activeLeaf)) {
      this.promoteToPermanent(activeLeaf);
    }

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
  // Tab Style / 탭 스타일
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
  // Sidebar State Management / 사이드바 상태 관리
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get file explorer view instance (shared helper for sidebar methods).
   * 파일 탐색기 뷰 인스턴스 획득 (사이드바 메서드 공용 헬퍼).
   */
  private getExplorerView(): ExplorerView | null {
    const view = this.app.workspace.getLeavesOfType(CONFIG.VIEW_TYPES.FILE_EXPLORER)[0]?.view;
    return (view as unknown as ExplorerView) ?? null;
  }

  /**
   * Phase 1: Reset sidebar internal state before detach.
   * 1단계: detach 전 사이드바 내부 상태 리셋.
   *
   * Without this, re-clicking the same file after closing its tab does nothing
   * because the explorer thinks the file is still active.
   * 이 처리 없이 탭을 닫고 같은 파일을 다시 클릭하면 탐색기가 여전히 활성으로 인식하여 반응 없음.
   */
  private clearSidebarInternalState() {
    const explorerView = this.getExplorerView();
    if (!explorerView) return;

    // onFileOpen(null): reset explorerView.activeDom + remove is-active class
    if (explorerView.onFileOpen) {
      explorerView.onFileOpen(null);
    }
    // Direct tree.activeDom reset (onFileOpen(null) skips this when activeDom is already null)
    // tree.activeDom 직접 초기화 (activeDom이 이미 null이면 onFileOpen(null)이 건너뛰므로)
    if (explorerView.tree && explorerView.tree.activeDom !== null) {
      explorerView.tree.activeDom = null;
    }
    // Remove has-focus / has-focus 제거
    if (explorerView.tree?.setFocusedItem) {
      explorerView.tree.setFocusedItem(null);
    }
  }

  /**
   * Phase 2: Clean stale DOM classes after detach (called via setTimeout).
   * 2단계: detach 후 잔류 DOM 클래스 정리 (setTimeout으로 호출).
   *
   * Obsidian events may restore is-active/has-focus after our Phase 1 cleanup.
   * We compare against internal state and remove any mismatched DOM classes.
   * Obsidian 이벤트가 Phase 1 정리 후 is-active/has-focus를 복원할 수 있음.
   * 내부 상태와 비교하여 불일치하는 DOM 클래스를 제거.
   */
  private cleanStaleSidebarDOM() {
    const explorerView = this.getExplorerView();
    if (!explorerView) return;

    if (!explorerView.activeDom && !explorerView.tree?.activeDom) {
      const staleActive = explorerView.containerEl?.querySelectorAll(CONFIG.CSS_SELECTORS.STALE_ACTIVE);
      staleActive?.forEach((el: Element) => (el as HTMLElement).classList.remove("is-active"));
    }

    if (!explorerView.tree?.focusedItem) {
      const staleFocus = explorerView.containerEl?.querySelectorAll(CONFIG.CSS_SELECTORS.STALE_FOCUS);
      staleFocus?.forEach((el: Element) => (el as HTMLElement).classList.remove("has-focus"));
    }
  }

  /**
   * Safety net: ensure explorer active state after opening a file.
   * 안전망: 파일을 연 뒤 탐색기의 활성 상태가 올바른지 확인.
   *
   * When file-open event doesn't fire (e.g., after detach+reopen),
   * the explorer's activeDom gets out of sync. This forces a re-sync.
   * file-open 이벤트가 발생하지 않는 경우(detach 후 재열기 등)
   * 탐색기의 activeDom이 동기화되지 않으므로 강제 재동기화.
   */
  private ensureExplorerActiveState(file: TFile) {
    const explorerView = this.getExplorerView();
    if (!explorerView?.onFileOpen) return;

    if (explorerView.activeDom?.file?.path === file.path) {
      return;
    }

    explorerView.onFileOpen(file);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Utilities / 유틸리티
  // ─────────────────────────────────────────────────────────────────────────

  private getFilePath(leaf: WorkspaceLeaf): string | null {
    const view = leaf.view;
    if (view instanceof FileView && view.file) {
      return view.file.path;
    }
    return null;
  }

  private getLeafId(leaf: WorkspaceLeaf): string {
    return (leaf as unknown as InternalLeaf).id ?? "unknown";
  }

  private getActiveLeaf(): WorkspaceLeaf | null {
    return this.app.workspace.getMostRecentLeaf();
  }

  private isFileElement(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return !!target.closest("[data-path]") || !!target.closest(".tree-item-self");
  }

  /**
   * Detect Daily Notes by checking the internal plugin settings and strict date parsing.
   * Daily Notes 내부 플러그인 설정과 엄격한 날짜 파싱으로 Daily Note 여부를 감지합니다.
   */
  private isDailyNote(file: TFile): boolean {
    if (file.extension !== "md") return false;

    const dailyNotes = (this.app as any).internalPlugins?.getPluginById?.("daily-notes");
    if (!dailyNotes?.enabled) return false;

    const options = dailyNotes.instance?.options;
    const format = options?.format || "YYYY-MM-DD";
    const folder = options?.folder || "";

    if (folder && file.parent?.path !== folder) return false;

    return (window as any).moment(file.basename, format, true).isValid();
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

  /**
   * Consume-once flag pattern: returns true if viewType matches the expected ribbon
   * double-click type, then clears the flag. Used by setViewState to detect intent.
   * 1회 소비 플래그 패턴: viewType이 리본 더블클릭 기대 타입과 일치하면 true 반환 후
   * 플래그 초기화. setViewState에서 의도 감지에 사용.
   */
  private consumeRibbonDoubleClickFlag(viewType: string): boolean {
    if (this.ribbonDoubleClickExpectedViewType === viewType) {
      this.ribbonDoubleClickExpectedViewType = null;
      return true;
    }
    return false;
  }
}
