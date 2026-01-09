import {
  App,
  Plugin,
  PluginSettingTab,
  Setting,
  WorkspaceLeaf,
  TFile,
  Workspace,
  WorkspaceItem,
  FileView,
} from "obsidian";

/**
 * IDE-style Preview Tab Plugin
 * 
 * Core Philosophy:
 * - Single click = preview tab (reusable)
 * - Double click = permanent tab (protected)
 * - Permanent tabs are SACRED - never overwrite
 * 
 * Strategy A: Intercept user clicks, handle directly
 * Strategy B: React to file-open for non-click paths (Quick Switcher, etc.)
 */

/* ======================== Type Definitions ======================== */

interface ExtendedWorkspace extends Workspace {
  createLeafInParent(parent: WorkspaceItem, index: number): WorkspaceLeaf;
}

type LeafParent = WorkspaceItem & {
  children: WorkspaceItem[];
};

interface PreviewModeSettings {
  useItalicTitle: boolean;
  reuseEmptyTab: boolean;
  promoteOldPreview: boolean;
  jumpToDuplicate: boolean;
  openNewTabAtEnd: boolean;
  promoteLinkPanePreview: boolean;  // Special policy for backlinks/outgoing
}

const DEFAULT_SETTINGS: PreviewModeSettings = {
  useItalicTitle: true,
  reuseEmptyTab: true,
  promoteOldPreview: true,
  jumpToDuplicate: true,
  openNewTabAtEnd: false,
  promoteLinkPanePreview: true,  // Enable by default (IDE-like link navigation)
};

const PREVIEW_CLASS = "is-preview-tab";

// Click source types for Strategy A
type ClickSource = 
  | 'explorer'      // File explorer (.nav-file-title)
  | 'search'        // Search results (.search-result-*)
  | 'bookmark'      // Bookmarks pane
  | 'backlink'      // Backlinks pane
  | 'outgoing'      // Outgoing links pane
  | 'graph-node'    // Graph view node click
  | null;           // Unknown source → let Obsidian handle

// Tab state for decision making
type TabState = 'empty' | 'preview' | 'permanent';

// Stored leaf state for hijack detection
type LeafState = {
  path: string | null;
  isPreview: boolean;
  isPermanent: boolean;
  isEmpty: boolean;
  viewType: string;
};

/* ======================== Main Plugin Class ======================== */

export default class PreviewModePlugin extends Plugin {
  settings: PreviewModeSettings;

  // Panel-local preview tracking
  private previewByPanel = new Map<LeafParent, WorkspaceLeaf>();
  
  // State tracking for hijack detection
  private leafHistory = new WeakMap<WorkspaceLeaf, LeafState>();
  
  // New file tracking (for new note detection)
  private newlyCreatedFiles = new Set<string>();
  
  // Processing guards
  private isProcessingOpen = false;
  private internalOpenPaths = new Set<string>();
  
  // Click handling state
  private pendingClick: {
    source: ClickSource;
    file: TFile | null;
    timestamp: number;
    activeLeafState: LeafState | null;  // State at click time
  } | null = null;

  async onload() {
    console.log("[PreviewPlugin] Loading - IDE-style tab management");
    await this.loadSettings();
    this.addSettingTab(new PreviewModeSettingTab(this.app, this));

    // ===== Strategy A: Click Interception =====
    
    // Single click capture (new)
    this.registerDomEvent(document, "click", this.handleSingleClick, true);
    
    // Double click capture
    this.registerDomEvent(document, "dblclick", this.handleDoubleClick, true);
    
    // Tab header double-click (make permanent)
    this.registerDomEvent(document, "dblclick", this.handleHeaderDoubleClick, true);
    
    // Title edit makes permanent
    this.registerDomEvent(document, "input", this.handleInput, true);

    // ===== State Tracking =====
    
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf) this.captureLeafState(leaf);
      })
    );

    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        const leaf = this.findLeafByFile(file as TFile);
        if (leaf) this.captureLeafState(leaf);
      })
    );

    // Track new file creation
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        console.log("[PreviewPlugin] New file created:", file.path);
        this.newlyCreatedFiles.add(file.path);
        setTimeout(() => this.newlyCreatedFiles.delete(file.path), 5000);
      })
    );

    // File rename makes permanent
    this.registerEvent(
      this.app.vault.on("rename", (file) => {
        if (!(file instanceof TFile)) return;
        this.app.workspace.iterateAllLeaves((leaf) => {
          if (this.getLeafFilePath(leaf) === file.path && this.isPanelPreviewLeaf(leaf)) {
            this.promoteToPermament(leaf);
          }
        });
      })
    );

    // Editor change makes permanent
    this.registerEvent(
      this.app.workspace.on("editor-change", (_editor, info) => {
        const leaf = (info as any)?.leaf;
        if (leaf && this.isPanelPreviewLeaf(leaf)) {
          this.promoteToPermament(leaf);
        }
      })
    );

    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.cleanupPreviewMap();
        this.app.workspace.iterateAllLeaves(leaf => this.captureLeafState(leaf));
      })
    );

    // ===== Strategy B: File Open Handler (for non-click paths) =====
    
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        console.log("[PreviewPlugin] ▶▶▶ file-open event fired:", {
          filePath: file?.path ?? 'null',
          isProcessingOpen: this.isProcessingOpen,
          hasPendingClick: !!this.pendingClick,
          pendingClickSource: this.pendingClick?.source,
          pendingClickHasFile: !!this.pendingClick?.file,
          isInInternalPaths: file instanceof TFile && this.internalOpenPaths.has(file.path)
        });
        
        if (this.isProcessingOpen) {
          console.log("[PreviewPlugin] Skipping - isProcessingOpen is true");
          return;
        }
        
        // Check if this is a backlink/outgoing click FIRST
        // These should NOT be skipped even if the file is in internalOpenPaths
        const isLinkPaneClick = this.pendingClick && 
                                (this.pendingClick.source === 'backlink' || this.pendingClick.source === 'outgoing') &&
                                !this.pendingClick.file &&
                                Date.now() - this.pendingClick.timestamp < 1000;
        
        if (isLinkPaneClick) {
          console.log("[PreviewPlugin] Link pane click detected - proceeding to handleFileOpen");
          // Clean up internalOpenPaths for this file if present
          if (file instanceof TFile) {
            this.internalOpenPaths.delete(file.path);
          }
          this.handleFileOpen(file);
          return;
        }
        
        // Skip if we opened this internally (and it's not a link pane click)
        if (file instanceof TFile && this.internalOpenPaths.has(file.path)) {
          console.log("[PreviewPlugin] Skipping - internal open");
          this.internalOpenPaths.delete(file.path);
          const leaf = this.findLeafByFile(file);
          if (leaf) this.captureLeafState(leaf);
          return;
        }

        // Check if this was handled by Strategy A (file was extracted and opened by us)
        if (this.pendingClick && 
            this.pendingClick.file &&
            Date.now() - this.pendingClick.timestamp < 500) {
          console.log("[PreviewPlugin] Skipping - already handled by Strategy A");
          this.pendingClick = null;
          return;
        }

        this.handleFileOpen(file);
      })
    );

    // Initialize state for all leaves
    this.app.workspace.iterateAllLeaves(leaf => this.captureLeafState(leaf));
  }

  onunload() {
    document.querySelectorAll(`.${PREVIEW_CLASS}`).forEach((el) => 
      el.classList.remove(PREVIEW_CLASS)
    );
    this.previewByPanel.clear();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  
  async saveSettings() {
    await this.saveData(this.settings);
  }

  /* ======================== Click Source Detection ======================== */

  /**
   * Detect where a click originated from
   * This is the core of Strategy A - knowing the source allows different policies
   * 
   * IMPORTANT: Check specific panes (backlink, outgoing) BEFORE generic ones (search)
   * because they share similar DOM structures
   */
  private detectClickSource(target: HTMLElement): ClickSource {
    // DEBUG: Log actual checks
    const hasBacklinkPane = !!target.closest('.backlink-pane');
    const hasOutgoingPane = !!target.closest('.outgoing-link-pane');
    const hasNavFile = !!target.closest('.nav-file-title') || !!target.closest('.nav-file');
    const hasBookmarkClass = !!target.closest('.bookmark');
    const hasSearchResult = !!target.closest('.search-result-file-title') || 
                            !!target.closest('.search-result-file-match') ||
                            !!target.closest('.search-result-container');
    
    console.log("[PreviewPlugin] detectClickSource checks:", {
      hasBacklinkPane,
      hasOutgoingPane, 
      hasNavFile,
      hasBookmarkClass,
      hasSearchResult
    });
    
    // Check specific panes FIRST (they have unique parent containers)
    
    // Backlinks pane - check parent container first
    if (hasBacklinkPane) {
      return 'backlink';
    }
    
    // Outgoing links pane
    if (hasOutgoingPane) {
      return 'outgoing';
    }
    
    // File explorer - very specific selector
    if (hasNavFile) {
      return 'explorer';
    }
    
    // Bookmarks - has .bookmark class on the clickable element
    if (hasBookmarkClass) {
      return 'bookmark';
    }
    
    // Search results - generic search pane
    // Must be checked AFTER backlinks/outgoing since they use similar classes
    if (hasSearchResult) {
      return 'search';
    }
    
    return null;
  }

  /**
   * Extract file from click target
   * Checks various data attributes and DOM structures used by Obsidian
   */
  private extractFileFromClick(target: HTMLElement): TFile | null {
    // Method 1: Check data attributes (most reliable)
    const attrKeys = [
      "data-path", 
      "data-href", 
      "data-file", 
      "data-source-path", 
      "data-resource-path", 
      "data-link"
    ];
    
    for (const key of attrKeys) {
      const el = target.closest<HTMLElement>(`[${key}]`);
      if (el) {
        const value = el.getAttribute(key);
        const file = this.resolveToFile(value);
        if (file) {
          console.log(`[PreviewPlugin] File found via ${key}:`, value);
          return file;
        }
      }
    }
    
    // Method 2: Search result file title (has class search-result-file-title)
    // The title element itself or its parent tree-item has the file path
    const searchTitle = target.closest('.search-result-file-title');
    if (searchTitle) {
      // Try to find inner text element
      const innerText = searchTitle.querySelector('.tree-item-inner-text');
      if (innerText) {
        const file = this.resolveToFile(innerText.textContent?.trim() ?? null);
        if (file) {
          console.log("[PreviewPlugin] File found via search-result inner text");
          return file;
        }
      }
      // Fallback to direct text content
      const file = this.resolveToFile(searchTitle.textContent?.trim() ?? null);
      if (file) {
        console.log("[PreviewPlugin] File found via search-result text content");
        return file;
      }
    }
    
    // Method 3: Search result match - find parent container's title
    const searchMatch = target.closest('.search-result-file-match');
    if (searchMatch) {
      // Go up to search-result container and find the title
      const container = searchMatch.closest('.search-result');
      if (container) {
        const titleEl = container.querySelector('.search-result-file-title .tree-item-inner-text') ||
                        container.querySelector('.search-result-file-title');
        if (titleEl) {
          const file = this.resolveToFile(titleEl.textContent?.trim() ?? null);
          if (file) {
            console.log("[PreviewPlugin] File found via search-match parent");
            return file;
          }
        }
      }
    }
    
    // Method 4: Tree item with inner text (bookmarks, backlinks, etc.)
    const treeItemInner = target.closest('.tree-item-inner');
    if (treeItemInner) {
      const innerText = treeItemInner.querySelector('.tree-item-inner-text');
      if (innerText) {
        const file = this.resolveToFile(innerText.textContent?.trim() ?? null);
        if (file) {
          console.log("[PreviewPlugin] File found via tree-item-inner-text");
          return file;
        }
      }
      // Try the tree-item-inner itself
      const file = this.resolveToFile(treeItemInner.textContent?.trim() ?? null);
      if (file) {
        console.log("[PreviewPlugin] File found via tree-item-inner text");
        return file;
      }
    }
    
    // Method 5: Internal/external links
    const anchor = target.closest<HTMLAnchorElement>('a.internal-link, a.external-link');
    if (anchor) {
      const href = anchor.getAttribute('href');
      if (href) {
        const file = this.resolveToFile(href);
        if (file) {
          console.log("[PreviewPlugin] File found via anchor href");
          return file;
        }
      }
    }
    
    // Method 6: Backlinks/Outgoing specific - look for data attributes in parent tree-item
    const treeItem = target.closest('.tree-item');
    if (treeItem) {
      // Some views store path in the tree-item's data attributes
      for (const key of attrKeys) {
        const value = treeItem.getAttribute(key);
        if (value) {
          const file = this.resolveToFile(value);
          if (file) {
            console.log(`[PreviewPlugin] File found via tree-item ${key}`);
            return file;
          }
        }
      }
    }
    
    console.log("[PreviewPlugin] No file found in click target");
    return null;
  }

  /* ======================== Tab State Management ======================== */

  /**
   * Get current state of a tab
   */
  private getCurrentTabState(leaf: WorkspaceLeaf): TabState {
    if (leaf.view.getViewType() === 'empty') return 'empty';
    if (this.isPanelPreviewLeaf(leaf)) return 'preview';
    return 'permanent';
  }

  /**
   * Capture and store leaf state for later comparison
   */
  private captureLeafState(leaf: WorkspaceLeaf): void {
    const path = this.getLeafFilePath(leaf);
    const isPreview = this.isPanelPreviewLeaf(leaf);
    const isEmpty = leaf.view.getViewType() === 'empty';
    const isPermanent = !isPreview && !isEmpty;
    const viewType = leaf.view.getViewType();
    
    this.leafHistory.set(leaf, { path, isPreview, isPermanent, isEmpty, viewType });
  }

  /* ======================== Strategy A: Click Handlers ======================== */

  /**
   * Handle single clicks - the main entry point for Strategy A
   */
  private handleSingleClick = (evt: MouseEvent) => {
    // Don't interfere with modifier keys (user wants special behavior)
    if (evt.ctrlKey || evt.metaKey || evt.shiftKey || evt.altKey) return;
    
    const target = evt.target as HTMLElement;
    
    // DEBUG: Log all clicks to understand DOM structure
    const bookmarkView = target.closest('.workspace-leaf-content[data-type="bookmarks"]');
    console.log("[PreviewPlugin] Click target:", {
      tagName: target.tagName,
      className: target.className,
      parentClasses: target.parentElement?.className,
      closestNavFile: target.closest('.nav-file-title, .nav-file')?.className,
      closestSearchResult: target.closest('.search-result-file-title, .search-result-file-match')?.className,
      closestTreeItemInner: target.closest('.tree-item-inner')?.className,
      closestBacklink: target.closest('.backlink-pane')?.className,
      closestOutgoing: target.closest('.outgoing-link-pane')?.className,
      isInBookmarkView: !!bookmarkView,
    });
    
    const source = this.detectClickSource(target);
    console.log("[PreviewPlugin] Detected source:", source);
    
    // If we can't identify the source, let Obsidian handle it
    if (!source) {
      console.log("[PreviewPlugin] Source not detected, letting Obsidian handle");
      return;
    }
    
    const file = this.extractFileFromClick(target);
    console.log("[PreviewPlugin] Extracted file:", file?.path ?? "null");
    
    if (!file) {
      // Special case: For backlink/outgoing, we know the source but can't extract file
      // Record the source so Strategy B can apply the correct policy
      if (source === 'backlink' || source === 'outgoing') {
        // Capture current leaf state NOW, before Obsidian changes it
        const activeLeaf = this.app.workspace.getLeaf(false);
        const currentState = activeLeaf ? this.leafHistory.get(activeLeaf) : null;
        
        // Also check what's in the main editor area
        const mainLeaf = this.app.workspace.getMostRecentLeaf();
        const mainState = mainLeaf ? this.leafHistory.get(mainLeaf) : null;
        
        console.log(`[PreviewPlugin] ${source} click detected - capturing state:`, {
          activeLeafExists: !!activeLeaf,
          activeLeafPath: activeLeaf ? this.getLeafFilePath(activeLeaf) : 'none',
          activeLeafState: currentState ? {
            path: currentState.path,
            isPermanent: currentState.isPermanent,
            isPreview: currentState.isPreview
          } : 'none',
          mainLeafExists: !!mainLeaf,
          mainLeafPath: mainLeaf ? this.getLeafFilePath(mainLeaf) : 'none',
          mainLeafState: mainState ? {
            path: mainState.path,
            isPermanent: mainState.isPermanent,
            isPreview: mainState.isPreview
          } : 'none',
          areTheSame: activeLeaf === mainLeaf
        });
        
        // Use mainLeaf state if activeLeaf is in a sidebar
        const leafToUse = mainLeaf || activeLeaf;
        const stateToUse = mainState || currentState;
        
        this.pendingClick = {
          source,
          file: null,
          timestamp: Date.now(),
          activeLeafState: stateToUse ? { ...stateToUse } : null
        };
        // Don't prevent default - let Obsidian open the file, Strategy B will handle it
        return;
      }
      
      console.log("[PreviewPlugin] File not extracted, letting Obsidian handle");
      return;
    }
    
    console.log(`[PreviewPlugin] ★ Single click intercepted: source=${source}, file=${file.path}`);
    
    // Prevent Obsidian's default handling
    evt.preventDefault();
    evt.stopPropagation();
    
    // Record this click for Strategy B coordination
    this.pendingClick = {
      source,
      file,
      timestamp: Date.now(),
      activeLeafState: null  // Not needed for direct handling
    };
    
    // Handle based on source
    this.handleSourceClick(source, file, 'single');
  };

  /**
   * Handle double clicks
   */
  private handleDoubleClick = (evt: MouseEvent) => {
    if (evt.ctrlKey || evt.metaKey || evt.shiftKey || evt.altKey) return;
    
    const target = evt.target as HTMLElement;
    const source = this.detectClickSource(target);
    
    if (!source) return;
    
    const file = this.extractFileFromClick(target);
    if (!file) return;
    
    console.log(`[PreviewPlugin] Double click detected: source=${source}, file=${file.path}`);
    
    evt.preventDefault();
    evt.stopPropagation();
    
    this.pendingClick = {
      source,
      file,
      timestamp: Date.now()
    };
    
    this.handleSourceClick(source, file, 'double');
  };

  /**
   * Handle tab header double-click (make permanent)
   */
  private handleHeaderDoubleClick = (evt: MouseEvent) => {
    const target = evt.target as HTMLElement;
    const tabHeader = target.closest('.workspace-tab-header');
    if (!tabHeader) return;
    
    // Find which leaf this header belongs to
    for (const [panel, leaf] of this.previewByPanel.entries()) {
      if (this.getTabHeaderEl(leaf) === tabHeader) {
        evt.preventDefault();
        evt.stopPropagation();
        this.promoteToPermament(leaf);
        console.log("[PreviewPlugin] Tab header double-click - promoted to permanent");
        return;
      }
    }
  };

  /**
   * Handle input in title (makes permanent)
   */
  private handleInput = (evt: Event) => {
    const target = evt.target as HTMLElement;
    if (target.closest('.view-header') || target.classList.contains('inline-title')) {
      const leaf = this.getLeafFromDom(target);
      if (leaf && this.isPanelPreviewLeaf(leaf)) {
        this.promoteToPermament(leaf);
        console.log("[PreviewPlugin] Title edit - promoted to permanent");
      }
    }
  };

  /**
   * Central handler for click behavior
   * 
   * Default policy (applies to ALL sources including community plugins):
   * - Single click = preview (reuse empty/preview, preserve permanent)
   * - Double click = permanent
   * 
   * Special policy (opt-in via settings):
   * - Link panes (backlinks/outgoing): promote current preview before opening new
   */
  private async handleSourceClick(
    source: ClickSource, 
    file: TFile, 
    clickType: 'single' | 'double'
  ): Promise<void> {
    const activeLeaf = this.app.workspace.getLeaf(false);
    if (!activeLeaf) return;
    
    const currentState = this.getCurrentTabState(activeLeaf);
    const panel = this.getPanelParent(activeLeaf);
    
    console.log(`[PreviewPlugin] Handling ${clickType} click: source=${source}, state=${currentState}`);
    
    // Double click always means permanent
    if (clickType === 'double') {
      await this.handleDoubleClickOpen(activeLeaf, file, currentState, panel);
      return;
    }
    
    // Single click - check for special policy first
    const useLinkPanePolicy = 
      this.settings.promoteLinkPanePreview && 
      (source === 'backlink' || source === 'outgoing');
    
    if (useLinkPanePolicy && currentState === 'preview') {
      // Special: promote current preview, then open new preview
      console.log("[PreviewPlugin] Link pane policy: promoting current preview");
      this.promoteToPermament(activeLeaf);
      await this.openInNewTabAsPreview(activeLeaf, file, panel);
    } else {
      // Default policy for all sources
      await this.handleDefaultPreviewClick(activeLeaf, file, currentState, panel);
    }
  }

  /**
   * Default preview click behavior (universal for all sources)
   * - Empty tab: use it, mark as preview
   * - Preview tab: reuse it
   * - Permanent tab: preserve, create new preview
   */
  private async handleDefaultPreviewClick(
    activeLeaf: WorkspaceLeaf,
    file: TFile,
    currentState: TabState,
    panel: LeafParent | null
  ): Promise<void> {
    // Check for duplicate in same panel
    if (panel && this.settings.jumpToDuplicate) {
      const existing = this.findLeafWithFileInPanel(file, panel);
      if (existing && existing !== activeLeaf) {
        console.log("[PreviewPlugin] Jumping to existing tab");
        this.app.workspace.setActiveLeaf(existing, { focus: true });
        return;
      }
    }
    
    switch (currentState) {
      case 'empty':
        await this.openInCurrentTabAsPreview(activeLeaf, file, panel);
        break;
        
      case 'preview':
        await this.openInCurrentTabAsPreview(activeLeaf, file, panel);
        break;
        
      case 'permanent':
        await this.openInNewTabAsPreview(activeLeaf, file, panel);
        break;
    }
  }

  /**
   * Double click opens as permanent
   */
  private async handleDoubleClickOpen(
    activeLeaf: WorkspaceLeaf,
    file: TFile,
    currentState: TabState,
    panel: LeafParent | null
  ): Promise<void> {
    // Check for duplicate
    if (panel && this.settings.jumpToDuplicate) {
      const existing = this.findLeafWithFileInPanel(file, panel);
      if (existing && existing !== activeLeaf) {
        console.log("[PreviewPlugin] Double-click: jumping to existing and making permanent");
        this.app.workspace.setActiveLeaf(existing, { focus: true });
        this.promoteToPermament(existing);
        return;
      }
    }
    
    // Same file in current tab - just promote
    if (this.getLeafFilePath(activeLeaf) === file.path) {
      console.log("[PreviewPlugin] Double-click same file - promoting");
      this.promoteToPermament(activeLeaf);
      return;
    }
    
    switch (currentState) {
      case 'empty':
      case 'preview':
        // Use current tab as permanent
        await this.openInCurrentTabAsPermanent(activeLeaf, file, panel);
        break;
        
      case 'permanent':
        // Preserve, create new permanent tab
        await this.openInNewTabAsPermanent(activeLeaf, file, panel);
        break;
    }
  }

  /* ======================== Strategy B: File Open Handler ======================== */

  /**
   * Handle file-open events not triggered by our click handlers
   * This covers: Quick Switcher, Command Palette, Daily Notes, etc.
   * Also handles backlink/outgoing clicks where we couldn't extract the file
   */
  private handleFileOpen = async (file: TFile | null): Promise<void> => {
    this.isProcessingOpen = true;

    try {
      if (!file) {
        await this.handleNonFileViewOpen();
        return;
      }

      const activeLeaf = this.app.workspace.getLeaf(false);
      if (!activeLeaf) return;

      const previousState = this.leafHistory.get(activeLeaf);
      const isNewFile = this.newlyCreatedFiles.has(file.path);
      
      // DEBUG: Log pendingClick state
      console.log("[PreviewPlugin] pendingClick state:", {
        exists: !!this.pendingClick,
        source: this.pendingClick?.source,
        file: this.pendingClick?.file?.path ?? 'null',
        timestamp: this.pendingClick?.timestamp,
        timeSinceClick: this.pendingClick ? Date.now() - this.pendingClick.timestamp : 'N/A'
      });
      
      // Check if this was a backlink/outgoing click that we detected but couldn't extract file
      const wasLinkPaneClick = this.pendingClick && 
                               (this.pendingClick.source === 'backlink' || this.pendingClick.source === 'outgoing') &&
                               Date.now() - this.pendingClick.timestamp < 1000;  // Increased to 1000ms for testing
      
      console.log("[PreviewPlugin] Strategy B - file-open:", {
        file: file.path,
        isNewFile,
        wasLinkPaneClick,
        pendingClickSource: this.pendingClick?.source,
        previousState: previousState ? {
          path: previousState.path,
          isPermanent: previousState.isPermanent,
          isPreview: previousState.isPreview,
          isEmpty: previousState.isEmpty
        } : 'none'
      });

      // Handle backlink/outgoing clicks with special policy
      if (wasLinkPaneClick) {
        console.log("[PreviewPlugin] ★★★ Handling as link pane click");
        await this.handleLinkPaneFileOpen(activeLeaf, file, previousState);
        this.pendingClick = null;
        return;
      }

      // Skip if this was handled by Strategy A (file was extracted)
      if (this.pendingClick && 
          this.pendingClick.file && 
          Date.now() - this.pendingClick.timestamp < 500) {
        console.log("[PreviewPlugin] Already handled by Strategy A, skipping");
        this.pendingClick = null;
        return;
      }

      // Check if permanent tab was hijacked
      if (this.wasTabHijacked(activeLeaf, previousState, file)) {
        await this.restoreHijackedTab(activeLeaf, previousState!, file, isNewFile);
        return;
      }

      // New file = permanent tab
      if (isNewFile) {
        console.log("[PreviewPlugin] New file - marking as permanent");
        this.promoteToPermament(activeLeaf);
        return;
      }

      // Existing file opened via non-click path = preview
      const currentState = this.getCurrentTabState(activeLeaf);
      if (currentState === 'empty' || currentState === 'preview') {
        this.markAsPreview(activeLeaf);
      }
      // If permanent, leave as is (shouldn't happen if hijack detection works)
      
      this.captureLeafState(activeLeaf);

    } finally {
      setTimeout(() => {
        this.isProcessingOpen = false;
      }, 100);
    }
  };

  /**
   * Handle file open from backlink/outgoing pane click
   * Special policy: promote current preview, open new preview
   */
  private async handleLinkPaneFileOpen(
    activeLeaf: WorkspaceLeaf,
    file: TFile,
    _previousState: LeafState | undefined  // This might be stale, use pendingClick.activeLeafState instead
  ): Promise<void> {
    const panel = this.getPanelParent(activeLeaf);
    
    // Use the state captured at click time, not the current state
    const clickTimeState = this.pendingClick?.activeLeafState;
    
    console.log("[PreviewPlugin] Link pane file open:", {
      currentLeafPath: this.getLeafFilePath(activeLeaf),
      newFilePath: file.path,
      clickTimeState: clickTimeState ? {
        path: clickTimeState.path,
        isPermanent: clickTimeState.isPermanent,
        isPreview: clickTimeState.isPreview,
        isEmpty: clickTimeState.isEmpty
      } : 'none'
    });

    // If we don't have click time state, fall back to marking as preview
    if (!clickTimeState) {
      console.log("[PreviewPlugin] No click time state - marking as preview");
      this.markAsPreview(activeLeaf);
      this.captureLeafState(activeLeaf);
      return;
    }

    // Check for duplicate
    if (panel && this.settings.jumpToDuplicate) {
      const existing = this.findLeafWithFileInPanel(file, panel);
      if (existing && existing !== activeLeaf) {
        console.log("[PreviewPlugin] Jumping to existing tab");
        this.app.workspace.setActiveLeaf(existing, { focus: true });
        this.captureLeafState(activeLeaf);
        return;
      }
    }

    // The file is already open in activeLeaf by Obsidian
    // We need to decide based on what the tab WAS at click time
    
    if (clickTimeState.isPermanent) {
      // Was permanent at click time - restore and open in new tab
      console.log("[PreviewPlugin] Was permanent - restoring and opening new preview");
      
      if (clickTimeState.path && clickTimeState.path !== file.path) {
        const oldFile = this.app.vault.getAbstractFileByPath(clickTimeState.path);
        if (oldFile instanceof TFile) {
          this.internalOpenPaths.add(oldFile.path);
          await activeLeaf.openFile(oldFile);
          this.promoteToPermament(activeLeaf);
          
          // Open clicked file in new preview
          await this.openInNewTabAsPreview(activeLeaf, file, panel);
          return;
        }
      }
      // Can't restore or same file - just mark as preview
      this.markAsPreview(activeLeaf);
      this.captureLeafState(activeLeaf);
      
    } else if (clickTimeState.isPreview && this.settings.promoteLinkPanePreview) {
      // Was preview at click time - promote old content and open new preview
      console.log("[PreviewPlugin] Was preview - promoting old and opening new preview");
      
      if (clickTimeState.path && clickTimeState.path !== file.path) {
        const oldFile = this.app.vault.getAbstractFileByPath(clickTimeState.path);
        if (oldFile instanceof TFile) {
          this.internalOpenPaths.add(oldFile.path);
          await activeLeaf.openFile(oldFile);
          this.promoteToPermament(activeLeaf);
          
          await this.openInNewTabAsPreview(activeLeaf, file, panel);
          return;
        }
      }
      // Can't restore or same file - just mark as preview
      this.markAsPreview(activeLeaf);
      this.captureLeafState(activeLeaf);
      
    } else {
      // Was empty or preview without promotion setting - just mark as preview
      console.log("[PreviewPlugin] Was empty/preview - marking as preview");
      this.markAsPreview(activeLeaf);
      this.captureLeafState(activeLeaf);
    }
  }

  /**
   * Detect if a permanent tab was hijacked
   */
  private wasTabHijacked(
    leaf: WorkspaceLeaf,
    previousState: LeafState | undefined,
    newFile: TFile
  ): boolean {
    if (!previousState) return false;
    
    // Permanent tab with different file = hijacked
    if (previousState.isPermanent && 
        previousState.path && 
        previousState.path !== newFile.path) {
      console.log("[PreviewPlugin] HIJACK DETECTED:", {
        was: previousState.path,
        now: newFile.path
      });
      return true;
    }
    
    return false;
  }

  /**
   * Restore a hijacked permanent tab
   */
  private async restoreHijackedTab(
    hijackedLeaf: WorkspaceLeaf,
    previousState: LeafState,
    newFile: TFile,
    isNewFile: boolean
  ): Promise<void> {
    console.log("[PreviewPlugin] Restoring hijacked tab...");
    
    // Step 1: Restore original content
    const oldFile = this.app.vault.getAbstractFileByPath(previousState.path!);
    if (oldFile instanceof TFile) {
      this.internalOpenPaths.add(oldFile.path);
      await hijackedLeaf.openFile(oldFile);
      this.promoteToPermament(hijackedLeaf);
    }

    // Step 2: Open new file in appropriate tab
    const panel = this.getPanelParent(hijackedLeaf);
    
    if (isNewFile) {
      // New file = new permanent tab
      await this.openInNewTabAsPermanent(hijackedLeaf, newFile, panel);
    } else {
      // Existing file = preview
      await this.openInNewTabAsPreview(hijackedLeaf, newFile, panel);
    }
  }

  /**
   * Handle non-file view opens (graph, canvas, etc.)
   */
  private async handleNonFileViewOpen(): Promise<void> {
    const leaf = this.app.workspace.getLeaf(false);
    if (!leaf) return;

    const previousState = this.leafHistory.get(leaf);
    const viewType = leaf.view.getViewType();
    
    // Empty tab is neutral - don't mark as preview
    if (viewType === 'empty') {
      this.captureLeafState(leaf);
      return;
    }
    
    // If was permanent, need to restore and open view in new tab
    if (previousState?.isPermanent && previousState.path) {
      const oldFile = this.app.vault.getAbstractFileByPath(previousState.path);
      if (oldFile instanceof TFile) {
        // This is complex - for now, just mark as preview
        // TODO: Proper handling in Phase 3
        console.log("[PreviewPlugin] Non-file view opened in permanent tab - marking as preview");
      }
    }
    
    this.markAsPreview(leaf);
    this.captureLeafState(leaf);
  }

  /* ======================== Tab Operations ======================== */

  /**
   * Open file in current tab as preview
   */
  private async openInCurrentTabAsPreview(
    leaf: WorkspaceLeaf, 
    file: TFile,
    panel: LeafParent | null
  ): Promise<void> {
    // Handle old preview promotion if needed
    if (panel && this.settings.promoteOldPreview) {
      const oldPreview = this.previewByPanel.get(panel);
      if (oldPreview && oldPreview !== leaf && this.isLeafStillPresent(oldPreview)) {
        this.promoteToPermament(oldPreview);
      }
    }
    
    this.internalOpenPaths.add(file.path);
    await leaf.openFile(file);
    this.markAsPreview(leaf);
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    this.captureLeafState(leaf);
  }

  /**
   * Open file in current tab as permanent
   */
  private async openInCurrentTabAsPermanent(
    leaf: WorkspaceLeaf,
    file: TFile,
    panel: LeafParent | null
  ): Promise<void> {
    this.internalOpenPaths.add(file.path);
    await leaf.openFile(file);
    this.promoteToPermament(leaf);
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    this.captureLeafState(leaf);
  }

  /**
   * Create new tab and open file as preview
   */
  private async openInNewTabAsPreview(
    baseLeaf: WorkspaceLeaf,
    file: TFile,
    panel: LeafParent | null
  ): Promise<void> {
    // Try to find existing preview to reuse
    if (panel) {
      const existingPreview = this.previewByPanel.get(panel);
      if (existingPreview && 
          existingPreview !== baseLeaf && 
          this.isLeafStillPresent(existingPreview)) {
        this.internalOpenPaths.add(file.path);
        await existingPreview.openFile(file);
        this.markAsPreview(existingPreview);
        this.app.workspace.setActiveLeaf(existingPreview, { focus: true });
        this.captureLeafState(existingPreview);
        return;
      }
    }
    
    // Create new tab
    const newLeaf = this.createNewLeafInPanel(baseLeaf);
    if (!newLeaf) return;
    
    this.internalOpenPaths.add(file.path);
    await newLeaf.openFile(file);
    this.markAsPreview(newLeaf);
    this.app.workspace.setActiveLeaf(newLeaf, { focus: true });
    this.captureLeafState(newLeaf);
  }

  /**
   * Create new tab and open file as permanent
   */
  private async openInNewTabAsPermanent(
    baseLeaf: WorkspaceLeaf,
    file: TFile,
    panel: LeafParent | null
  ): Promise<void> {
    const newLeaf = this.createNewLeafInPanel(baseLeaf);
    if (!newLeaf) return;
    
    this.internalOpenPaths.add(file.path);
    await newLeaf.openFile(file);
    this.promoteToPermament(newLeaf);
    this.app.workspace.setActiveLeaf(newLeaf, { focus: true });
    this.captureLeafState(newLeaf);
  }

  /* ======================== Preview/Permanent Marking ======================== */

  /**
   * Mark a leaf as preview tab
   * Note: Empty tabs are neutral (not preview, not permanent)
   */
  private markAsPreview(leaf: WorkspaceLeaf): void {
    // Empty tabs should not be marked as preview
    if (leaf.view.getViewType() === 'empty') return;
    
    const panel = this.getPanelParent(leaf);
    if (!panel) return;
    
    this.previewByPanel.set(panel, leaf);
    
    if (this.settings.useItalicTitle) {
      const header = this.getTabHeaderEl(leaf);
      if (header) header.classList.add(PREVIEW_CLASS);
    }
    
    this.captureLeafState(leaf);
  }

  /**
   * Promote a leaf to permanent (remove preview status)
   */
  private promoteToPermament(leaf: WorkspaceLeaf): void {
    const panel = this.getPanelParent(leaf);
    if (panel && this.previewByPanel.get(panel) === leaf) {
      this.previewByPanel.delete(panel);
    }
    
    const header = this.getTabHeaderEl(leaf);
    if (header) header.classList.remove(PREVIEW_CLASS);
    
    this.captureLeafState(leaf);
  }

  /* ======================== Utility Functions ======================== */

  private resolveToFile(candidate: string | null): TFile | null {
    if (!candidate) return null;
    
    // Try direct path
    const byPath = this.app.vault.getAbstractFileByPath(candidate);
    if (byPath instanceof TFile) return byPath;
    
    // Try as link
    const byLink = this.app.metadataCache.getFirstLinkpathDest(candidate, "");
    if (byLink instanceof TFile) return byLink;
    
    return null;
  }

  private getLeafFromDom(target: HTMLElement): WorkspaceLeaf | null {
    const content = target.closest('.workspace-leaf-content');
    if (!content) return null;
    
    let found: WorkspaceLeaf | null = null;
    this.app.workspace.iterateAllLeaves(leaf => {
      if (found) return;
      if ((leaf.view as any).containerEl === content) found = leaf;
    });
    return found;
  }

  private getPanelParent(leaf: WorkspaceLeaf): LeafParent | null {
    const parent = (leaf as any).parent;
    return (parent && Array.isArray(parent.children)) ? parent : null;
  }

  private isPanelPreviewLeaf(leaf: WorkspaceLeaf): boolean {
    const panel = this.getPanelParent(leaf);
    return !!panel && this.previewByPanel.get(panel) === leaf;
  }

  private cleanupPreviewMap(): void {
    for (const [panel, leaf] of this.previewByPanel.entries()) {
      if (!this.isLeafStillPresent(leaf)) {
        this.previewByPanel.delete(panel);
      }
    }
  }

  private isLeafStillPresent(leaf: WorkspaceLeaf): boolean {
    let found = false;
    this.app.workspace.iterateAllLeaves(l => { if (l === leaf) found = true; });
    return found;
  }

  private getLeafFilePath(leaf: WorkspaceLeaf): string | null {
    const view = leaf.view;
    if (view instanceof FileView && view.file) return view.file.path;
    return null;
  }

  private getTabHeaderEl(leaf: WorkspaceLeaf): HTMLElement | null {
    return (leaf as any).tabHeaderEl ?? null;
  }

  private findLeafWithFileInPanel(file: TFile, panel: LeafParent): WorkspaceLeaf | null {
    let found: WorkspaceLeaf | null = null;
    this.app.workspace.iterateAllLeaves(leaf => {
      if (found) return;
      if (this.getPanelParent(leaf) === panel && this.getLeafFilePath(leaf) === file.path) {
        found = leaf;
      }
    });
    return found;
  }

  private findLeafByFile(file: TFile): WorkspaceLeaf | null {
    let found: WorkspaceLeaf | null = null;
    this.app.workspace.iterateAllLeaves(leaf => {
      if (found) return;
      if (this.getLeafFilePath(leaf) === file.path) found = leaf;
    });
    return found;
  }

  private createNewLeafInPanel(baseLeaf: WorkspaceLeaf): WorkspaceLeaf | null {
    const panel = this.getPanelParent(baseLeaf);
    if (!panel) return null;
    
    const ws = this.app.workspace as ExtendedWorkspace;
    const idx = panel.children.indexOf(baseLeaf as unknown as WorkspaceItem);
    const insertIdx = this.settings.openNewTabAtEnd ? panel.children.length : idx + 1;
    
    try {
      return ws.createLeafInParent(panel, insertIdx);
    } catch (e) {
      console.error("[PreviewPlugin] Failed to create leaf:", e);
      return null;
    }
  }
}

/* ======================== Settings Tab ======================== */

class PreviewModeSettingTab extends PluginSettingTab {
  plugin: PreviewModePlugin;
  
  constructor(app: App, plugin: PreviewModePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    
    new Setting(containerEl)
      .setName("Italic title")
      .setDesc("Show preview tabs with italic title")
      .addToggle(t => t
        .setValue(this.plugin.settings.useItalicTitle)
        .onChange(async v => {
          this.plugin.settings.useItalicTitle = v;
          await this.plugin.saveSettings();
        }));
    
    new Setting(containerEl)
      .setName("Reuse empty tab")
      .setDesc("Reuse empty tabs for preview")
      .addToggle(t => t
        .setValue(this.plugin.settings.reuseEmptyTab)
        .onChange(async v => {
          this.plugin.settings.reuseEmptyTab = v;
          await this.plugin.saveSettings();
        }));
    
    new Setting(containerEl)
      .setName("Promote old preview")
      .setDesc("Convert old preview to permanent when new preview opens")
      .addToggle(t => t
        .setValue(this.plugin.settings.promoteOldPreview)
        .onChange(async v => {
          this.plugin.settings.promoteOldPreview = v;
          await this.plugin.saveSettings();
        }));
    
    new Setting(containerEl)
      .setName("Focus existing tab")
      .setDesc("Jump to existing tab if file is already open")
      .addToggle(t => t
        .setValue(this.plugin.settings.jumpToDuplicate)
        .onChange(async v => {
          this.plugin.settings.jumpToDuplicate = v;
          await this.plugin.saveSettings();
        }));
    
    new Setting(containerEl)
      .setName("Open new tab at end")
      .setDesc("Open new tabs at the end of tab list")
      .addToggle(t => t
        .setValue(this.plugin.settings.openNewTabAtEnd)
        .onChange(async v => {
          this.plugin.settings.openNewTabAtEnd = v;
          await this.plugin.saveSettings();
        }));
    
    new Setting(containerEl)
      .setName("Promote preview on link navigation")
      .setDesc("When clicking links in Backlinks/Outgoing panes, promote current preview to permanent before opening new preview (enables link chain navigation)")
      .addToggle(t => t
        .setValue(this.plugin.settings.promoteLinkPanePreview)
        .onChange(async v => {
          this.plugin.settings.promoteLinkPanePreview = v;
          await this.plugin.saveSettings();
        }));
  }
}