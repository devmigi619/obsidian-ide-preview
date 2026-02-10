import {
  Plugin,
  WorkspaceLeaf,
  TFile,
  FileView,
  Notice,
  WorkspaceSplit,
  App,
  PluginSettingTab,
  Setting,
} from "obsidian";
import { around } from "monkey-around";

// ═══════════════════════════════════════════════════════════════════════════
// 플러그인 설정
// ═══════════════════════════════════════════════════════════════════════════

interface IDEStylePreviewSettings {
  debugMode: boolean;
}

const DEFAULT_SETTINGS: IDEStylePreviewSettings = {
  debugMode: false
}

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

  /** 플러그인 설정 */
  settings!: IDEStylePreviewSettings;

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

  /** 디버그용: 이벤트 시퀀스 카운터 */
  private eventSequence = 0;

  /** 디버그용: MutationObserver */
  private debugObserver: MutationObserver | null = null;

  /** 디버그용: 마지막 hover된 경로 */
  private lastHoveredPath: string | null = null;

  // ─────────────────────────────────────────────────────────────────────────
  // 라이프사이클
  // ─────────────────────────────────────────────────────────────────────────

  async onload() {
    await this.loadSettings();
    log("Plugin loaded");

    this.app.workspace.onLayoutReady(() => {
      // 디버그 모드가 켜져 있을 때만 포괄적 디버그 시작
      if (this.settings.debugMode) {
        this.setupComprehensiveDebug();
      }
    });

    this.installPatches();
    this.registerEventHandlers();

    // 설정 탭 추가
    this.addSettingTab(new IDEStylePreviewSettingTab(this.app, this));
  }

  onunload() {
    // 디버그 Observer 정리
    if (this.debugObserver) {
      this.debugObserver.disconnect();
      this.debugObserver = null;
    }

    this.cleanupFunctions.forEach((cleanup) => cleanup());
    this.cleanupFunctions = [];

    this.removeAllPreviewStyles();

    log("Plugin unloaded");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 포괄적 디버그 시스템
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * 포괄적인 디버그 설정
   * 1. DOM 클래스 변화 실시간 추적 (MutationObserver)
   * 2. 마우스 이벤트 추적 (hover 동작 파악)
   * 3. CSS 스타일 분석 (hover vs is-active)
   */
  private setupComprehensiveDebug() {
    console.log("\n" + "=".repeat(70));
    console.log("★★★ 포괄적 디버그 모드 시작 ★★★");
    console.log("=".repeat(70));

    this.setupDOMMutationObserver();
    this.setupMouseEventTracking();
    this.analyzeCSSStyles();
    this.setupWorkspaceEventTracking();

    console.log("\n" + "=".repeat(70));
    console.log("디버그 모드 준비 완료 - 이제 테스트를 시작하세요");
    console.log("=".repeat(70) + "\n");
  }

  /**
   * 1. DOM 클래스 변화 실시간 추적
   */
  private setupDOMMutationObserver() {
    const leftSidebar = document.querySelector(".workspace-split.mod-left-split");
    if (!leftSidebar) {
      console.log("[DEBUG] 왼쪽 사이드바를 찾을 수 없음");
      return;
    }

    this.debugObserver = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === "attributes" && mutation.attributeName === "class") {
          const target = mutation.target as HTMLElement;

          // tree-item-self 또는 nav-file-title 요소만 추적
          if (target.classList.contains("tree-item-self") ||
              target.classList.contains("nav-file-title")) {

            const oldValue = mutation.oldValue || "";
            const newValue = target.className;

            if (oldValue !== newValue) {
              const path = target.getAttribute("data-path") ||
                           target.closest("[data-path]")?.getAttribute("data-path") ||
                           "unknown";

              // 추가/제거된 클래스 계산
              const oldClasses = new Set(oldValue.split(" ").filter(Boolean));
              const newClasses = new Set(newValue.split(" ").filter(Boolean));

              const added: string[] = [];
              const removed: string[] = [];

              newClasses.forEach(c => {
                if (!oldClasses.has(c)) added.push(c);
              });
              oldClasses.forEach(c => {
                if (!newClasses.has(c)) removed.push(c);
              });

              // 관련 변화만 로그 (is-active, has-focus, is-selected 등)
              const isRelevant = added.some(c => 
                c.includes("active") || c.includes("focus") || c.includes("selected")
              ) || removed.some(c => 
                c.includes("active") || c.includes("focus") || c.includes("selected")
              );

              if (isRelevant) {
                const timestamp = new Date().toISOString().substr(11, 12);
                console.log(`\n[DOM변화] ${timestamp} | ${path}`);
                if (added.length > 0) console.log(`  ✚ 추가: ${added.join(", ")}`);
                if (removed.length > 0) console.log(`  ✖ 제거: ${removed.join(", ")}`);
                console.log(`  현재: ${newValue}`);

                // 스택 트레이스 (어디서 변경되었는지 추적)
                console.log(`  호출 스택:`);
                const stack = new Error().stack?.split("\n").slice(2, 6).join("\n    ");
                console.log(`    ${stack}`);
              }
            }
          }
        }
      });
    });

    this.debugObserver.observe(leftSidebar, {
      attributes: true,
      attributeOldValue: true,
      subtree: true,
      attributeFilter: ["class"]
    });

    console.log("[DEBUG] MutationObserver 설정 완료 - 클래스 변화 추적 중");
  }

  /**
   * 2. 마우스 이벤트 추적 (hover 동작 파악)
   */
  private setupMouseEventTracking() {
    // mouseover
    this.registerDomEvent(document, "mouseover", (evt: MouseEvent) => {
      const target = evt.target as HTMLElement;
      const fileEl = target.closest(".tree-item-self, .nav-file-title") as HTMLElement;

      if (fileEl) {
        const path = fileEl.getAttribute("data-path") ||
                     fileEl.closest("[data-path]")?.getAttribute("data-path");

        if (path && path !== this.lastHoveredPath) {
          this.lastHoveredPath = path;
          const timestamp = new Date().toISOString().substr(11, 12);
          
          // computed style 확인
          const computedStyle = window.getComputedStyle(fileEl);
          const bgColor = computedStyle.backgroundColor;
          
          console.log(`[HOVER IN] ${timestamp} | ${path}`);
          console.log(`  클래스: ${fileEl.className}`);
          console.log(`  background-color: ${bgColor}`);
        }
      }
    }, true);

    // mouseout
    this.registerDomEvent(document, "mouseout", (evt: MouseEvent) => {
      const target = evt.target as HTMLElement;
      const fileEl = target.closest(".tree-item-self, .nav-file-title") as HTMLElement;

      if (fileEl) {
        const path = fileEl.getAttribute("data-path") ||
                     fileEl.closest("[data-path]")?.getAttribute("data-path");

        if (path && path === this.lastHoveredPath) {
          const timestamp = new Date().toISOString().substr(11, 12);
          console.log(`[HOVER OUT] ${timestamp} | ${path}`);
          console.log(`  클래스: ${fileEl.className}`);

          // 50ms 후 background-color 재확인 (hover 해제 후)
          setTimeout(() => {
            const computedStyle = window.getComputedStyle(fileEl);
            console.log(`  (50ms 후) background-color: ${computedStyle.backgroundColor}`);
            console.log(`  (50ms 후) 클래스: ${fileEl.className}`);
          }, 50);

          this.lastHoveredPath = null;
        }
      }
    }, true);

    console.log("[DEBUG] 마우스 이벤트 리스너 설정 완료");
  }

  /**
 * 3. CSS 스타일 분석
 */
private analyzeCSSStyles() {
  console.log("\n[CSS 분석] hover와 is-active 관련 스타일:");

  const relevantPatterns = [
    ".is-active",
    ":hover",
    ".has-focus",
    ".nav-file-title",
    ".tree-item-self"
  ];

  const foundRules: { selector: string; bg: string; source: string }[] = [];

  // StyleSheetList를 Array로 변환
  const sheets = Array.from(document.styleSheets);
  
  for (const sheet of sheets) {
    try {
      const rules = sheet.cssRules || sheet.rules;
      if (!rules) continue;
      
      const source = sheet.href || "inline";

      // CSSRuleList도 Array로 변환
      const ruleArray = Array.from(rules);
      
      for (const rule of ruleArray) {
        if (rule instanceof CSSStyleRule) {
          const selector = rule.selectorText;
          
          // 관련 셀렉터인지 확인
          const isRelevant = relevantPatterns.some(p => selector.includes(p));
          
          if (isRelevant) {
            // background 관련 스타일 확인
            const bgColor = rule.style.backgroundColor;
            const bg = rule.style.background;
            
            if (bgColor || bg) {
              foundRules.push({
                selector,
                bg: bgColor || bg,
                source: source.split("/").pop() || source
              });
            }
          }
        }
      }
    } catch (e) {
      // Cross-origin 스타일시트 - 무시
    }
  }

  // 정렬하여 출력
  foundRules.sort((a, b) => a.selector.localeCompare(b.selector));
  foundRules.forEach(r => {
    console.log(`  [${r.source}] ${r.selector}`);
    console.log(`    → ${r.bg}`);
  });

  if (foundRules.length === 0) {
    console.log("  (관련 CSS 규칙을 찾을 수 없음 - CSS 변수 사용 가능성)");
  }

  // CSS 변수 확인
  console.log("\n[CSS 변수] 배경 관련 변수:");
  const root = document.documentElement;
  const computedRoot = window.getComputedStyle(root);
  
  const bgVars = [
    "--background-modifier-hover",
    "--background-modifier-active-hover",
    "--nav-item-background-hover",
    "--nav-item-background-active",
    "--interactive-hover",
    "--interactive-accent"
  ];

  bgVars.forEach(varName => {
    const value = computedRoot.getPropertyValue(varName);
    if (value) {
      console.log(`  ${varName}: ${value.trim()}`);
    }
  });
}

  /**
   * 4. 워크스페이스 이벤트 추적
   */
  private setupWorkspaceEventTracking() {
    // active-leaf-change
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        const timestamp = new Date().toISOString().substr(11, 12);
        console.log(`\n[EVENT: active-leaf-change] ${timestamp}`);
        
        if (leaf) {
          const leafId = this.getLeafDebugId(leaf);
          const viewType = leaf.view?.getViewType() ?? "null";
          const filePath = this.getFilePath(leaf);
          
          console.log(`  leaf.id: ${leafId}`);
          console.log(`  viewType: ${viewType}`);
          console.log(`  filePath: ${filePath ?? "null"}`);
        } else {
          console.log(`  leaf: null`);
        }

        this.logExplorerState("active-leaf-change 후");
      })
    );

    // layout-change
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        const timestamp = new Date().toISOString().substr(11, 12);
        console.log(`\n[EVENT: layout-change] ${timestamp}`);
        this.logExplorerState("layout-change 후");
      })
    );

    console.log("[DEBUG] 워크스페이스 이벤트 리스너 설정 완료");
  }

  /**
   * File Explorer 상태 간단 로깅
   */
  private logExplorerState(context: string) {
    const explorerLeaves = this.app.workspace.getLeavesOfType("file-explorer");
    const explorerView = explorerLeaves[0]?.view as any;

    console.log(`  [Explorer 상태] ${context}`);
    
    if (explorerView) {
      console.log(`    activeDom?.file?.path: ${explorerView.activeDom?.file?.path ?? "null"}`);
      console.log(`    tree.activeDom?.file?.path: ${explorerView.tree?.activeDom?.file?.path ?? "null"}`);
      console.log(`    tree.focusedItem?.file?.path: ${explorerView.tree?.focusedItem?.file?.path ?? "null"}`);
    }

    // DOM 상태
    const activeEls = document.querySelectorAll(".tree-item-self.is-active, .nav-file-title.is-active");
    const focusEls = document.querySelectorAll(".tree-item-self.has-focus, .nav-file-title.has-focus");
    
    console.log(`    DOM is-active: ${activeEls.length}개`);
    activeEls.forEach(el => {
      const path = el.getAttribute("data-path") || el.closest("[data-path]")?.getAttribute("data-path");
      console.log(`      - ${path}`);
    });
    
    console.log(`    DOM has-focus: ${focusEls.length}개`);
    focusEls.forEach(el => {
      const path = el.getAttribute("data-path") || el.closest("[data-path]")?.getAttribute("data-path");
      console.log(`      - ${path}`);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 기존 디버깅 함수들
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

  private getNextSequence(): number {
    return ++this.eventSequence;
  }

  /**
   * File Explorer의 내부 상태와 DOM 상태를 상세히 출력 (모두 펼쳐서)
   */
  private debugFileExplorerState(context: string) {
    const seq = this.getNextSequence();
    const timestamp = new Date().toISOString().substr(11, 12);
    
    console.log(`\n${"=".repeat(70)}`);
    console.log(`[${seq}] ${timestamp} | ${CONFIG.LOG_PREFIX} ${context}`);
    console.log(`${"=".repeat(70)}`);

    // 1. File Explorer View 가져오기
    const explorerLeaves = this.app.workspace.getLeavesOfType("file-explorer");
    const explorerView = explorerLeaves[0]?.view as any;

    console.log(`[${seq}] 1. File Explorer View 존재: ${!!explorerView}`);

    if (explorerView) {
      // 2. activeDom 상태 (펼쳐서)
      const activeDom = explorerView.activeDom;
      console.log(`[${seq}] 2. activeDom 상태:`);
      console.log(`[${seq}]    - activeDom 자체: ${activeDom === null ? 'null' : activeDom === undefined ? 'undefined' : 'object'}`);
      console.log(`[${seq}]    - activeDom?.file?.path: ${activeDom?.file?.path ?? '없음'}`);
      console.log(`[${seq}]    - activeDom?.selfEl 존재: ${!!activeDom?.selfEl}`);
      if (activeDom?.selfEl) {
        console.log(`[${seq}]    - activeDom.selfEl.className: ${activeDom.selfEl.className}`);
      }

      // 2-1. tree.activeDom 상태
      const treeActiveDom = explorerView.tree?.activeDom;
      console.log(`[${seq}] 2-1. tree.activeDom 상태:`);
      console.log(`[${seq}]    - tree.activeDom 자체: ${treeActiveDom === null ? 'null' : treeActiveDom === undefined ? 'undefined' : 'object'}`);
      console.log(`[${seq}]    - tree.activeDom?.file?.path: ${treeActiveDom?.file?.path ?? '없음'}`);
      console.log(`[${seq}]    - activeDom === tree.activeDom: ${activeDom === treeActiveDom}`);

      // 3. focusedItem 상태
      const focusedItem = explorerView.tree?.focusedItem;
      console.log(`[${seq}] 3. tree.focusedItem 상태:`);
      console.log(`[${seq}]    - focusedItem 자체: ${focusedItem === null ? 'null' : focusedItem === undefined ? 'undefined' : 'object'}`);
      console.log(`[${seq}]    - focusedItem?.file?.path: ${focusedItem?.file?.path ?? '없음'}`);
    }

    // 4. DOM 상태: is-active 클래스가 있는 요소들
    const activeItems = document.querySelectorAll(".nav-file-title.is-active, .tree-item-self.is-active");
    console.log(`[${seq}] 4. DOM is-active 요소 (${activeItems.length}개):`);
    if (activeItems.length === 0) {
      console.log(`[${seq}]    - (없음)`);
    } else {
      activeItems.forEach((item, idx) => {
        const path = item.getAttribute("data-path") || item.closest("[data-path]")?.getAttribute("data-path");
        console.log(`[${seq}]    - [${idx}] path: ${path}`);
        console.log(`[${seq}]    - [${idx}] className: ${item.className}`);
      });
    }

    // 5. DOM 상태: has-focus 클래스가 있는 요소들
    const focusedItems = document.querySelectorAll(".nav-file-title.has-focus, .tree-item-self.has-focus");
    console.log(`[${seq}] 5. DOM has-focus 요소 (${focusedItems.length}개):`);
    if (focusedItems.length === 0) {
      console.log(`[${seq}]    - (없음)`);
    } else {
      focusedItems.forEach((item, idx) => {
        const path = item.getAttribute("data-path") || item.closest("[data-path]")?.getAttribute("data-path");
        console.log(`[${seq}]    - [${idx}] path: ${path}`);
        console.log(`[${seq}]    - [${idx}] className: ${item.className}`);
      });
    }

    // 6. 현재 열린 탭 정보
    const activeLeaf = this.getActiveLeaf();
    console.log(`[${seq}] 6. 현재 활성 Leaf:`);
    console.log(`[${seq}]    - leaf id: ${activeLeaf ? this.getLeafDebugId(activeLeaf) : 'null'}`);
    console.log(`[${seq}]    - viewType: ${activeLeaf?.view?.getViewType() ?? 'null'}`);
    console.log(`[${seq}]    - filePath: ${activeLeaf ? this.getFilePath(activeLeaf) : 'null'}`);
    console.log(`[${seq}]    - isPreview: ${activeLeaf ? this.previewLeaves.has(activeLeaf) : false}`);

    // 7. 모든 열린 탭 목록
    console.log(`[${seq}] 7. 메인 영역 열린 탭:`);
    let tabIndex = 0;
    this.app.workspace.iterateAllLeaves((leaf) => {
      const location = this.getLeafLocation(leaf);
      if (location === "main") {
        const filePath = this.getFilePath(leaf);
        const viewType = leaf.view?.getViewType();
        const isPreview = this.previewLeaves.has(leaf);
        console.log(`[${seq}]    - [${tabIndex}] id=${this.getLeafDebugId(leaf)}, type=${viewType}, path=${filePath}, preview=${isPreview}`);
        tabIndex++;
      }
    });
    if (tabIndex === 0) {
      console.log(`[${seq}]    - (열린 탭 없음)`);
    }

    console.log(`${"=".repeat(70)}\n`);
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

  private determineOpenIntent(file: TFile, openState?: any): OpenIntent {
    // 1. rename: "all" means create (newly created file)
    if (openState?.eState?.rename === "all") {
      return "create";
    }

    // 2. Canvas/PDF without rename should be browse
    if (file.extension === "canvas" || file.extension === "pdf") {
      return "browse";
    }

    // 3. Daily Notes detection
    if (openState?.state?.mode === "source") {
      if (this.isDailyNote(file)) {
        return "create";
      }
    }

    return "browse";
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Leaf 탐색
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
    const seq = this.getNextSequence();
    console.log(`\n[${seq}] ▶▶▶ handleOpenFile 시작: ${file.path}`);
    console.log(`[${seq}]     leaf.id: ${this.getLeafDebugId(leaf)}`);
    this.debugFileExplorerState(`handleOpenFile 진입 - ${file.path}`);

    // 새로 생성된 파일인 경우 → 제목편집모드 강제 적용 (Daily Notes 제외)
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

    console.log(`[${seq}]     state=${currentState}, intent=${intent}, permanent=${shouldBePermanent}`);

    // 이미 같은 파일이 열려있으면 무시
    if (this.getFilePath(leaf) === file.path) {
      console.log(`[${seq}]     → Same file, skipping`);
      return;
    }

    // 다른 탭에 이미 열려있으면 포커스만 이동
    const existingLeaf = this.findLeafWithFile(file.path, leaf);
    if (existingLeaf && !isCtrlClick) {
      console.log(`[${seq}]     → Already open, focusing existing tab`);
      this.app.workspace.setActiveLeaf(existingLeaf, { focus: true });
      return;
    }

    // Permanent로 열어야 하는 경우
    if (shouldBePermanent) {
      if (currentState === "permanent" || currentState === "preview") {
        console.log(`[${seq}]     → Opening in new tab (permanent)`);
        const result = await this.openInNewTab(leaf, file, openState, true, originalMethod);
        this.debugFileExplorerState(`handleOpenFile 완료 (new tab permanent) - ${file.path}`);
        return result;
      }
      console.log(`[${seq}]     → Opening in current tab (permanent)`);
      this.markAsProcessed(leaf);
      const result = await originalMethod.call(leaf, file, openState);
      this.setAsPermanent(leaf);
      this.debugFileExplorerState(`handleOpenFile 완료 (current tab permanent) - ${file.path}`);
      return result;
    }

    // Preview로 열어야 하는 경우: 기존 Preview 탭 재사용
    const existingPreview = this.findPreviewLeaf(leaf);
    if (existingPreview) {
      console.log(`[${seq}]     → Reusing existing preview tab`);
      this.markAsProcessed(existingPreview);
      const result = await originalMethod.call(existingPreview, file, openState);
      this.app.workspace.setActiveLeaf(existingPreview, { focus: true });
      this.debugFileExplorerState(`handleOpenFile 완료 (reuse preview) - ${file.path}`);
      return result;
    }

    // Preview가 없는 경우
    if (currentState === "permanent") {
      console.log(`[${seq}]     → Opening in new tab (preview)`);
      const result = await this.openInNewTab(leaf, file, openState, false, originalMethod);
      this.debugFileExplorerState(`handleOpenFile 완료 (new tab preview) - ${file.path}`);
      return result;
    }

    // Empty 또는 Preview 탭: 현재 탭에서 Preview로 열기
    console.log(`[${seq}]     → Opening in current tab (preview)`);
    this.markAsProcessed(leaf);
    const result = await originalMethod.call(leaf, file, openState);
    this.setAsPreview(leaf);
    this.ensureExplorerActiveState(file, seq);
    this.debugFileExplorerState(`handleOpenFile 완료 (current tab preview) - ${file.path}`);
    return result;
  }

  private async openInNewTab(
    _fromLeaf: WorkspaceLeaf,
    file: TFile,
    openState: any,
    asPermanent: boolean,
    originalMethod: Function
  ) {
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
    if (this.wasProcessed(leaf)) {
      this.clearProcessed(leaf);
      return originalMethod.call(leaf, viewState, eState);
    }

    const viewType = viewState?.type;

    if (viewType === "markdown" || viewType === "empty") {
      return originalMethod.call(leaf, viewState, eState);
    }

    if (this.isInSidebar(leaf)) {
      return originalMethod.call(leaf, viewState, eState);
    }

    const currentState = this.getTabState(leaf);
    const shouldBePermanent = this.consumeRibbonDoubleClickFlag(viewType);
    const leafId = this.getLeafDebugId(leaf);
    log(`setViewState: type=${viewType}, state=${currentState}, permanent=${shouldBePermanent}, leafId=${leafId}`);

    if (leaf.view?.getViewType() === viewType) {
      if (shouldBePermanent && this.previewLeaves.has(leaf)) {
        log(`  → Same view type, promoting to permanent`);
        this.promoteToPermament(leaf);
      } else {
        log(`  → Same view type, skipping`);
      }
      return;
    }

    const existingLeaf = this.findLeafWithViewType(viewType, leaf);
    if (existingLeaf) {
      log(`  → Already open: ${viewType}, focusing existing tab`);
      if (shouldBePermanent && this.previewLeaves.has(existingLeaf)) {
        this.promoteToPermament(existingLeaf);
      }
      this.app.workspace.setActiveLeaf(existingLeaf, { focus: true });
      return;
    }

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

    const existingPreview = this.findPreviewLeaf(leaf);
    if (existingPreview) {
      const previewId = this.getLeafDebugId(existingPreview);
      log(`  → Reusing existing preview tab (leafId=${previewId})`);
      const result = await originalMethod.call(existingPreview, viewState, eState);
      log(`  → After setViewState, isPreview=${this.previewLeaves.has(existingPreview)}`);
      this.app.workspace.setActiveLeaf(existingPreview, { focus: true });
      return result;
    }

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

          const seq = plugin.getNextSequence();
          console.log(`\n[${seq}] ▶▶▶ detach 시작`);
          console.log(`[${seq}]     닫히는 탭 leaf.id: ${leafId}`);
          console.log(`[${seq}]     닫히는 탭 filePath: ${filePath}`);

          // Phase 1: detach 전 내부 상태 리셋
          // → re-click 시 is-active 정상 적용을 위해 필수
          plugin.clearSidebarInternalState(seq);

          const result = original.call(this);

          // Phase 2: detach 후 잔류 DOM 클래스 정리
          // → Obsidian 이벤트가 복원한 시각적 잔류물 제거
          setTimeout(() => {
            plugin.cleanStaleSidebarDOM(seq);
          }, 0);

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
        const seq = this.getNextSequence();
        console.log(`\n[${seq}] ◆◆◆ file-open 이벤트: ${file?.path ?? 'null'}`);
        this.debugFileExplorerState(`file-open 이벤트 - ${file?.path ?? 'null'}`);

        if (!file) return;

        const activeLeaf = this.getActiveLeaf();
        const viewType = activeLeaf?.view?.getViewType();
        if (viewType === "markdown" || viewType === "canvas" || viewType === "pdf") {
          this.lastActiveLeaf = activeLeaf;
        }
      })
    );

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (!this.ribbonDoubleClickExpectedViewType || !leaf) {
          return;
        }

        const viewType = leaf.view?.getViewType();
        const expectedType = this.ribbonDoubleClickExpectedViewType;

        if (viewType === expectedType && this.previewLeaves.has(leaf)) {
          log(`Active leaf change → promoting expected ${viewType} view`);
          this.promoteToPermament(leaf);
        }

        this.ribbonDoubleClickExpectedViewType = null;
      })
    );
  }

  private registerClickHandlers() {
    // Ctrl+Click 감지 (mousedown 캡처 페이즈 — Obsidian이 mousedown에서 openFile 호출하므로 click보다 먼저 설정)
    this.registerDomEvent(document, "mousedown", (evt: MouseEvent) => {
      if ((evt.ctrlKey || evt.metaKey) && this.isFileElement(evt.target)) {
        this.isCtrlClickPending = true;
      }
    }, true);

    // 싱글 클릭 감지 (디버그 로그용)
    this.registerDomEvent(document, "click", (evt: MouseEvent) => {
      const target = evt.target as HTMLElement;
      const fileEl = target.closest("[data-path]") as HTMLElement | null;

      if (fileEl) {
        const path = fileEl.getAttribute("data-path");
        const seq = this.getNextSequence();
        console.log(`\n[${seq}] ● 파일 요소 싱글클릭: ${path}`);
        console.log(`[${seq}]   Ctrl/Meta: ${evt.ctrlKey || evt.metaKey}`);
        this.debugFileExplorerState(`싱글클릭 - ${path}`);
      }
    }, true);

    // 더블클릭 처리
    this.registerDomEvent(document, "dblclick", (evt: MouseEvent) => {
      const target = evt.target as HTMLElement;
      const fileEl = target.closest("[data-path]") as HTMLElement | null;

      if (fileEl) {
        const path = fileEl.getAttribute("data-path");
        const seq = this.getNextSequence();
        console.log(`\n[${seq}] ●● 파일 요소 더블클릭: ${path}`);
        this.debugFileExplorerState(`더블클릭 - ${path}`);
      }

      this.handleDoubleClick(evt);
    }, true);

    // 그래프 뷰 드래그 감지
    this.registerDomEvent(document, "mousedown", (evt: MouseEvent) => {
      const activeLeaf = this.getActiveLeaf();
      const viewType = activeLeaf?.view?.getViewType();

      if (viewType === "graph") {
        this.graphDragStartPos = { x: evt.clientX, y: evt.clientY };
      }
    }, true);

    this.registerDomEvent(document, "mouseup", (evt: MouseEvent) => {
      if (!this.graphDragStartPos) return;

      const activeLeaf = this.getActiveLeaf();
      const viewType = activeLeaf?.view?.getViewType();

      if (viewType === "graph") {
        const dx = evt.clientX - this.graphDragStartPos.x;
        const dy = evt.clientY - this.graphDragStartPos.y;
        const distance = Math.sqrt(dx * dx + dy * dy);

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

    if (target.closest(".workspace-tab-header")) {
      const activeLeaf = this.getActiveLeaf();
      if (activeLeaf && this.previewLeaves.has(activeLeaf)) {
        log("Tab header double-click → promote");
        this.promoteToPermament(activeLeaf);
      }
      return;
    }

    const sidebarContent = target.closest(".workspace-leaf-content");
    if (sidebarContent) {
      const leaf = this.findLeafByContentEl(sidebarContent as HTMLElement);
      if (leaf && this.isInSidebar(leaf)) {
        if (this.lastActiveLeaf && this.previewLeaves.has(this.lastActiveLeaf)) {
          log("Sidebar double-click → promote");
          this.promoteToPermament(this.lastActiveLeaf);
        }
        return;
      }
    }

    if (target.closest(".graph-view-container")) {
      if (this.lastActiveLeaf && this.previewLeaves.has(this.lastActiveLeaf)) {
        log("Graph double-click → promote");
        this.promoteToPermament(this.lastActiveLeaf);
      }
      return;
    }

    const ribbonButton = target.closest(".side-dock-ribbon-action");
    if (ribbonButton) {
      const ariaLabel = ribbonButton.getAttribute("aria-label") ?? "";
      const activeLeaf = this.getActiveLeaf();

      log("Ribbon button double-click");
      log(`  aria-label: "${ariaLabel}"`);

      if (activeLeaf && this.previewLeaves.has(activeLeaf)) {
        log(`  → Promoting active preview tab`);
        this.promoteToPermament(activeLeaf);
        return;
      }

      const ariaLower = ariaLabel.toLowerCase();
      let viewType: string | null = null;

      if (ariaLower.includes("graph") || ariaLabel.includes("그래프")) {
        viewType = "graph";
      } else if (ariaLower.includes("canvas") || ariaLabel.includes("캔버스")) {
        viewType = "canvas";
      }

      if (viewType) {
        const currentActiveLeaf = this.getActiveLeaf();
        if (currentActiveLeaf?.view?.getViewType() === viewType && this.previewLeaves.has(currentActiveLeaf)) {
          log(`  → Promoting existing ${viewType} view`);
          this.promoteToPermament(currentActiveLeaf);
          return;
        }
      }

      if (viewType) {
        this.ribbonDoubleClickExpectedViewType = viewType;
        log(`  → Expecting ${viewType} view on next active-leaf-change`);
      }
    }
  }

  private registerPromotionTriggers() {
    this.registerEvent(
      this.app.workspace.on("editor-change", (editor, info) => {
        const leaf = (info as any).leaf as WorkspaceLeaf | undefined;
        if (leaf && this.previewLeaves.has(leaf)) {
          log("Editor change → promote");
          this.promoteToPermament(leaf);
        }
      })
    );

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

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!(file instanceof TFile)) return;
        if (file.extension !== "canvas") return;

        this.app.workspace.iterateAllLeaves((leaf) => {
          if (this.getFilePath(leaf) === file.path && this.previewLeaves.has(leaf)) {
            log("Canvas modified → promote");
            this.promoteToPermament(leaf);
          }
        });
      })
    );

    this.registerDomEvent(document, "input", (evt: Event) => {
      this.handleInlineTitleEdit(evt);
    }, true);
  }

  private handleInlineTitleEdit(evt: Event) {
    const target = evt.target as HTMLElement;
    if (!target.classList.contains("inline-title")) return;

    const activeLeaf = this.getActiveLeaf();
    if (!activeLeaf) return;

    if (this.previewLeaves.has(activeLeaf)) {
      log("Inline title edit → promote");
      this.promoteToPermament(activeLeaf);
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

  /**
   * Phase 1: detach 전 사이드바 내부 상태 리셋
   * onFileOpen(null)로 내부 상태를 정리해야 re-click 시 is-active가 정상 적용됨
   */
  private clearSidebarInternalState(seq: number) {
    console.log(`\n[${seq}] ◇ Phase1: clearSidebarInternalState`);

    const explorerLeaves = this.app.workspace.getLeavesOfType("file-explorer");
    const explorerView = explorerLeaves[0]?.view as any;
    if (!explorerView) return;

    console.log(`[${seq}]   [BEFORE] activeDom: ${explorerView.activeDom?.file?.path ?? 'null'}, tree.activeDom: ${explorerView.tree?.activeDom?.file?.path ?? 'null'}, focusedItem: ${explorerView.tree?.focusedItem?.file?.path ?? 'null'}`);

    // 1. onFileOpen(null): explorerView.activeDom 초기화 + is-active 제거
    if (explorerView.onFileOpen) {
      explorerView.onFileOpen(null);
    }
    // 2. tree.activeDom 직접 초기화 (onFileOpen(null)이 이것을 지우지 않음)
    if (explorerView.tree && explorerView.tree.activeDom !== null) {
      explorerView.tree.activeDom = null;
    }
    // 3. has-focus 제거
    if (explorerView.tree?.setFocusedItem) {
      explorerView.tree.setFocusedItem(null);
    }

    console.log(`[${seq}]   [AFTER] activeDom: ${explorerView.activeDom?.file?.path ?? 'null'}, tree.activeDom: ${explorerView.tree?.activeDom?.file?.path ?? 'null'}, focusedItem: ${explorerView.tree?.focusedItem?.file?.path ?? 'null'}`);
  }

  /**
   * Phase 2: detach 후 잔류 DOM 클래스 정리 (setTimeout 내에서 호출)
   * Obsidian 이벤트가 복원한 is-active/has-focus를 내부 상태와 비교하여 불일치 시 제거
   */
  private cleanStaleSidebarDOM(seq: number) {
    console.log(`\n[${seq}] ◇ Phase2: cleanStaleSidebarDOM`);

    const explorerLeaves = this.app.workspace.getLeavesOfType("file-explorer");
    const explorerView = explorerLeaves[0]?.view as any;
    if (!explorerView) return;

    // 내부 상태가 null인데 DOM에 is-active가 남아있으면 → 잔류물이므로 제거
    if (!explorerView.activeDom && !explorerView.tree?.activeDom) {
      const staleActive = explorerView.containerEl?.querySelectorAll('.tree-item-self.is-active');
      if (staleActive?.length > 0) {
        console.log(`[${seq}]   잔류 is-active ${staleActive.length}개 제거`);
        staleActive.forEach((el: HTMLElement) => el.classList.remove('is-active'));
      }
    }

    if (!explorerView.tree?.focusedItem) {
      const staleFocus = explorerView.containerEl?.querySelectorAll('.tree-item-self.has-focus');
      if (staleFocus?.length > 0) {
        console.log(`[${seq}]   잔류 has-focus ${staleFocus.length}개 제거`);
        staleFocus.forEach((el: HTMLElement) => el.classList.remove('has-focus'));
      }
    }

    console.log(`[${seq}]   완료 (activeDom: ${explorerView.activeDom?.file?.path ?? 'null'})`);
  }

  /**
   * 파일을 연 뒤 탐색기의 is-active가 올바르게 적용되었는지 확인하고, 안 되었으면 보정
   * file-open 이벤트가 발생하지 않는 경우(detach 후 재열기 등)에 대한 안전망
   */
  private ensureExplorerActiveState(file: TFile, seq: number) {
    const explorerLeaves = this.app.workspace.getLeavesOfType("file-explorer");
    const explorerView = explorerLeaves[0]?.view as any;
    if (!explorerView?.onFileOpen) return;

    if (explorerView.activeDom?.file?.path === file.path) {
      return; // 이미 올바르게 설정됨
    }

    console.log(`[${seq}]   ⚠ 탐색기 activeDom 불일치 → onFileOpen(${file.path}) 강제 호출`);
    explorerView.onFileOpen(file);
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

  private getActiveLeaf(): WorkspaceLeaf | null {
    return this.app.workspace.getMostRecentLeaf();
  }

  private isFileElement(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return !!target.closest("[data-path]") || !!target.closest(".tree-item-self");
  }

  private isDailyNote(file: TFile): boolean {
    if (file.extension !== "md") return false;

    const dailyNotes = (this.app as any).internalPlugins?.getPluginById?.("daily-notes");
    if (!dailyNotes?.enabled) return false;

    const options = dailyNotes.instance?.options;
    const format = options?.format || "YYYY-MM-DD";
    const folder = options?.folder || "";

    // 폴더 설정이 있으면 경로 확인
    if (folder && file.parent?.path !== folder) return false;

    // moment strict 파싱으로 파일명이 날짜 포맷과 일치하는지 확인
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

  private consumeRibbonDoubleClickFlag(viewType: string): boolean {
    if (this.ribbonDoubleClickExpectedViewType === viewType) {
      this.ribbonDoubleClickExpectedViewType = null;
      return true;
    }
    return false;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 설정 관리
  // ─────────────────────────────────────────────────────────────────────────

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 설정 탭
// ═══════════════════════════════════════════════════════════════════════════

class IDEStylePreviewSettingTab extends PluginSettingTab {
  plugin: IDEStylePreviewPlugin;

  constructor(app: App, plugin: IDEStylePreviewPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();
    containerEl.createEl("h2", { text: "IDE Style Preview Settings" });

    new Setting(containerEl)
      .setName("Debug mode")
      .setDesc("Enable comprehensive debug logging (requires restart)")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.debugMode)
          .onChange(async (value) => {
            this.plugin.settings.debugMode = value;
            await this.plugin.saveSettings();
            new Notice(
              "Debug mode changed. Please restart Obsidian for changes to take effect."
            );
          })
      );
  }
}