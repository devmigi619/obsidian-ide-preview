import { App, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, TFile } from 'obsidian';

// [수정 1] any 사용을 피하기 위해 tabHeaderEl을 포함한 커스텀 인터페이스 정의
interface WorkspaceLeafWithHeader extends WorkspaceLeaf {
    tabHeaderEl: HTMLElement;
}

interface PreviewModeSettings {
    useItalicTitle: boolean;
    reuseEmptyTab: boolean;
    promoteOldPreview: boolean;
    jumpToDuplicate: boolean;
}

const DEFAULT_SETTINGS: PreviewModeSettings = {
    useItalicTitle: true,
    reuseEmptyTab: true,
    promoteOldPreview: true,
    jumpToDuplicate: true
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
        
        // [수정 2] as any 대신 as WorkspaceLeafWithHeader 사용
        if (tabHeader && this.previewLeaf) {
             const previewLeafWithHeader = this.previewLeaf as WorkspaceLeafWithHeader;
             if (previewLeafWithHeader.tabHeaderEl === tabHeader) {
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
                    targetLeaf = this.app.workspace.getLeaf('tab');
                }
            }

            await targetLeaf.openFile(file);
            this.markAsPreview(targetLeaf);
        }
    }

    markAsPreview(leaf: WorkspaceLeaf) {
        this.previewLeaf = leaf;
        // [수정 3] as any 제거 및 타입 단언 변경
        const leafWithHeader = leaf as WorkspaceLeafWithHeader;
        if (this.settings.useItalicTitle && leafWithHeader.tabHeaderEl) {
            leafWithHeader.tabHeaderEl.classList.add(PREVIEW_CLASS);
        }
    }

    markAsPermanent(leaf: WorkspaceLeaf) {
        if (this.previewLeaf === leaf) {
            this.previewLeaf = null;
        }
        // [수정 4] as any 제거 및 타입 단언 변경
        const leafWithHeader = leaf as WorkspaceLeafWithHeader;
        if (leafWithHeader.tabHeaderEl) {
            leafWithHeader.tabHeaderEl.classList.remove(PREVIEW_CLASS);
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
    }
}