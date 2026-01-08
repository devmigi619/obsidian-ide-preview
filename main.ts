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
 * REFACTORED v2 - Event-driven Architecture
 * 
 * Core Philosophy: Let Obsidian open files, then REACT and FIX
 * 
 * Strategy A: Minimal intervention (double-click flag only)
 * Strategy B: Main logic (detect hijack, restore, redirect)
 * 
 * Key: Permanent tabs are SACRED - if hijacked, immediately restore
 */

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
}

const DEFAULT_SETTINGS: PreviewModeSettings = {
  useItalicTitle: true,
  reuseEmptyTab: true,
  promoteOldPreview: true,
  jumpToDuplicate: true,
  openNewTabAtEnd: false,
};

const PREVIEW_CLASS = "is-preview-tab";

type LeafState = {
  path: string | null;
  isPreview: boolean;
  isPermanent: boolean;
  isEmpty: boolean;
  viewType: string;
};

export default class PreviewModePlugin extends Plugin {
  settings: PreviewModeSettings;

  private previewByPanel = new Map<LeafParent, WorkspaceLeaf>();
  private leafHistory = new WeakMap<WorkspaceLeaf, LeafState>();
  
  // Click tracking - removed, not needed anymore
  private clickIntent: 'single' | 'double' | null = null;
  private clickFile: string | null = null;
  private clickTimestamp = 0;
  
  // New file tracking
  private newlyCreatedFiles = new Set<string>();
  
  // Processing guard
  private isProcessingOpen = false;
  private internalOpenPaths = new Set<string>();

  async onload() {
    console.log("[PreviewPlugin] v2 - Event-driven Architecture");
    await this.loadSettings();
    this.addSettingTab(new PreviewModeSettingTab(this.app, this));

    // Strategy A: Double-click detection ONLY (single click는 Obsidian에 맡김)
    this.registerDomEvent(document, "dblclick", this.handleDblClick, true);
    
    // Tab header double-click (make permanent)
    this.registerDomEvent(document, "dblclick", this.handleHeaderDblClick, true);
    
    // Input (title edit makes permanent)
    this.registerDomEvent(document, "input", this.handleInput, true);

    // State tracking
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf) this.captureLeafState(leaf);
      })
    );

    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        const leaf = this.findLeafHoldingFile(file as TFile);
        if (leaf) this.captureLeafState(leaf);
      })
    );

    // Track new file creation
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        this.newlyCreatedFiles.add(file.path);
        setTimeout(() => {
          this.newlyCreatedFiles.delete(file.path);
        }, 5000);
      })
    );

    // File rename makes permanent
    this.registerEvent(
      this.app.vault.on("rename", (file) => {
        if (!(file instanceof TFile)) return;
        this.app.workspace.iterateAllLeaves((leaf) => {
          if (this.getLeafFilePath(leaf) === file.path && this.isPanelPreviewLeaf(leaf)) {
            this.markAsPermanent(leaf);
            this.captureLeafState(leaf);
          }
        });
      })
    );

    // Editor change makes permanent
    this.registerEvent(
      this.app.workspace.on("editor-change", (_editor, info) => {
        const leaf = (info as any)?.leaf;
        if (leaf && this.isPanelPreviewLeaf(leaf)) {
          this.markAsPermanent(leaf);
          this.captureLeafState(leaf);
        }
      })
    );

    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.cleanupPreviewMap();
        this.app.workspace.iterateAllLeaves(leaf => this.captureLeafState(leaf));
      })
    );

    // Strategy B: Main logic - react to file opens
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (this.isProcessingOpen) return;
        
        // Skip if we opened this internally
        if (file instanceof TFile && this.internalOpenPaths.has(file.path)) {
          this.internalOpenPaths.delete(file.path);
          const leaf = this.findLeafHoldingFile(file);
          if (leaf) this.captureLeafState(leaf);
          return;
        }

        this.handleFileOpen(file);
      })
    );

    // Initialize state for all leaves
    this.app.workspace.iterateAllLeaves(leaf => this.captureLeafState(leaf));
  }

  onunload() {
    document.querySelectorAll(`.${PREVIEW_CLASS}`).forEach((el) => el.classList.remove(PREVIEW_CLASS));
    this.previewByPanel.clear();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  
  async saveSettings() {
    await this.saveData(this.settings);
  }

  /* ------------------------ State Management ------------------------ */

  private captureLeafState = (leaf: WorkspaceLeaf) => {
    const path = this.getLeafFilePath(leaf);
    const isPreview = this.isPanelPreviewLeaf(leaf);
    const isPermanent = !isPreview && leaf.view.getViewType() !== "empty";
    const isEmpty = leaf.view.getViewType() === "empty";
    const viewType = leaf.view.getViewType();
    
    this.leafHistory.set(leaf, { path, isPreview, isPermanent, isEmpty, viewType });
  }

  /* ------------------------ Strategy A: Gesture Detection ------------------------ */

  private handleDblClick = (evt: MouseEvent) => {
    const target = evt.target as HTMLElement;
    const file = this.extractFileFromClick(target);
    if (!file) return;

    // Don't interfere with modifier keys
    if (evt.ctrlKey || evt.metaKey || evt.shiftKey) return;

    // PREVENT Obsidian from handling this - we'll do it ourselves
    evt.preventDefault();
    evt.stopPropagation();
    
    console.log("[PreviewPlugin] ★★★ Double-click detected:", file.path, "- handling directly");
    
    // Handle immediately without waiting for file-open
    this.handleDoubleClickDirect(file);
  };

  private handleDoubleClickDirect = async (file: TFile) => {
    const activeLeaf = this.app.workspace.getLeaf(false);
    if (!activeLeaf) return;

    const currentPath = this.getLeafFilePath(activeLeaf);
    const panel = this.getPanelParent(activeLeaf);
    
    // Check for duplicate in panel
    if (panel && this.settings.jumpToDuplicate) {
      const existing = this.findLeafWithFileInPanel(file, panel);
      if (existing && existing !== activeLeaf) {
        console.log("[PreviewPlugin] Jumping to existing tab");
        this.app.workspace.setActiveLeaf(existing, { focus: true });
        this.markAsPermanent(existing);
        this.captureLeafState(existing);
        return;
      }
    }

    // If it's the same file in current leaf, just promote to permanent
    if (currentPath === file.path) {
      console.log("[PreviewPlugin] Same file - promoting to permanent");
      this.markAsPermanent(activeLeaf);
      this.captureLeafState(activeLeaf);
      return;
    }

    // Different file - check if we need to open in new tab
    const currentState = this.getCurrentTabState(activeLeaf);
    
    if (currentState === 'permanent') {
      // Open in new permanent tab
      console.log("[PreviewPlugin] Opening in new permanent tab");
      const newLeaf = this.createNewLeafInPanelOrNull(activeLeaf);
      if (newLeaf) {
        this.internalOpenPaths.add(file.path);
        await newLeaf.openFile(file);
        this.app.workspace.setActiveLeaf(newLeaf, { focus: true });
        this.markAsPermanent(newLeaf);
        this.captureLeafState(newLeaf);
      }
    } else {
      // Use current tab as permanent
      console.log("[PreviewPlugin] Using current tab as permanent");
      this.internalOpenPaths.add(file.path);
      await activeLeaf.openFile(file);
      this.markAsPermanent(activeLeaf);
      this.captureLeafState(activeLeaf);
    }
  };

  private handleHeaderDblClick = (evt: MouseEvent) => {
    const target = evt.target as HTMLElement;
    const tabHeader = target.closest(".workspace-tab-header");
    if (!tabHeader) return;
    
    for (const [, leaf] of this.previewByPanel.entries()) {
      if (this.getTabHeaderEl(leaf) === tabHeader) {
        evt.preventDefault();
        evt.stopPropagation();
        this.markAsPermanent(leaf);
        this.captureLeafState(leaf);
        return;
      }
    }
  };

  private handleInput = (evt: Event) => {
    const target = evt.target as HTMLElement;
    if (target.closest(".view-header") || target.classList.contains("inline-title")) {
      const leaf = this.getLeafFromDom(target);
      if (leaf && this.isPanelPreviewLeaf(leaf)) {
        this.markAsPermanent(leaf);
        this.captureLeafState(leaf);
      }
    }
  };

  /* ------------------------ Strategy B: File Open Handler (Main Logic) ------------------------ */

  private handleFileOpen = async (file: TFile | null) => {
    this.isProcessingOpen = true;

    try {
      if (!file) {
        // Non-file view (graph, canvas, etc.)
        await this.handleNonFileView();
        return;
      }

      const activeLeaf = this.app.workspace.getLeaf(false);
      if (!activeLeaf) return;

      // Get the state BEFORE this open
      const previousState = this.leafHistory.get(activeLeaf);
      
      // Detect what just happened
      const isNewFile = this.newlyCreatedFiles.has(file.path);
      const isDailyNote = this.isDailyNoteFile(file);
      
      console.log("[PreviewPlugin] ►►► File open:", {
        file: file.path,
        isNewFile,
        isDailyNote
      });
      
      // Determine what the user wanted
      const userIntent = this.determineUserIntent(isNewFile, isDailyNote);
      
      // Check if permanent tab was hijacked
      const wasHijacked = this.wasTabHijacked(activeLeaf, previousState, file);

      if (wasHijacked) {
        // CRITICAL: Permanent tab was hijacked - restore immediately
        await this.restoreHijackedTab(activeLeaf, previousState!, file, userIntent);
      } else {
        // Normal flow - apply intent
        await this.applyIntent(activeLeaf, file, userIntent, previousState);
      }

    } finally {
      setTimeout(() => {
        this.isProcessingOpen = false;
      }, 100);
    }
  }

  private determineUserIntent(
    isNewFile: boolean,
    isDailyNote: boolean
  ): 'new-note' | 'daily-note' | 'preview' {
    if (isNewFile) {
      if (isDailyNote) return 'daily-note';
      return 'new-note';
    }
    // Everything else is preview by default (single click, quick switcher, etc.)
    return 'preview';
  }

  private wasTabHijacked(
    leaf: WorkspaceLeaf,
    previousState: LeafState | undefined,
    newFile: TFile
  ): boolean {
    if (!previousState) {
      console.log("[PreviewPlugin] No previous state - not hijacked");
      return false;
    }
    
    console.log("[PreviewPlugin] Checking hijack:", {
      wasPermanent: previousState.isPermanent,
      oldPath: previousState.path,
      newPath: newFile.path,
      pathChanged: previousState.path !== newFile.path
    });
    
    // If it was a permanent tab with a different file, it's hijacked
    if (previousState.isPermanent && previousState.path && previousState.path !== newFile.path) {
      console.log("[PreviewPlugin] 🚨 HIJACK DETECTED! Permanent tab was changed");
      return true;
    }
    
    return false;
  }

  private async restoreHijackedTab(
    hijackedLeaf: WorkspaceLeaf,
    previousState: LeafState,
    newFile: TFile,
    userIntent: 'new-note' | 'daily-note' | 'preview'
  ) {
    console.log("[PreviewPlugin] 🔧 RESTORING hijacked tab...");
    
    // Step 1: Restore the hijacked tab to its original content
    const oldFile = this.app.vault.getAbstractFileByPath(previousState.path!);
    if (oldFile instanceof TFile) {
      console.log("[PreviewPlugin] Restoring old file:", oldFile.path);
      this.internalOpenPaths.add(oldFile.path);
      await hijackedLeaf.openFile(oldFile);
      this.markAsPermanent(hijackedLeaf);
      this.captureLeafState(hijackedLeaf);
    }

    // Step 2: Open the new file in appropriate tab
    console.log("[PreviewPlugin] Opening new file in new tab:", newFile.path, "with intent:", userIntent);
    await this.openInNewTab(hijackedLeaf, newFile, userIntent);
  }

  private async openInNewTab(
    baseLeaf: WorkspaceLeaf,
    file: TFile,
    intent: 'new-note' | 'daily-note' | 'permanent' | 'preview'
  ) {
    const panel = this.getPanelParent(baseLeaf);
    
    // Check for existing preview we can reuse (only for preview intent)
    if (intent === 'preview' && panel) {
      const existingPreview = this.previewByPanel.get(panel);
      if (existingPreview && this.isLeafStillPresent(existingPreview)) {
        this.internalOpenPaths.add(file.path);
        await existingPreview.openFile(file);
        this.app.workspace.setActiveLeaf(existingPreview, { focus: true });
        this.markAsPreview(existingPreview);
        this.captureLeafState(existingPreview);
        return;
      }
    }

    // Create new tab
    const newLeaf = this.createNewLeafInPanelOrNull(baseLeaf);
    if (newLeaf) {
      this.internalOpenPaths.add(file.path);
      await newLeaf.openFile(file);
      this.app.workspace.setActiveLeaf(newLeaf, { focus: true });
      
      if (intent === 'preview') {
        this.markAsPreview(newLeaf);
      } else {
        this.markAsPermanent(newLeaf);
      }
      this.captureLeafState(newLeaf);
    }
  }

  private async applyIntent(
    leaf: WorkspaceLeaf,
    file: TFile,
    intent: 'new-note' | 'daily-note' | 'preview',
    previousState: LeafState | undefined
  ) {
    const wasEmpty = previousState?.isEmpty ?? leaf.view.getViewType() === "empty";
    const wasPreview = previousState?.isPreview ?? false;

    if (intent === 'new-note' || intent === 'daily-note') {
      // New notes always open as permanent
      if (wasEmpty) {
        // Use empty tab
        this.markAsPermanent(leaf);
        this.captureLeafState(leaf);
      } else if (wasPreview) {
        // Preview becomes permanent, new note in new permanent tab
        this.markAsPermanent(leaf);
        this.captureLeafState(leaf);
        await this.openInNewTab(leaf, file, 'permanent');
      } else {
        // This shouldn't happen if hijack detection works
        // But just in case, create new tab
        await this.openInNewTab(leaf, file, 'permanent');
      }
      return;
    }

    // Preview intent (default for single clicks, quick switcher, etc.)
    if (wasEmpty) {
      const panel = this.getPanelParent(leaf);
      const existingPreview = panel ? this.previewByPanel.get(panel) : null;
      
      if (existingPreview && existingPreview !== leaf && this.settings.promoteOldPreview) {
        this.markAsPermanent(existingPreview);
        this.captureLeafState(existingPreview);
      }
      
      this.markAsPreview(leaf);
      this.captureLeafState(leaf);
    } else if (wasPreview) {
      // Reuse preview
      this.markAsPreview(leaf);
      this.captureLeafState(leaf);
    } else {
      // This shouldn't happen - permanent tabs should be caught by hijack detection
      this.markAsPreview(leaf);
      this.captureLeafState(leaf);
    }
  }

  private async handleNonFileView() {
    const leaf = this.app.workspace.getLeaf(false);
    if (!leaf) return;

    const previousState = this.leafHistory.get(leaf);
    const wasEmpty = previousState?.isEmpty ?? leaf.view.getViewType() === "empty";
    const wasPreview = previousState?.isPreview ?? false;
    const wasPermanent = previousState?.isPermanent ?? false;

    if (wasEmpty || wasPreview) {
      // Use current tab as preview
      this.markAsPreview(leaf);
      this.captureLeafState(leaf);
    } else if (wasPermanent) {
      // Permanent tab was hijacked with non-file view
      // Restore old content if possible, or create new tab
      if (previousState?.path) {
        const oldFile = this.app.vault.getAbstractFileByPath(previousState.path);
        if (oldFile instanceof TFile) {
          this.internalOpenPaths.add(oldFile.path);
          await leaf.openFile(oldFile);
          this.markAsPermanent(leaf);
          this.captureLeafState(leaf);
          
          // Open graph view in new preview tab
          const newLeaf = this.createNewLeafInPanelOrNull(leaf);
          if (newLeaf) {
            this.app.workspace.revealLeaf(newLeaf);
            this.markAsPreview(newLeaf);
            this.captureLeafState(newLeaf);
          }
          return;
        }
      }
      
      // Can't restore, just mark current as preview
      this.markAsPreview(leaf);
      this.captureLeafState(leaf);
    }
  }

  private isDailyNoteFile(file: TFile): boolean {
    const datePattern = /^\d{4}-\d{2}-\d{2}/;
    return datePattern.test(file.basename);
  }

  /* ------------------------ Helpers ------------------------ */

  private resolveToFile = (candidate: string | null): TFile | null => {
    if (!candidate) return null;
    const byPath = this.app.vault.getAbstractFileByPath(candidate);
    if (byPath instanceof TFile) return byPath;
    const byLink = this.app.metadataCache.getFirstLinkpathDest(candidate, "");
    if (byLink instanceof TFile) return byLink;
    return null;
  }

  private extractFileFromClick = (target: HTMLElement): TFile | null => {
    const attrKeys = ["data-path", "data-href", "data-file", "data-source-path", "data-resource-path", "data-link"];
    for (const k of attrKeys) {
      const v = target.closest<HTMLElement>(`[${k}]`)?.getAttribute(k);
      const f = this.resolveToFile(v ?? null);
      if (f) return f;
    }
    
    const searchResult = target.closest(".search-result-file-title");
    if (searchResult) {
      const f = this.resolveToFile(searchResult.textContent?.trim() ?? null);
      if (f) return f;
    }
    
    const searchMatch = target.closest(".search-result-file-match");
    if (searchMatch) {
      const container = searchMatch.closest(".search-result-container");
      if (container) {
        const titleEl = container.querySelector(".search-result-file-title");
        if (titleEl) {
          const f = this.resolveToFile(titleEl.textContent?.trim() ?? null);
          if (f) return f;
        }
      }
    }
    
    const a = target.closest<HTMLAnchorElement>("a.internal-link, a.external-link");
    if (a) {
      const href = a.getAttribute("href");
      if (href) {
        const f = this.resolveToFile(href);
        if (f) return f;
      }
    }
    return null;
  }

  private getLeafFromDom = (target: HTMLElement): WorkspaceLeaf | null => {
    let found: WorkspaceLeaf | null = null;
    const content = target.closest(".workspace-leaf-content");
    if (content) {
      this.app.workspace.iterateAllLeaves(l => {
        if (found) return;
        if ((l.view as any).containerEl === content) found = l;
      });
    }
    return found;
  }

  private getPanelParent = (leaf: WorkspaceLeaf): LeafParent | null => {
    const parent = (leaf as any).parent;
    return (parent && Array.isArray(parent.children)) ? parent : null;
  }

  private isPanelPreviewLeaf = (leaf: WorkspaceLeaf): boolean => {
    const panel = this.getPanelParent(leaf);
    return !!panel && this.previewByPanel.get(panel) === leaf;
  }

  private cleanupPreviewMap = () => {
    for (const [panel, leaf] of this.previewByPanel.entries()) {
      if (!this.isLeafStillPresent(leaf)) this.previewByPanel.delete(panel);
    }
  }

  private isLeafStillPresent = (leaf: WorkspaceLeaf): boolean => {
    let found = false;
    this.app.workspace.iterateAllLeaves(l => { if (l === leaf) found = true; });
    return found;
  }

  private getLeafFilePath = (leaf: WorkspaceLeaf): string | null => {
    const view = leaf.view;
    if (view instanceof FileView && view.file) return view.file.path;
    return null;
  }

  private getTabHeaderEl = (leaf: WorkspaceLeaf): HTMLElement | null => {
    return (leaf as any).tabHeaderEl ?? null;
  }

  private markAsPreview = (leaf: WorkspaceLeaf) => {
    const panel = this.getPanelParent(leaf);
    if (!panel) return;
    this.previewByPanel.set(panel, leaf);
    const header = this.getTabHeaderEl(leaf);
    if (header && this.settings.useItalicTitle) header.classList.add(PREVIEW_CLASS);
  }

  private markAsPermanent = (leaf: WorkspaceLeaf) => {
    const panel = this.getPanelParent(leaf);
    if (panel && this.previewByPanel.get(panel) === leaf) {
      this.previewByPanel.delete(panel);
    }
    const header = this.getTabHeaderEl(leaf);
    if (header) header.classList.remove(PREVIEW_CLASS);
  }

  private findLeafWithFileInPanel = (file: TFile, panel: LeafParent): WorkspaceLeaf | null => {
    let found: WorkspaceLeaf | null = null;
    this.app.workspace.iterateAllLeaves(l => {
      if (found) return;
      if (this.getPanelParent(l) === panel && this.getLeafFilePath(l) === file.path) found = l;
    });
    return found;
  }

  private findLeafHoldingFile = (file: TFile): WorkspaceLeaf | null => {
    let found: WorkspaceLeaf | null = null;
    this.app.workspace.iterateAllLeaves(l => {
      if (found) return;
      if (this.getLeafFilePath(l) === file.path) found = l;
    });
    return found;
  }

  private createNewLeafInPanelOrNull = (baseLeaf: WorkspaceLeaf): WorkspaceLeaf | null => {
    const panel = this.getPanelParent(baseLeaf);
    if (!panel) return null;
    const ws = this.app.workspace as ExtendedWorkspace;
    const idx = panel.children.indexOf(baseLeaf as unknown as WorkspaceItem);
    const insertIdx = this.settings.openNewTabAtEnd ? panel.children.length : idx + 1;
    try {
      return ws.createLeafInParent(panel, insertIdx);
    } catch { return null; }
  }
}

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
      .setDesc("Convert old preview to permanent when opening in empty tab")
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
  }
}