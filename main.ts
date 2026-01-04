import { App, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, TFile, View } from 'obsidian';

// 설정(옵션) 데이터 구조 정의
interface PreviewModeSettings {
    useItalicTitle: boolean;      // 제목 이탤릭체 사용 여부
    reuseEmptyTab: boolean;       // 현재 보고 있는 빈 탭 재활용 여부 (Locality)
    promoteOldPreview: boolean;   // 기존 미리보기 탭 처리 (True: 승격, False: 닫기)
    jumpToDuplicate: boolean;     // 중복 탭 포커스 이동 여부
}

// 기본값 설정
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
        console.log('Smart Tabs Plugin loaded');

        // 설정 불러오기
        await this.loadSettings();

        // 설정 탭 추가
        this.addSettingTab(new PreviewModeSettingTab(this.app, this));

        // 이벤트 바인딩
        this.handleClick = this.handleClick.bind(this);
        this.handleDblClick = this.handleDblClick.bind(this);
        this.handleHeaderDblClick = this.handleHeaderDblClick.bind(this);

        // DOM 이벤트 리스너 (Capture Mode)
        document.addEventListener('click', this.handleClick, true);
        document.addEventListener('dblclick', this.handleDblClick, true);
        document.addEventListener('dblclick', this.handleHeaderDblClick, true);

        // 에디터 변경 감지 -> 보존 처리
        this.registerEvent(this.app.workspace.on('editor-change', (editor, info) => {
            const activeLeaf = this.app.workspace.getLeaf(false);
            if (this.previewLeaf === activeLeaf) {
                this.markAsPermanent(activeLeaf);
            }
        }));

        // 탭 닫힘 감지
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

    // --- 이벤트 핸들러 ---
    handleClick(evt: MouseEvent) {
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

        this.openFileLogic(file, false);
    }

    handleDblClick(evt: MouseEvent) {
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

        this.openFileLogic(file, true);
    }

    handleHeaderDblClick(evt: MouseEvent) {
        const target = evt.target as HTMLElement;
        const tabHeader = target.closest('.workspace-tab-header');
        if (tabHeader && this.previewLeaf && this.previewLeaf.tabHeaderEl === tabHeader) {
            evt.preventDefault();
            evt.stopPropagation();
            evt.stopImmediatePropagation();
            this.markAsPermanent(this.previewLeaf);
        }
    }

    // --- 핵심 로직 ---
    async openFileLogic(file: TFile, isDoubleClick: boolean) {
        
        // [옵션: 중복 탭 포커스 이동]
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
            // 더블 클릭
            // @ts-ignore
            if (this.previewLeaf && this.previewLeaf.view.file && this.previewLeaf.view.file.path === file.path) {
                this.markAsPermanent(this.previewLeaf);
            } else {
                const leaf = this.app.workspace.getLeaf('tab');
                await leaf.openFile(file);
                this.markAsPermanent(leaf);
            }
        } else {
            // 싱글 클릭 (미리보기)
            const activeLeaf = this.app.workspace.getLeaf(false);
            const oldPreview = this.previewLeaf;
            let targetLeaf: WorkspaceLeaf | null = null;
            
            // @ts-ignore
            const isOldPreviewValid = oldPreview && this.app.workspace.getLeafById(oldPreview.id);

            // [옵션: 빈 탭 재활용]
            if (this.settings.reuseEmptyTab && activeLeaf.view.getViewType() === 'empty') {
                targetLeaf = activeLeaf;

                // [옵션: 기존 미리보기 처리]
                if (isOldPreviewValid && oldPreview !== targetLeaf) {
                    if (this.settings.promoteOldPreview) {
                        this.markAsPermanent(oldPreview); // 승격
                    } else {
                        oldPreview.detach(); // 닫기
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

            await targetLeaf!.openFile(file);
            this.markAsPreview(targetLeaf!);
        }
    }

    markAsPreview(leaf: WorkspaceLeaf) {
        this.previewLeaf = leaf;
        if (this.settings.useItalicTitle && leaf.tabHeaderEl) {
            leaf.tabHeaderEl.classList.add(PREVIEW_CLASS);
        }
    }

    markAsPermanent(leaf: WorkspaceLeaf) {
        if (this.previewLeaf === leaf) {
            this.previewLeaf = null;
        }
        if (leaf.tabHeaderEl) {
            leaf.tabHeaderEl.classList.remove(PREVIEW_CLASS);
        }
    }
}

// 설정 UI 클래스
class PreviewModeSettingTab extends PluginSettingTab {
    plugin: PreviewModePlugin;

    constructor(app: App, plugin: PreviewModePlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        // 제목 수정됨: Smart Tabs Settings
        containerEl.createEl('h2', { text: 'Smart Tabs Settings' });

        new Setting(containerEl)
            .setName('Italic Title for Preview')
            .setDesc('Display the preview tab title in italics.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.useItalicTitle)
                .onChange(async (value) => {
                    this.plugin.settings.useItalicTitle = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Reuse Empty Tab (Locality)')
            .setDesc('If the current tab is empty, open the file in it instead of creating a new one.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.reuseEmptyTab)
                .onChange(async (value) => {
                    this.plugin.settings.reuseEmptyTab = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Promote Old Preview')
            .setDesc('If a new preview is opened elsewhere, keep the old preview tab as a regular tab instead of closing it.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.promoteOldPreview)
                .onChange(async (value) => {
                    this.plugin.settings.promoteOldPreview = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Focus Existing Tab')
            .setDesc('If the file is already open, jump to that tab instead of opening it again.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.jumpToDuplicate)
                .onChange(async (value) => {
                    this.plugin.settings.jumpToDuplicate = value;
                    await this.plugin.saveSettings();
                }));
    }
}