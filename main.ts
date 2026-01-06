import { App, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, TFile, Workspace, WorkspaceSplit, WorkspaceItem } from 'obsidian';

// [핵심] 숨겨진 API들을 위한 타입 정의 (any 대체용)
// 1. Workspace에 createLeafInParent 메서드가 있다고 선언
interface ExtendedWorkspace extends Workspace {
    createLeafInParent(parent: WorkspaceItem, index: number): WorkspaceLeaf;
}

// 2. Leaf의 부모(Group)에 접근하기 위한 인터페이스
interface LeafParent {
    children: WorkspaceItem[];
}

// 3. Leaf가 tabHeaderEl과 parent를 가지고 있다고 선언
interface ExtendedLeaf extends WorkspaceLeaf {
    tabHeaderEl: HTMLElement;
    parent: LeafParent;
}

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
    openNewTabAtEnd: false
}

const PREVIEW_CLASS = 'is-preview-tab';

export default class PreviewModePlugin extends Plugin {
    settings: PreviewModeSettings;
    previewLeaf: WorkspaceLeaf | null = null;

    async onload() {
        await this.loadSettings();
        this.addSettingTab(new PreviewModeSettingTab(this.app, this));

        document.addEventListener('click', this.handleClick, true);
        document.addEventListener('dblclick', this.handleDblClick, true);
        document.addEventListener('dblclick', this.handleHeaderDblClick, true);

        this.registerEvent(this.app.workspace.on('editor-change', (editor, info) => {
            const activeLeaf = this.app.workspace.getLeaf(false);
            if (this.previewLeaf === activeLeaf) {
                this.markAsPermanent(activeLeaf);
            }
        }));

        this.registerEvent(this.app.workspace.on('layout-change', () => {
            if (this.previewLeaf) {
                // @ts-ignore
                const exists = this.app.workspace.getLeafById(this.previewLeaf.id);
                if (!exists) {
                    this.previewLeaf = null;
                }
            }
        }));
    }

    onunload() {
        document.removeEventListener('click', this.handleClick, true);
        document.removeEventListener('dblclick', this.handleDblClick, true);
        document.removeEventListener('dblclick', this.handleHeaderDblClick, true);

        document.querySelectorAll(`.${PREVIEW_CLASS}`).forEach(el => {
            el.classList.remove(PREVIEW_CLASS);
        });
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    handleClick = (evt: MouseEvent) => {
        const target = evt.target as HTMLElement;
        const titleEl = target.closest('.nav-file-title');
        if (!titleEl) return;
        if (evt.ctrlKey || evt.metaKey || evt.shiftKey) return;

        const path = titleEl.getAttribute('data-path');
        if (!path) return;
        const file = this.app.vault.getAbstractFileByPath(path);
        
        if (!(file instanceof TFile)) return;

        evt.preventDefault();
        evt.stopPropagation();
        evt.stopImmediatePropagation();

        void this.openFileLogic(file, false);
    }

    handleDblClick = (evt: MouseEvent) => {
        const target = evt.target as HTMLElement;
        const titleEl = target.closest('.nav-file-title');
        if (!titleEl) return;
        
        const path = titleEl.getAttribute('data-path');
        if (!path) return;
        const file = this.app.vault.getAbstractFileByPath(path);
        
        if (!(file instanceof TFile)) return;

        evt.preventDefault();
        evt.stopPropagation();
        evt.stopImmediatePropagation();

        void this.openFileLogic(file, true);
    }

    handleHeaderDblClick = (evt: MouseEvent) => {
        const target = evt.target as HTMLElement;
        const tabHeader = target.closest('.workspace-tab-header');
        
        if (tabHeader && this.previewLeaf) {
             // [수정] ExtendedLeaf 인터페이스 사용
             const extendedLeaf = this.previewLeaf as ExtendedLeaf;
             if (extendedLeaf.tabHeaderEl === tabHeader) {
                evt.preventDefault();
                evt.stopPropagation();
                evt.stopImmediatePropagation();
                this.markAsPermanent(this.previewLeaf);
             }
        }
    }

    async openFileLogic(file: TFile, isDoubleClick: boolean) {
        if (this.settings.jumpToDuplicate) {
            let existingLeaf: WorkspaceLeaf | null = null;
            this.app.workspace.iterateAllLeaves(leaf => {
                // @ts-ignore
                if (leaf.view.file && leaf.view.file.path === file.path) {
                    existingLeaf = leaf;
                }
            });

            if (existingLeaf) {
                this.app.workspace.setActiveLeaf(existingLeaf, { focus: true });
                if (isDoubleClick) this.markAsPermanent(existingLeaf);
                return;
            }
        }

        if (isDoubleClick) {
            // @ts-ignore
            if (this.previewLeaf && this.previewLeaf.view.file && this.previewLeaf.view.file.path === file.path) {
                this.markAsPermanent(this.previewLeaf);
            } else {
                const leaf = this.app.workspace.getLeaf('tab');
                await leaf.openFile(file);
                this.markAsPermanent(leaf);
            }
        } else {
            const activeLeaf = this.app.workspace.getLeaf(false);
            const oldPreview = this.previewLeaf;
            let targetLeaf: WorkspaceLeaf | null = null;
            
            // @ts-ignore
            const isOldPreviewValid = oldPreview && this.app.workspace.getLeafById(oldPreview.id);

            if (this.settings.reuseEmptyTab && activeLeaf.view.getViewType() === 'empty') {
                targetLeaf = activeLeaf;
                if (isOldPreviewValid && oldPreview !== targetLeaf) {
                    if (this.settings.promoteOldPreview) {
                        this.markAsPermanent(oldPreview);
                    } else {
                        oldPreview.detach();
                    }
                }
            } 
            else if (activeLeaf === oldPreview) {
                targetLeaf = activeLeaf;
            } 
            else {
                if (isOldPreviewValid) {
                    targetLeaf = oldPreview;
                    this.app.workspace.setActiveLeaf(targetLeaf, { focus: true });
                } else {
                    // [기능 구현] any 없이 정석적인 타입 사용
                    if (this.settings.openNewTabAtEnd) {
                        // 1. 현재 잎(Leaf)을 확장 인터페이스로 단언하여 parent 접근
                        const currentLeaf = activeLeaf as ExtendedLeaf;
                        const parent = currentLeaf.parent;
                        
                        // 2. 부모와 자식 목록이 있는지 확인
                        if (parent && parent.children) {
                            // 3. Workspace를 확장 인터페이스로 단언하여 숨겨진 메서드 호출
                            const workspace = this.app.workspace as ExtendedWorkspace;
                            // 부모(parent)는 WorkspaceItem 타입과 호환되므로 그대로 전달
                            targetLeaf = workspace.createLeafInParent(parent as unknown as WorkspaceItem, parent.children.length);
                        }
                    }
                    
                    if (!targetLeaf) {
                        targetLeaf = this.app.workspace.getLeaf('tab');
                    }
                }
            }

            await targetLeaf.openFile(file);
            this.app.workspace.setActiveLeaf(targetLeaf, { focus: true });
            this.markAsPreview(targetLeaf);
        }
    }

    markAsPreview(leaf: WorkspaceLeaf) {
        this.previewLeaf = leaf;
        const extendedLeaf = leaf as ExtendedLeaf;
        if (this.settings.useItalicTitle && extendedLeaf.tabHeaderEl) {
            extendedLeaf.tabHeaderEl.classList.add(PREVIEW_CLASS);
        }
    }

    markAsPermanent(leaf: WorkspaceLeaf) {
        if (this.previewLeaf === leaf) {
            this.previewLeaf = null;
        }
        const extendedLeaf = leaf as ExtendedLeaf;
        if (extendedLeaf.tabHeaderEl) {
            extendedLeaf.tabHeaderEl.classList.remove(PREVIEW_CLASS);
        }
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
            .setName('Italic title for preview')
            .setDesc('Display the preview tab title in italics.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.useItalicTitle)
                .onChange(async (value) => {
                    this.plugin.settings.useItalicTitle = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Reuse empty tab (locality)')
            .setDesc('If the current tab is empty, open the file in it instead of creating a new one.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.reuseEmptyTab)
                .onChange(async (value) => {
                    this.plugin.settings.reuseEmptyTab = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Promote old preview')
            .setDesc('If a new preview is opened elsewhere, keep the old preview tab as a regular tab instead of closing it.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.promoteOldPreview)
                .onChange(async (value) => {
                    this.plugin.settings.promoteOldPreview = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Focus existing tab')
            .setDesc('If the file is already open, jump to that tab instead of opening it again.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.jumpToDuplicate)
                .onChange(async (value) => {
                    this.plugin.settings.jumpToDuplicate = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Open new tab at the end')
            .setDesc('Open new preview tabs at the end of the tab bar instead of next to the current tab.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.openNewTabAtEnd)
                .onChange(async (value) => {
                    this.plugin.settings.openNewTabAtEnd = value;
                    await this.plugin.saveSettings();
                }));
    }
}