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

interface ExtendedWorkspace extends Workspace {
	createLeafInParent(parent: WorkspaceItem, index: number): WorkspaceLeaf;
}

interface LeafParent {
	children: WorkspaceItem[];
}

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
	openNewTabAtEnd: false,
};

const PREVIEW_CLASS = "is-preview-tab";

export default class PreviewModePlugin extends Plugin {
	settings: PreviewModeSettings;

	/**
	 * ✅ 패널별 preview leaf 관리
	 * key: 패널(parent), value: 해당 패널의 preview leaf
	 */
	private previewByPanel = new Map<LeafParent, WorkspaceLeaf>();

	// 파일 생성 복구용 상태 / State for file creation recovery
	private fileCreationState: {
		newFile: TFile | null;
		hijackedLeaf: WorkspaceLeaf | null;
		oldFile: TFile | null;
	} = {
		newFile: null,
		hijackedLeaf: null,
		oldFile: null,
	};

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new PreviewModeSettingTab(this.app, this));

		this.registerDomEvent(document, "click", this.handleClick, true);
		this.registerDomEvent(document, "dblclick", this.handleDblClick, true);
		this.registerDomEvent(document, "dblclick", this.handleHeaderDblClick, true);
		this.registerDomEvent(document, "input", this.handleInput, true);

		this.setupFileCreationHandling();

		// 파일 이름 변경 시: 해당 패널의 preview였다면 승격 / Promote preview tab on file rename
		this.registerEvent(
			this.app.vault.on("rename", (file) => {
				if (!(file instanceof TFile)) return;

				this.app.workspace.iterateAllLeaves((leaf) => {
					const view = leaf.view as any;
					if (view?.file?.path !== file.path) return;

					if (this.isPanelPreviewLeaf(leaf)) {
						this.markAsPermanent(leaf);
					}
				});
			})
		);

		// 편집 시작 시: 해당 패널의 preview였다면 승격 / Promote on editor change
		this.registerEvent(
			this.app.workspace.on("editor-change", (_editor, info) => {
				const leafFromInfo = (info as any)?.leaf as WorkspaceLeaf | undefined;
				const leaf = leafFromInfo ?? this.app.workspace.getLeaf(false);

				if (this.isPanelPreviewLeaf(leaf)) {
					this.markAsPermanent(leaf);
				}
			})
		);

		// 레이아웃 변경 시: 패널별 preview 유효성 정리
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				this.cleanupPreviewMap();
			})
		);
	}

	onunload() {
		// 표시 클래스 제거
		document.querySelectorAll(`.${PREVIEW_CLASS}`).forEach((el) => {
			el.classList.remove(PREVIEW_CLASS);
		});

		// 상태 정리
		this.previewByPanel.clear();
		this.fileCreationState = { newFile: null, hijackedLeaf: null, oldFile: null };
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/**
	 * 파일 생성 감지 및 복구 로직 (✅ 타이머 제거: 다음 file-open 이벤트로만 정리)
	 */
	setupFileCreationHandling() {
		// [1] create: 스냅샷 저장
		this.registerEvent(
			this.app.vault.on("create", (file) => {
				if (!(file instanceof TFile) || file.extension !== "md") return;

				const activeLeaf = this.app.workspace.getLeaf(false);
				const activeFile =
					activeLeaf.view instanceof FileView ? activeLeaf.view.file : null;

				this.fileCreationState = {
					newFile: file,
					hijackedLeaf: activeLeaf,
					oldFile: activeFile,
				};
			})
		);

		// [2] file-open: 다음 이벤트에서만 처리/폐기
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				const state = this.fileCreationState;
				if (!state.newFile) return;

				// create 이후 첫 file-open이 다른 파일이면: create-flow 폐기 (시간 기반 없음)
				if (!file || file.path !== state.newFile.path) {
					this.fileCreationState = { newFile: null, hijackedLeaf: null, oldFile: null };
					return;
				}

				const { newFile, hijackedLeaf, oldFile } = state;
				this.fileCreationState = { newFile: null, hijackedLeaf: null, oldFile: null };

				const currentLeaf = this.app.workspace.getLeaf(false);
				void this.handleFileCreation(newFile, currentLeaf, hijackedLeaf, oldFile);
			})
		);
	}

	/**
	 * 파일 생성 시나리오 처리
	 */
	async handleFileCreation(
		newFile: TFile,
		currentLeaf: WorkspaceLeaf,
		hijackedLeaf: WorkspaceLeaf | null,
		oldFile: TFile | null
	) {
		const hijackedSame = hijackedLeaf ? currentLeaf === hijackedLeaf : false;

		// Case 1: 새 탭에 열림
		if (!hijackedSame) {
			setTimeout(() => {
				this.markAsPermanent(currentLeaf);

				// 같은 패널에 preview가 있었다면 옵션에 따라 승격 (패널별)
				const panel = this.getPanelParent(currentLeaf);
				if (!panel) return;

				const preview = this.getPreviewLeafForPanel(panel);
				if (
					this.settings.promoteOldPreview &&
					preview &&
					preview !== currentLeaf &&
					this.isSamePanel(preview, currentLeaf)
				) {
					this.markAsPermanent(preview);
				}
			}, 0);
			return;
		}

		// Case 2: 탭 덮어쓰기 발생

		// Case 2-1: 복구할 파일이 없음 (빈 탭이었거나 같은 파일)
		if (!oldFile || oldFile.path === newFile.path) {
			setTimeout(() => {
				this.markAsPermanent(currentLeaf);
			}, 0);
			return;
		}

		// Case 2-2: 복구 필요
		setTimeout(() => {
			void this.restoreHijackedTab(currentLeaf, oldFile);
		}, 0);
	}

	/**
	 * 덮어씌워진 탭 복구
	 */
	async restoreHijackedTab(hijackedLeaf: WorkspaceLeaf, oldFile: TFile) {
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

		const workspace = this.app.workspace as ExtendedWorkspace;

		// Step 1: 원래 자리에 기존 파일 복구
		const restoredLeaf = workspace.createLeafInParent(parent as any, hijackedIndex);
		await restoredLeaf.openFile(oldFile);

		// 복구된 탭은 일반탭
		this.markAsPermanent(restoredLeaf);

		// Step 2: 새 파일 탭(하이재킹된 탭)은 일반탭 처리
		this.app.workspace.setActiveLeaf(hijackedLeaf, { focus: true });
		this.markAsPermanent(hijackedLeaf);
	}

	/**
	 * 입력 이벤트: preview에서 편집/제목 수정 등 시작되면 승격
	 */
	handleInput = (evt: Event) => {
		const target = evt.target as HTMLElement;
		if (target.closest(".view-header") || target.classList.contains("inline-title")) {
			const activeLeaf = this.app.workspace.getLeaf(false);
			if (this.isPanelPreviewLeaf(activeLeaf)) {
				this.markAsPermanent(activeLeaf);
			}
		}
	};

	/**
	 * 클릭이 파일 탐색기에서 왔는지 좁게 추정
	 */
	private isFromFileExplorer(target: HTMLElement): boolean {
		return (
			!!target.closest('.workspace-leaf-content[data-type="file-explorer"]') ||
			!!target.closest(".nav-files-container")
		);
	}

	/**
	 * 싱글클릭: preview로 열기 (✅ 패널별 preview 1개 유지)
	 */
	handleClick = (evt: MouseEvent) => {
		const target = evt.target as HTMLElement;
		if (!this.isFromFileExplorer(target)) return;

		const titleEl = target.closest(".nav-file-title");
		if (!titleEl) return;
		if (evt.ctrlKey || evt.metaKey || evt.shiftKey) return;

		const path = titleEl.getAttribute("data-path");
		if (!path) return;
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;

		evt.preventDefault();
		evt.stopPropagation();
		evt.stopImmediatePropagation();

		void this.openFileLogic(file, false);
	};

	/**
	 * 더블클릭: 일반탭으로 열기 (✅ 활성 패널 내부에서만 동작)
	 */
	handleDblClick = (evt: MouseEvent) => {
		const target = evt.target as HTMLElement;
		if (!this.isFromFileExplorer(target)) return;

		const titleEl = target.closest(".nav-file-title");
		if (!titleEl) return;

		const path = titleEl.getAttribute("data-path");
		if (!path) return;
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;

		evt.preventDefault();
		evt.stopPropagation();
		evt.stopImmediatePropagation();

		void this.openFileLogic(file, true);
	};

	/**
	 * 탭 헤더 더블클릭: 해당 패널의 preview면 승격
	 */
	handleHeaderDblClick = (evt: MouseEvent) => {
		const target = evt.target as HTMLElement;
		const tabHeader = target.closest(".workspace-tab-header");
		if (!tabHeader) return;

		// 모든 패널의 preview 중 이 헤더와 일치하는 leaf를 찾아 승격
		for (const [, leaf] of this.previewByPanel.entries()) {
			const ext = leaf as ExtendedLeaf;
			if (ext.tabHeaderEl === tabHeader) {
				evt.preventDefault();
				evt.stopPropagation();
				evt.stopImmediatePropagation();
				this.markAsPermanent(leaf);
				return;
			}
		}
	};

	/**
	 * 파일 열기 로직
	 * - ✅ 패널 독립: 중복탭 포커스도 "같은 패널"에서만
	 * - ✅ 더블클릭도 활성 패널에서만 새 탭 생성/포커스
	 */
	async openFileLogic(file: TFile, isDoubleClick: boolean) {
		const activeLeaf = this.app.workspace.getLeaf(false);
		const panel = this.getPanelParent(activeLeaf);
		if (!panel) return;

		// (옵션) 같은 패널에서만 중복 탭 포커스
		if (this.settings.jumpToDuplicate) {
			const existingLeaf = this.findLeafWithFileInPanel(file, panel);
			if (existingLeaf) {
				this.app.workspace.setActiveLeaf(existingLeaf, { focus: true });

				// 더블클릭이면 고정(일반탭) 의도니까 승격(만약 preview였다면)
				if (isDoubleClick && this.isPanelPreviewLeaf(existingLeaf)) {
					this.markAsPermanent(existingLeaf);
				}
				return;
			}
		}

		if (isDoubleClick) {
			await this.handleDoubleClickInPanel(file, activeLeaf);
			return;
		}

		await this.handleSingleClickInPanel(file, activeLeaf);
	}

	/**
	 * 더블클릭: 활성 패널 안에서만 "일반탭"으로 열기
	 */
	async handleDoubleClickInPanel(file: TFile, activeLeaf: WorkspaceLeaf) {
		const panel = this.getPanelParent(activeLeaf);
		if (!panel) return;

		// 1) 해당 패널의 preview가 같은 파일이면 승격
		const preview = this.getPreviewLeafForPanel(panel);
		const previewView = preview?.view as any;
		if (preview && previewView?.file?.path === file.path) {
			this.markAsPermanent(preview);
			this.app.workspace.setActiveLeaf(preview, { focus: true });
			return;
		}

		// 2) 새 탭을 "같은 패널"에 만들고 일반탭으로 열기
		const leaf = await this.createNewTabInSamePanel(activeLeaf);
		await leaf.openFile(file);
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
		this.markAsPermanent(leaf);
	}

	/**
	 * 싱글클릭: 활성 패널 안에서만 preview로 열기 (패널별 preview 1개 유지)
	 */
	async handleSingleClickInPanel(file: TFile, activeLeaf: WorkspaceLeaf) {
		const panel = this.getPanelParent(activeLeaf);
		if (!panel) return;

		const preview = this.getPreviewLeafForPanel(panel);
		const previewValid = preview ? this.isLeafStillPresent(preview) : false;

		const isActiveEmpty = activeLeaf.view.getViewType() === "empty";
		const canReuseEmpty = this.settings.reuseEmptyTab && isActiveEmpty;

		// Case A: activeLeaf가 이미 이 패널의 preview면 그대로 재사용
		if (previewValid && preview === activeLeaf) {
			await activeLeaf.openFile(file);
			this.app.workspace.setActiveLeaf(activeLeaf, { focus: true });
			this.markAsPreview(activeLeaf);
			return;
		}

		// Case B: empty 탭을 preview로 쓰고 싶으면 (옵션)
		// - promoteOldPreview=true 면: 기존 preview를 일반탭으로 승격하고 empty 탭을 새 preview로 사용
		// - promoteOldPreview=false면: 기존 preview가 있으면 그 preview를 계속 재사용(=preview 자리 고정)
		if (canReuseEmpty) {
			if (previewValid && preview && preview !== activeLeaf) {
				if (this.settings.promoteOldPreview) {
					this.markAsPermanent(preview);
				} else {
					// preview 자리 고정 정책: empty 탭 무시하고 기존 preview 재사용
					await preview.openFile(file);
					this.app.workspace.setActiveLeaf(preview, { focus: true });
					this.markAsPreview(preview);
					return;
				}
			}

			await activeLeaf.openFile(file);
			this.app.workspace.setActiveLeaf(activeLeaf, { focus: true });
			this.markAsPreview(activeLeaf);
			return;
		}

		// Case C: 기존 preview가 있으면 그걸 재사용
		if (previewValid && preview) {
			await preview.openFile(file);
			this.app.workspace.setActiveLeaf(preview, { focus: true });
			this.markAsPreview(preview);
			return;
		}

		// Case D: preview가 없으면 새 탭을 같은 패널에 만들고 preview로 사용
		const newLeaf = await this.createNewTabInSamePanel(activeLeaf);
		await newLeaf.openFile(file);
		this.app.workspace.setActiveLeaf(newLeaf, { focus: true });
		this.markAsPreview(newLeaf);
	}

	/**
	 * 같은 패널에 새 탭 생성 (가능하면 createLeafInParent 사용)
	 */
	async createNewTabInSamePanel(activeLeaf: WorkspaceLeaf): Promise<WorkspaceLeaf> {
		const panel = this.getPanelParent(activeLeaf);

		// parent 정보를 못 얻으면 fallback
		if (!panel || !panel.children) {
			return this.app.workspace.getLeaf("tab");
		}

		const extActive = activeLeaf as ExtendedLeaf;
		const parent = extActive.parent;
		const workspace = this.app.workspace as ExtendedWorkspace;

		const index = this.settings.openNewTabAtEnd
			? parent.children.length
			: Math.max(0, parent.children.indexOf(extActive as unknown as WorkspaceItem) + 1);

		try {
			return workspace.createLeafInParent(parent as any, index);
		} catch {
			// 버전/환경에 따라 실패할 수 있으니 fallback
			return this.app.workspace.getLeaf("tab");
		}
	}

	/**
	 * 같은 패널에서 특정 파일이 열린 leaf 찾기
	 */
	findLeafWithFileInPanel(file: TFile, panel: LeafParent): WorkspaceLeaf | null {
		let result: WorkspaceLeaf | null = null;

		this.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view as any;
			if (view?.file?.path !== file.path) return;

			const p = this.getPanelParent(leaf);
			if (p === panel) result = leaf;
		});

		return result;
	}

	/**
	 * 패널 parent 추출
	 */
	private getPanelParent(leaf: WorkspaceLeaf): LeafParent | null {
		const p = (leaf as ExtendedLeaf).parent;
		return p ?? null;
	}

	/**
	 * 두 leaf가 같은 패널인지
	 */
	isSamePanel(leaf1: WorkspaceLeaf | null, leaf2: WorkspaceLeaf | null): boolean {
		if (!leaf1 || !leaf2) return false;
		const p1 = this.getPanelParent(leaf1);
		const p2 = this.getPanelParent(leaf2);
		return !!p1 && p1 === p2;
	}

	/**
	 * 해당 패널의 preview leaf 가져오기(유효성 포함)
	 */
	private getPreviewLeafForPanel(panel: LeafParent): WorkspaceLeaf | null {
		const leaf = this.previewByPanel.get(panel) ?? null;
		if (!leaf) return null;
		if (!this.isLeafStillPresent(leaf)) {
			this.previewByPanel.delete(panel);
			return null;
		}
		return leaf;
	}

	/**
	 * leaf가 "자기 패널의 preview"인지 확인
	 */
	private isPanelPreviewLeaf(leaf: WorkspaceLeaf): boolean {
		const panel = this.getPanelParent(leaf);
		if (!panel) return false;
		const preview = this.previewByPanel.get(panel);
		return preview === leaf;
	}

	/**
	 * layout-change 등에서 previewByPanel 정리
	 */
	private cleanupPreviewMap() {
		for (const [panel, leaf] of this.previewByPanel.entries()) {
			if (!leaf || !this.isLeafStillPresent(leaf)) {
				this.previewByPanel.delete(panel);
			}
		}
	}

	/**
	 * 공식 API 기반으로 "leaf가 워크스페이스에 아직 존재하는지" 확인
	 */
	private isLeafStillPresent(leaf: WorkspaceLeaf): boolean {
		let present = false;
		this.app.workspace.iterateAllLeaves((l) => {
			if (l === leaf) present = true;
		});
		return present;
	}

	/**
	 * preview 표시(패널별로 저장)
	 */
	markAsPreview(leaf: WorkspaceLeaf) {
		const panel = this.getPanelParent(leaf);
		if (!panel) return;

		this.previewByPanel.set(panel, leaf);

		const ext = leaf as ExtendedLeaf;
		if (!ext.tabHeaderEl) return;

		if (this.settings.useItalicTitle) {
			ext.tabHeaderEl.classList.add(PREVIEW_CLASS);
		} else {
			ext.tabHeaderEl.classList.remove(PREVIEW_CLASS);
		}
	}

	/**
	 * 일반탭 승격(패널별 preview 해제)
	 */
	markAsPermanent(leaf: WorkspaceLeaf) {
		const panel = this.getPanelParent(leaf);
		if (panel) {
			const preview = this.previewByPanel.get(panel);
			if (preview === leaf) {
				this.previewByPanel.delete(panel);
			}
		}

		const ext = leaf as ExtendedLeaf;
		if (ext.tabHeaderEl) {
			ext.tabHeaderEl.classList.remove(PREVIEW_CLASS);
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
			.setName("Italic title for preview")
			.setDesc("Display the preview tab title in italics.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.useItalicTitle).onChange(async (value) => {
					this.plugin.settings.useItalicTitle = value;
					await this.plugin.saveSettings();
					// 즉시 반영은 다음 preview 갱신 시 적용됨 (필요하면 현재 열린 preview들을 순회해도 됨)
				})
			);

		new Setting(containerEl)
			.setName("Reuse empty tab (locality)")
			.setDesc("If the current tab is empty, open the file in it instead of creating a new one.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.reuseEmptyTab).onChange(async (value) => {
					this.plugin.settings.reuseEmptyTab = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Promote old preview (same panel only)")
			.setDesc("When moving preview within a panel, promote the old preview to a regular tab.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.promoteOldPreview).onChange(async (value) => {
					this.plugin.settings.promoteOldPreview = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Focus existing tab (same panel only)")
			.setDesc("If the file is already open in the same panel, focus it instead of opening it again.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.jumpToDuplicate).onChange(async (value) => {
					this.plugin.settings.jumpToDuplicate = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Open new tab at the end")
			.setDesc("Open new tabs at the end of the tab bar instead of next to the current tab.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.openNewTabAtEnd).onChange(async (value) => {
					this.plugin.settings.openNewTabAtEnd = value;
					await this.plugin.saveSettings();
				})
			);
	}
}
