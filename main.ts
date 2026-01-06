import { App, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, TFile, Workspace, WorkspaceItem, FileView } from 'obsidian';

interface ExtendedWorkspace extends Workspace {
    createLeafInParent(parent: WorkspaceItem, index: number): WorkspaceLeaf;
}

interface LeafParent {
    children: WorkspaceItem[];
}

interface ExtendedLeaf extends WorkspaceLeaf {
    tabHeaderEl: HTMLElement;
    parent: LeafParent;
    id: string;
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
    
    // 파일 생성 복구용 상태 / State for file creation recovery
    private fileCreationState: {
        newFile: TFile | null;
        hijackedLeaf: WorkspaceLeaf | null;
        oldFile: TFile | null;
    } = {
        newFile: null,
        hijackedLeaf: null,
        oldFile: null
    };

    async onload() {
        await this.loadSettings();
        this.addSettingTab(new PreviewModeSettingTab(this.app, this));

        this.registerDomEvent(document, 'click', this.handleClick, true);
        this.registerDomEvent(document, 'dblclick', this.handleDblClick, true);
        this.registerDomEvent(document, 'dblclick', this.handleHeaderDblClick, true);
        this.registerDomEvent(document, 'input', this.handleInput, true);

        // 파일 생성 감지 및 복구 설정 / Setup file creation detection and recovery
        this.setupFileCreationHandling();

        // 파일 이름 변경 시 임시탭 승격 / Promote preview tab on file rename
        this.registerEvent(this.app.vault.on('rename', (file) => {
            if (file instanceof TFile) {
                this.app.workspace.iterateAllLeaves(leaf => {
                    const view = leaf.view as any;
                    if (view.file && view.file.path === file.path) {
                        if (this.previewLeaf === leaf) {
                            this.markAsPermanent(leaf);
                        }
                    }
                });
            }
        }));

        // 편집 시작 시 임시탭 승격 / Promote preview tab on editor change
        this.registerEvent(this.app.workspace.on('editor-change', (editor, info) => {
            const activeLeaf = this.app.workspace.getLeaf(false);
            if (this.previewLeaf === activeLeaf) {
                this.markAsPermanent(activeLeaf);
            }
        }));

        // 레이아웃 변경 시 임시탭 유효성 검사 / Validate preview tab on layout change
        this.registerEvent(this.app.workspace.on('layout-change', () => {
            if (this.previewLeaf) {
                const leafAny = this.previewLeaf as any;
                if (leafAny.id) {
                    const exists = this.app.workspace.getLeafById(leafAny.id);
                    if (!exists) {
                        this.previewLeaf = null;
                    }
                }
            }
        }));
    }

    /**
     * 파일 생성 감지 및 복구 로직
     * File creation detection and recovery logic
     * 
     * 명확한 3단계 구성 / Clear 3-step process:
     * 1. Snapshot: 파일 생성 시점의 상태 저장 / Save state at file creation
     * 2. Detect: 탭 덮어쓰기 감지 / Detect tab hijacking
     * 3. Restore: 필요시 복구 / Restore if needed
     */
    setupFileCreationHandling() {
        // [1. Snapshot] 파일 생성 감지 / Detect file creation
        this.registerEvent(this.app.vault.on('create', (file) => {
            if (!(file instanceof TFile) || file.extension !== 'md') return;

            const activeLeaf = this.app.workspace.getLeaf(false);
            const activeFile = activeLeaf.view instanceof FileView ? activeLeaf.view.file : null;

            // 상태 저장 / Save state
            this.fileCreationState = {
                newFile: file,
                hijackedLeaf: activeLeaf,
                oldFile: activeFile
            };
        }));

        // [2. Detect & 3. Restore] 파일 열림 감지 및 복구 / Detect file open and restore
        this.registerEvent(this.app.workspace.on('file-open', (file) => {
            if (!file || !this.fileCreationState.newFile) return;
            if (file.path !== this.fileCreationState.newFile.path) return;

            const { newFile, hijackedLeaf, oldFile } = this.fileCreationState;
            const currentLeaf = this.app.workspace.getLeaf(false);

            // 상태 초기화 (중복 실행 방지) / Reset state (prevent duplicate execution)
            this.fileCreationState = { newFile: null, hijackedLeaf: null, oldFile: null };

            // 결정 트리 실행 / Execute decision tree
            this.handleFileCreation(newFile, currentLeaf, hijackedLeaf, oldFile);
        }));

        // [오류 처리] 파일 생성 후 일정 시간 내에 file-open이 없으면 상태 초기화
        // Error handling: Clear state if file-open doesn't occur within timeout
        this.registerEvent(this.app.vault.on('create', (file) => {
            if (!(file instanceof TFile) || file.extension !== 'md') return;
            
            setTimeout(() => {
                // 3초 후에도 상태가 남아있으면 실패로 간주하고 초기화
                // If state remains after 3 seconds, consider it failed and clear
                if (this.fileCreationState.newFile?.path === file.path) {
                    this.fileCreationState = { newFile: null, hijackedLeaf: null, oldFile: null };
                }
            }, 3000);
        }));
    }

    /**
     * 파일 생성 시나리오 처리 / Handle file creation scenarios
     * 명확한 의사결정 트리 / Clear decision tree
     */
    async handleFileCreation(
        newFile: TFile,
        currentLeaf: WorkspaceLeaf,
        hijackedLeaf: WorkspaceLeaf | null,
        oldFile: TFile | null
    ) {
        // @ts-ignore
        const currentLeafId = currentLeaf.id;
        // @ts-ignore
        const hijackedLeafId = hijackedLeaf?.id;

        // Case 1: 새 탭에 열림 (리본 버튼) / Opened in new tab (ribbon button)
        if (currentLeafId !== hijackedLeafId) {
            // setTimeout으로 감싸서 DOM 업데이트 후 실행
            // Wrap with setTimeout to execute after DOM update
            setTimeout(() => {
                this.markAsPermanent(currentLeaf);
                
                // 기존 임시탭이 같은 패널에 있으면 승격
                // Promote existing preview tab if in same panel
                if (this.previewLeaf && 
                    this.previewLeaf !== currentLeaf && 
                    this.isSamePanel(this.previewLeaf, currentLeaf)) {
                    this.markAsPermanent(this.previewLeaf);
                }
            }, 0);
            return;
        }

        // Case 2: 탭 덮어쓰기 발생 / Tab hijacking occurred
        
        // Case 2-1: 복구할 파일이 없음 (빈 탭이었거나 같은 파일) 
        // No file to restore (was empty or same file)
        if (!oldFile || oldFile.path === newFile.path) {
            // setTimeout으로 감싸서 DOM 업데이트 후 실행
            // Wrap with setTimeout to execute after DOM update
            setTimeout(() => {
                this.markAsPermanent(currentLeaf);
                
                // 빈 탭에 새 파일을 만든 경우, 같은 패널의 기존 임시탭 승격
                // When creating new file in empty tab, promote existing preview in same panel
                if (!oldFile && 
                    this.previewLeaf && 
                    this.previewLeaf !== currentLeaf &&
                    this.isSamePanel(this.previewLeaf, currentLeaf)) {
                    this.markAsPermanent(this.previewLeaf);
                }
            }, 0);
            return;
        }

        // Case 2-2: 복구 필요 / Restoration needed
        setTimeout(async () => {
            await this.restoreHijackedTab(currentLeaf, oldFile, newFile);
        }, 0);
    }

    /**
     * 덮어씌워진 탭 복구 / Restore hijacked tab
     */
    async restoreHijackedTab(hijackedLeaf: WorkspaceLeaf, oldFile: TFile, newFile: TFile) {
        const extLeaf = hijackedLeaf as ExtendedLeaf;
        const parent = extLeaf.parent;

        if (!parent || !parent.children) {
            this.markAsPermanent(hijackedLeaf);
            return;
        }

        const hijackedIndex = parent.children.indexOf(extLeaf as unknown as WorkspaceItem);
        
        if (hijackedIndex === -1) {
            this.markAsPermanent(hijackedLeaf);
            return;
        }

        // 덮어쓴 탭이 임시탭이었는지 확인 / Check if hijacked tab was preview
        const wasPreview = (this.previewLeaf === hijackedLeaf);

        const workspace = this.app.workspace as ExtendedWorkspace;

        // Step 1: 원래 자리에 기존 파일 복구 / Restore old file in original position
        const restoredLeaf = workspace.createLeafInParent(parent as any, hijackedIndex);
        await restoredLeaf.openFile(oldFile);
        
        // 복구된 탭은 임시탭이었다면 일반탭으로 승격 / Promote if it was preview
        if (wasPreview) {
            this.markAsPermanent(restoredLeaf);
        } else {
            this.markAsPermanent(restoredLeaf);
        }

        // Step 2: 새 파일 탭 활성화 / Activate new file tab
        // hijackedLeaf는 이미 newFile을 가지고 있으므로 활성화만 필요
        // hijackedLeaf already has newFile, only activation needed
        // @ts-ignore
        this.app.workspace.setActiveLeaf(hijackedLeaf, { focus: true });
        this.markAsPermanent(hijackedLeaf);
    }

    onunload() {
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

    /**
     * 입력 이벤트 처리 (제목 편집 등) / Handle input events (title editing, etc.)
     */
    handleInput = (evt: Event) => {
        const target = evt.target as HTMLElement;
        if (target.closest('.view-header') || target.classList.contains('inline-title')) {
            const activeLeaf = this.app.workspace.getLeaf(false);
            if (this.previewLeaf === activeLeaf) {
                this.markAsPermanent(activeLeaf);
            }
        }
    }

    /**
     * 싱글클릭 처리 / Handle single click
     */
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

    /**
     * 더블클릭 처리 / Handle double click
     */
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

    /**
     * 탭 헤더 더블클릭 처리 (임시탭 승격) / Handle tab header double click (promote preview)
     */
    handleHeaderDblClick = (evt: MouseEvent) => {
        const target = evt.target as HTMLElement;
        const tabHeader = target.closest('.workspace-tab-header');
        
        if (tabHeader && this.previewLeaf) {
            const extendedLeaf = this.previewLeaf as ExtendedLeaf;
            if (extendedLeaf.tabHeaderEl === tabHeader) {
                evt.preventDefault();
                evt.stopPropagation();
                evt.stopImmediatePropagation();
                this.markAsPermanent(this.previewLeaf);
            }
        }
    }

    /**
     * 파일 열기 로직 - 명확한 의사결정 트리
     * File opening logic - Clear decision tree
     */
    async openFileLogic(file: TFile, isDoubleClick: boolean) {
        // Step 1: 중복 탭 체크 / Check for duplicate tabs
        if (this.settings.jumpToDuplicate) {
            const existingLeaf = this.findLeafWithFile(file);
            if (existingLeaf) {
                this.app.workspace.setActiveLeaf(existingLeaf, { focus: true });
                if (isDoubleClick) this.markAsPermanent(existingLeaf);
                return;
            }
        }

        // Step 2: 더블클릭 처리 / Handle double click
        if (isDoubleClick) {
            await this.handleDoubleClick(file);
            return;
        }

        // Step 3: 싱글클릭 처리 / Handle single click
        await this.handleSingleClick(file);
    }

    /**
     * 더블클릭: 항상 일반탭으로 열기
     * Double click: Always open as permanent tab
     */
    async handleDoubleClick(file: TFile) {
        const previewView = this.previewLeaf?.view as any;
        
        // 현재 임시탭이 같은 파일이면 승격 / Promote if preview tab has same file
        if (this.previewLeaf && previewView?.file?.path === file.path) {
            this.markAsPermanent(this.previewLeaf);
            return;
        }

        // 새 탭에 일반으로 열기 / Open in new tab as permanent
        const leaf = this.app.workspace.getLeaf('tab');
        await leaf.openFile(file);
        this.markAsPermanent(leaf);
    }

    /**
     * 싱글클릭: 임시탭으로 열기 (복잡한 로직)
     * Single click: Open as preview tab (complex logic)
     */
    async handleSingleClick(file: TFile) {
        const activeLeaf = this.app.workspace.getLeaf(false);
        const oldPreview = this.previewLeaf;
        const isOldPreviewValid = this.isLeafValid(oldPreview);

        // Case 1: 현재 탭이 빈 탭 / Current tab is empty
        if (activeLeaf.view.getViewType() === 'empty') {
            // 같은 패널의 기존 임시탭이 있으면 승격
            // Promote existing preview in same panel if present
            if (isOldPreviewValid && 
                oldPreview !== activeLeaf && 
                this.isSamePanel(oldPreview, activeLeaf)) {
                this.markAsPermanent(oldPreview);
            }
            await activeLeaf.openFile(file);
            this.app.workspace.setActiveLeaf(activeLeaf, { focus: true });
            this.markAsPreview(activeLeaf);
            return;
        }

        // Case 2: 현재 탭이 기존 임시탭 / Current tab is the existing preview
        if (activeLeaf === oldPreview) {
            await activeLeaf.openFile(file);
            this.app.workspace.setActiveLeaf(activeLeaf, { focus: true });
            this.markAsPreview(activeLeaf);
            return;
        }

        // Case 3: 기존 임시탭이 유효함 / Existing preview is valid
        if (isOldPreviewValid) {
            await oldPreview.openFile(file);
            this.app.workspace.setActiveLeaf(oldPreview, { focus: true });
            this.markAsPreview(oldPreview);
            return;
        }

        // Case 4: 새 탭 필요 / Need new tab
        const newLeaf = await this.createNewTabForPreview(activeLeaf);
        await newLeaf.openFile(file);
        this.app.workspace.setActiveLeaf(newLeaf, { focus: true });
        this.markAsPreview(newLeaf);
    }

    /**
     * 임시탭용 새 탭 생성 / Create new tab for preview
     */
    async createNewTabForPreview(activeLeaf: WorkspaceLeaf): Promise<WorkspaceLeaf> {
        if (this.settings.openNewTabAtEnd) {
            const extLeaf = activeLeaf as ExtendedLeaf;
            const parent = extLeaf.parent;
            
            if (parent?.children) {
                const workspace = this.app.workspace as ExtendedWorkspace;
                return workspace.createLeafInParent(parent as any, parent.children.length);
            }
        }
        
        return this.app.workspace.getLeaf('tab');
    }

    /**
     * 특정 파일을 가진 탭 찾기 / Find tab with specific file
     */
    findLeafWithFile(file: TFile): WorkspaceLeaf | null {
        let result: WorkspaceLeaf | null = null;
        this.app.workspace.iterateAllLeaves(leaf => {
            const view = leaf.view as any;
            if (view?.file?.path === file.path) {
                result = leaf;
            }
        });
        return result;
    }

    /**
     * 두 탭이 같은 패널(부모)에 있는지 확인
     * Check if two leaves are in the same panel (parent)
     */
    isSamePanel(leaf1: WorkspaceLeaf | null, leaf2: WorkspaceLeaf | null): boolean {
        if (!leaf1 || !leaf2) return false;
        const parent1 = (leaf1 as ExtendedLeaf).parent;
        const parent2 = (leaf2 as ExtendedLeaf).parent;
        return parent1 === parent2;
    }

    /**
     * 임시탭으로 표시 / Mark as preview tab
     */
    markAsPreview(leaf: WorkspaceLeaf) {
        this.previewLeaf = leaf;
        const extendedLeaf = leaf as ExtendedLeaf;
        if (this.settings.useItalicTitle && extendedLeaf.tabHeaderEl) {
            extendedLeaf.tabHeaderEl.classList.add(PREVIEW_CLASS);
        }
    }

    /**
     * 일반탭으로 승격 / Promote to permanent tab
     */
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