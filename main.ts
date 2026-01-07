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
 * NOTE (KR/EN)
 * 이 플러그인은 "현재 활성 패널(탭 그룹)" 내부에서 새 탭을 생성/복구하기 위해
 * Obsidian 워크스페이스 내부 구현에 존재하는 요소를 best-effort로 사용합니다.
 * (createLeafInParent, leaf.parent, tabHeaderEl 등)
 *
 * This plugin uses a few workspace internals on a best-effort basis to create/restore tabs
 * inside the active panel (tab group). These are not guaranteed public APIs.
 * If internals change, core behavior should still work, while exact placement/styling may degrade.
 */

interface ExtendedWorkspace extends Workspace {
	createLeafInParent(parent: WorkspaceItem, index: number): WorkspaceLeaf;
}

/**
 * LeafParent (panel/tab group)
 * KR: leaf.parent로 관측되는 패널(탭 그룹) 객체는 WorkspaceItem 형태를 가지며 children 배열을 가집니다.
 * EN: The panel/tab-group object observed via leaf.parent is a WorkspaceItem with children.
 */
type LeafParent = WorkspaceItem & {
	children: WorkspaceItem[];
};

interface ExtendedLeaf extends WorkspaceLeaf {
	/**
	 * NOTE (KR/EN)
	 * tabHeaderEl은 탭 헤더 DOM 엘리먼트입니다. 버전/테마에 따라 없을 수 있습니다.
	 * UI 표시(이탤릭)만을 위한 best-effort 접근이며, 없으면 표시만 생략합니다.
	 *
	 * tabHeaderEl is the tab header DOM element. It may not exist depending on Obsidian versions/themes.
	 * This is used only for best-effort styling; core behavior works even if styling is skipped.
	 */
	tabHeaderEl?: HTMLElement;

	/**
	 * NOTE (KR/EN)
	 * leaf.parent는 현재 leaf가 속한 "탭 컨테이너(패널/탭 그룹)" 객체로 관측됩니다.
	 * Obsidian은 공식적인 "패널 ID" API를 제공하지 않으므로, 패널 식별자로 parent를 사용합니다.
	 * layout-change 시점에 map을 정리(cleanup)하여 stale 참조를 방지합니다.
	 *
	 * leaf.parent is observed to represent the tab container (panel/tab group) for a leaf.
	 * Since there is no official public "panel id" API, we use parent as the panel identity.
	 * We cleanup on layout changes to avoid stale references.
	 */
	parent?: LeafParent;
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

/**
 * Minimal view shape we care about (file path)
 * KR: leaf.view에서 file.path만 안전하게 읽기 위한 최소 형태
 * EN: Minimal shape to safely read file.path from a leaf view
 */
type FileLikeView = {
	file?: {
		path?: unknown;
	};
};

/**
 * Editor-change info shape (optional)
 * KR: Obsidian 버전에 따라 info.leaf가 제공될 수 있음
 * EN: Some Obsidian versions provide info.leaf
 */
type EditorChangeInfoLike = {
	leaf?: WorkspaceLeaf;
};

export default class PreviewModePlugin extends Plugin {
	settings: PreviewModeSettings;

	/**
	 * ✅ 패널별 preview leaf 관리 / Per-panel preview leaf state
	 *
	 * KR:
	 *  - 패널(탭 그룹)마다 preview 탭을 최대 1개로 유지합니다.
	 *  - 패널 식별자는 공식 API가 없어 leaf.parent를 best-effort로 사용합니다.
	 *  - layout-change 시 cleanup으로 stale 상태를 정리합니다.
	 *
	 * EN:
	 *  - Keep at most one preview tab per panel (tab group).
	 *  - We use leaf.parent as a best-effort panel identity (no official public panel id API).
	 *  - Cleanup on layout changes to prevent stale state.
	 */
	private previewByPanel = new Map<LeafParent, WorkspaceLeaf>();

	/**
	 * 파일 생성 "복구"용 상태 / State for file-creation "restore"
	 *
	 * KR:
	 *  - 새 노트 생성 과정에서, 기존 탭이 새 파일로 덮어써지는(하이재킹) 경우가 있습니다.
	 *  - create 시점에 스냅샷을 저장하고, file-open에서 새 파일이 실제로 열렸을 때만 복구 로직을 실행합니다.
	 *  - 시간(예: 3초) 기반이 아니라 이벤트(file-open) 기반으로 상태를 소비/폐기합니다.
	 *
	 * EN:
	 *  - During new note creation, an existing tab can be "hijacked" (overwritten) by the new file.
	 *  - We snapshot on vault 'create', then restore only when workspace 'file-open' confirms the new file is opened.
	 *  - State is consumed/discarded event-driven (file-open), not time-based.
	 */
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

		// Explorer click interception (capture phase)
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
					const openedPath = this.getLeafFilePath(leaf);
					if (openedPath !== file.path) return;

					if (this.isPanelPreviewLeaf(leaf)) {
						this.markAsPermanent(leaf);
					}
				});
			})
		);

		// 편집 시작 시: 해당 패널의 preview였다면 승격 / Promote on editor change
		this.registerEvent(
			this.app.workspace.on("editor-change", (_editor, info) => {
				const infoObj = info as unknown;
				const leafFromInfo =
					typeof infoObj === "object" && infoObj !== null
						? (infoObj as EditorChangeInfoLike).leaf
						: undefined;

				const leaf = leafFromInfo ?? this.app.workspace.getLeaf(false);

				if (this.isPanelPreviewLeaf(leaf)) {
					this.markAsPermanent(leaf);
				}
			})
		);

		// 레이아웃 변경 시: 패널별 preview 유효성 정리 / Cleanup preview state on layout change
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				this.cleanupPreviewMap();
			})
		);
	}

	onunload() {
		// 표시 클래스 제거 / Remove styling class
		document.querySelectorAll(`.${PREVIEW_CLASS}`).forEach((el) => {
			el.classList.remove(PREVIEW_CLASS);
		});

		// 상태 정리 / Clear state
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
	 * 파일 생성 감지 및 복구 로직 (✅ 이벤트 기반)
	 * File creation detection & restore (event-driven)
	 */
	private setupFileCreationHandling() {
		// [1] create: 스냅샷 저장 / Snapshot on create
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

		// [2] file-open: 다음 이벤트에서만 처리/폐기 / Consume or discard on next file-open
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				const state = this.fileCreationState;
				if (!state.newFile) return;

				// create 이후 첫 file-open이 다른 파일이면: create-flow 폐기
				// Discard create-flow if next file-open doesn't match the created file
				if (!file || file.path !== state.newFile.path) {
					this.fileCreationState = { newFile: null, hijackedLeaf: null, oldFile: null };
					return;
				}

				const { newFile, hijackedLeaf, oldFile } = state;
				this.fileCreationState = { newFile: null, hijackedLeaf: null, oldFile: null };

				const currentLeaf = this.app.workspace.getLeaf(false);
				this.handleFileCreation(newFile, currentLeaf, hijackedLeaf, oldFile);
			})
		);
	}

	/**
	 * 파일 생성 시나리오 처리 / Handle file creation scenarios
	 */
	private handleFileCreation(
		newFile: TFile,
		currentLeaf: WorkspaceLeaf,
		hijackedLeaf: WorkspaceLeaf | null,
		oldFile: TFile | null
	) {
		// If the newly created file opened in a different leaf than the "active leaf at create time",
		// treat it as "opened in a new tab".
		const hijackedSame = hijackedLeaf ? currentLeaf === hijackedLeaf : false;

		// Case 1: 새 탭에 열림 / Opened in a new tab
		if (!hijackedSame) {
			/**
			 * NOTE (KR/EN)
			 * setTimeout(..., 0)은 "시간으로 제어"가 아니라,
			 * Obsidian이 leaf/탭 상태를 갱신한 뒤 다음 tick에서 안전하게 처리하기 위한 큐잉입니다.
			 *
			 * setTimeout(..., 0) here is not time-based control. It's used to queue work
			 * after Obsidian finishes updating leaf/tab state for the current event cycle.
			 */
			setTimeout(() => {
				this.markAsPermanent(currentLeaf);

				// 같은 패널에 preview가 있었다면 옵션에 따라 승격 (패널별)
				// Promote existing preview in the same panel if the option is enabled (per-panel)
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

		// Case 2: 탭 덮어쓰기 발생 / Tab hijacking occurred

		// Case 2-1: 복구할 파일이 없음 (빈 탭이었거나 같은 파일)
		// No file to restore (empty tab or same file)
		if (!oldFile || oldFile.path === newFile.path) {
			setTimeout(() => {
				this.markAsPermanent(currentLeaf);
			}, 0);
			return;
		}

		// Case 2-2: 복구 필요 / Restoration needed
		setTimeout(() => {
			void this.restoreHijackedTab(currentLeaf, oldFile);
		}, 0);
	}

	/**
	 * 덮어씌워진 탭 복구 / Restore hijacked tab
	 *
	 * Track 2 hardening:
	 * - Wrap `createLeafInParent` with try/catch to avoid hard failures if internals change.
	 */
	private async restoreHijackedTab(hijackedLeaf: WorkspaceLeaf, oldFile: TFile) {
		const parent = this.getPanelParent(hijackedLeaf);

		if (!parent || !parent.children) {
			this.markAsPermanent(hijackedLeaf);
			return;
		}

		const hijackedIndex = parent.children.indexOf(hijackedLeaf as unknown as WorkspaceItem);
		if (hijackedIndex === -1) {
			this.markAsPermanent(hijackedLeaf);
			return;
		}

		const workspace = this.app.workspace as ExtendedWorkspace;

		let restoredLeaf: WorkspaceLeaf | null = null;
		try {
			restoredLeaf = workspace.createLeafInParent(parent, hijackedIndex);
		} catch {
			restoredLeaf = null;
		}

		if (restoredLeaf) {
			await restoredLeaf.openFile(oldFile);
			this.markAsPermanent(restoredLeaf);
		} else {
			// Fallback: location may differ, but prevents losing the old file view.
			const fallbackLeaf = this.app.workspace.getLeaf("tab");
			await fallbackLeaf.openFile(oldFile);
			this.markAsPermanent(fallbackLeaf);
		}

		// Step 2: 새 파일 탭(하이재킹된 탭)은 일반탭 처리 / New file tab should be permanent
		this.app.workspace.setActiveLeaf(hijackedLeaf, { focus: true });
		this.markAsPermanent(hijackedLeaf);
	}

	/**
	 * 입력 이벤트: preview에서 편집/제목 수정 등 시작되면 승격
	 * Input event: promote preview to permanent when editing starts
	 */
	private handleInput = (evt: Event) => {
		const target = evt.target as HTMLElement;
		if (target.closest(".view-header") || target.classList.contains("inline-title")) {
			const activeLeaf = this.app.workspace.getLeaf(false);
			if (this.isPanelPreviewLeaf(activeLeaf)) {
				this.markAsPermanent(activeLeaf);
			}
		}
	};

	/**
	 * 클릭이 파일 탐색기에서 왔는지 좁게 추정 / Narrow scope to File Explorer
	 */
	private isFromFileExplorer(target: HTMLElement): boolean {
		return (
			!!target.closest('.workspace-leaf-content[data-type="file-explorer"]') ||
			!!target.closest(".nav-files-container")
		);
	}

	/**
	 * 싱글클릭: preview로 열기 (✅ 패널별 preview 1개 유지)
	 * Single click: open as preview (keep 1 preview per panel)
	 */
	private handleClick = (evt: MouseEvent) => {
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
	 * Double click: open as permanent (only within the active panel)
	 */
	private handleDblClick = (evt: MouseEvent) => {
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
	 * Double click on tab header: promote preview (per panel)
	 */
	private handleHeaderDblClick = (evt: MouseEvent) => {
		const target = evt.target as HTMLElement;
		const tabHeader = target.closest(".workspace-tab-header");
		if (!tabHeader) return;

		for (const [, leaf] of this.previewByPanel.entries()) {
			const headerEl = this.getTabHeaderEl(leaf);
			if (headerEl && headerEl === tabHeader) {
				evt.preventDefault();
				evt.stopPropagation();
				evt.stopImmediatePropagation();
				this.markAsPermanent(leaf);
				return;
			}
		}
	};

	/**
	 * 파일 열기 로직 / File open logic
	 *
	 * Track 2.1 hardening:
	 * KR:
	 *  - 클릭 이벤트를 가로채므로(preventDefault), 여기서 "패널 식별 실패"가 나면 무반응이 됩니다.
	 *  - 따라서 panel을 못 잡아도, 최소한 현재 leaf에라도 파일을 열어 UX를 보장합니다.
	 *
	 * EN:
	 *  - Since we intercept clicks (preventDefault), failing to detect a panel would cause "no-op".
	 *  - If panel identity is unavailable, we still open the file in the active leaf as a fallback.
	 */
	private async openFileLogic(file: TFile, isDoubleClick: boolean) {
		const activeLeaf = this.app.workspace.getLeaf(false);
		const panel = this.getPanelParent(activeLeaf);

		// ✅ Fallback: panel을 못 잡아도 "무반응"은 절대 나오면 안 됨
		// If panel cannot be determined, still open the file in the active leaf.
		if (!panel) {
			await activeLeaf.openFile(file);
			this.app.workspace.setActiveLeaf(activeLeaf, { focus: true });

			if (isDoubleClick) {
				this.markAsPermanent(activeLeaf);
			} else {
				// panel을 모르면 per-panel 상태 저장은 못하지만, 표시(best-effort)는 적용 가능
				this.applyPreviewStyling(activeLeaf);
			}
			return;
		}

		// (옵션) 같은 패널에서만 중복 탭 포커스 / Focus existing only in the same panel
		if (this.settings.jumpToDuplicate) {
			const existingLeaf = this.findLeafWithFileInPanel(file, panel);
			if (existingLeaf) {
				this.app.workspace.setActiveLeaf(existingLeaf, { focus: true });

				// Double-click implies permanence: promote if it is a preview leaf
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
	 * Double click: open as permanent within the active panel
	 */
	private async handleDoubleClickInPanel(file: TFile, activeLeaf: WorkspaceLeaf) {
		const panel = this.getPanelParent(activeLeaf);
		if (!panel) {
			await activeLeaf.openFile(file);
			this.app.workspace.setActiveLeaf(activeLeaf, { focus: true });
			this.markAsPermanent(activeLeaf);
			return;
		}

		// If the preview tab in this panel is already showing the file, promote it
		const preview = this.getPreviewLeafForPanel(panel);
		if (preview && this.getLeafFilePath(preview) === file.path) {
			this.markAsPermanent(preview);
			this.app.workspace.setActiveLeaf(preview, { focus: true });
			return;
		}

		const leaf = this.createNewTabInSamePanel(activeLeaf);
		await leaf.openFile(file);
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
		this.markAsPermanent(leaf);
	}

	/**
	 * 싱글클릭: 활성 패널 안에서만 preview로 열기 (패널별 preview 1개 유지)
	 * Single click: open as preview within the active panel (one preview per panel)
	 */
	private async handleSingleClickInPanel(file: TFile, activeLeaf: WorkspaceLeaf) {
		const panel = this.getPanelParent(activeLeaf);
		if (!panel) {
			await activeLeaf.openFile(file);
			this.app.workspace.setActiveLeaf(activeLeaf, { focus: true });
			this.applyPreviewStyling(activeLeaf);
			return;
		}

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

		// Case B: reuse empty tab (option)
		if (canReuseEmpty) {
			if (previewValid && preview && preview !== activeLeaf) {
				if (this.settings.promoteOldPreview) {
					this.markAsPermanent(preview);
				} else {
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

		// Case C: reuse existing preview leaf
		if (previewValid && preview) {
			await preview.openFile(file);
			this.app.workspace.setActiveLeaf(preview, { focus: true });
			this.markAsPreview(preview);
			return;
		}

		// Case D: create new tab in the same panel, use it as preview
		const newLeaf = this.createNewTabInSamePanel(activeLeaf);
		await newLeaf.openFile(file);
		this.app.workspace.setActiveLeaf(newLeaf, { focus: true });
		this.markAsPreview(newLeaf);
	}

	/**
	 * 같은 패널에 새 탭 생성 (가능하면 createLeafInParent 사용)
	 * Create a new tab in the same panel (best-effort)
	 */
	private createNewTabInSamePanel(activeLeaf: WorkspaceLeaf): WorkspaceLeaf {
		const panel = this.getPanelParent(activeLeaf);

		// Fallback if panel identity is unavailable
		if (!panel || !panel.children) {
			return this.app.workspace.getLeaf("tab");
		}

		const workspace = this.app.workspace as ExtendedWorkspace;

		const activeIndex = panel.children.indexOf(activeLeaf as unknown as WorkspaceItem);
		const nextToActive = Math.max(0, activeIndex + 1);

		const index = this.settings.openNewTabAtEnd ? panel.children.length : nextToActive;

		try {
			return workspace.createLeafInParent(panel, index);
		} catch {
			return this.app.workspace.getLeaf("tab");
		}
	}

	/**
	 * 같은 패널에서 특정 파일이 열린 leaf 찾기
	 * Find a leaf that already has the file open in the same panel
	 */
	private findLeafWithFileInPanel(file: TFile, panel: LeafParent): WorkspaceLeaf | null {
		let result: WorkspaceLeaf | null = null;

		this.app.workspace.iterateAllLeaves((leaf) => {
			const openedPath = this.getLeafFilePath(leaf);
			if (openedPath !== file.path) return;

			const p = this.getPanelParent(leaf);
			if (p === panel) result = leaf;
		});

		return result;
	}

	/**
	 * 패널 parent 추출 (best-effort)
	 * Extract panel identity (best-effort)
	 *
	 * KR: 공식적인 패널 ID가 없어서 leaf.parent를 사용합니다.
	 * EN: No official panel id; using leaf.parent as best-effort identity.
	 */
	private getPanelParent(leaf: WorkspaceLeaf): LeafParent | null {
		const obj = leaf as unknown as Partial<ExtendedLeaf>;
		return obj.parent ?? null;
	}

	/**
	 * 두 leaf가 같은 패널인지
	 * Check whether two leaves belong to the same panel
	 */
	private isSamePanel(leaf1: WorkspaceLeaf | null, leaf2: WorkspaceLeaf | null): boolean {
		if (!leaf1 || !leaf2) return false;
		const p1 = this.getPanelParent(leaf1);
		const p2 = this.getPanelParent(leaf2);
		return !!p1 && p1 === p2;
	}

	/**
	 * 해당 패널의 preview leaf 가져오기(유효성 포함)
	 * Get preview leaf for a panel (with validity checks)
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
	 * Check if the leaf is the preview leaf for its panel
	 */
	private isPanelPreviewLeaf(leaf: WorkspaceLeaf): boolean {
		const panel = this.getPanelParent(leaf);
		if (!panel) return false;
		const preview = this.previewByPanel.get(panel);
		return preview === leaf;
	}

	/**
	 * layout-change 등에서 previewByPanel 정리
	 * Cleanup preview map on layout changes
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
	 * Check whether a leaf is still present in the workspace (public iteration)
	 */
	private isLeafStillPresent(leaf: WorkspaceLeaf): boolean {
		let present = false;
		this.app.workspace.iterateAllLeaves((l) => {
			if (l === leaf) present = true;
		});
		return present;
	}

	/**
	 * leaf.view에서 현재 열린 파일 경로를 안전하게 추출
	 * Safely extract opened file path from leaf.view
	 */
	private getLeafFilePath(leaf: WorkspaceLeaf): string | null {
		const view = leaf.view as unknown;
		if (typeof view !== "object" || view === null) return null;

		const v = view as FileLikeView;
		const path = v.file?.path;

		return typeof path === "string" ? path : null;
	}

	/**
	 * 탭 헤더 엘리먼트 best-effort 추출
	 * Best-effort get tab header element
	 */
	private getTabHeaderEl(leaf: WorkspaceLeaf): HTMLElement | null {
		const obj = leaf as unknown as Partial<ExtendedLeaf>;
		const el = obj.tabHeaderEl;
		return el instanceof HTMLElement ? el : null;
	}

	/**
	 * panel을 모르는 fallback 상황에서도 "표시"만 적용
	 * Apply preview styling only (when panel identity is unavailable)
	 */
	private applyPreviewStyling(leaf: WorkspaceLeaf) {
		if (!this.settings.useItalicTitle) return;
		const headerEl = this.getTabHeaderEl(leaf);
		if (!headerEl) return;
		headerEl.classList.add(PREVIEW_CLASS);
	}

	/**
	 * preview 표시(패널별로 저장)
	 * Mark as preview (per panel)
	 *
	 * KR:
	 *  - tabHeaderEl이 없으면 스타일링만 스킵합니다.
	 *  - 이 경우에도 previewByPanel 상태는 유지되어 "임시탭 동작"은 계속됩니다.
	 *
	 * EN:
	 *  - If tabHeaderEl is unavailable, we skip styling only.
	 *  - Even then, previewByPanel state is kept, so preview behavior still works.
	 */
	private markAsPreview(leaf: WorkspaceLeaf) {
		const panel = this.getPanelParent(leaf);
		if (!panel) {
			// No panel identity: can't store per-panel state, styling only.
			this.applyPreviewStyling(leaf);
			return;
		}

		this.previewByPanel.set(panel, leaf);

		const headerEl = this.getTabHeaderEl(leaf);
		if (!headerEl) return;

		if (this.settings.useItalicTitle) {
			headerEl.classList.add(PREVIEW_CLASS);
		} else {
			headerEl.classList.remove(PREVIEW_CLASS);
		}
	}

	/**
	 * 일반탭 승격(패널별 preview 해제)
	 * Promote to permanent (remove per-panel preview mark)
	 */
	private markAsPermanent(leaf: WorkspaceLeaf) {
		const panel = this.getPanelParent(leaf);
		if (panel) {
			const preview = this.previewByPanel.get(panel);
			if (preview === leaf) {
				this.previewByPanel.delete(panel);
			}
		}

		const headerEl = this.getTabHeaderEl(leaf);
		if (headerEl) {
			headerEl.classList.remove(PREVIEW_CLASS);
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
			.setDesc(
				"Show preview tabs with italic titles (best-effort UI). / 미리보기 탭 제목을 이탤릭으로 표시합니다(표시용, best-effort)."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.useItalicTitle).onChange(async (value) => {
					this.plugin.settings.useItalicTitle = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Reuse empty tab (locality)")
			.setDesc(
				"Use the active empty tab in the current panel for opening files. / 현재 패널의 빈 탭을 우선 재사용합니다."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.reuseEmptyTab).onChange(async (value) => {
					this.plugin.settings.reuseEmptyTab = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Promote old preview (same panel only)")
			.setDesc(
				"When moving preview within a panel, keep the old preview as a permanent tab. / 같은 패널에서 미리보기 위치를 옮길 때 기존 미리보기를 일반 탭으로 남깁니다."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.promoteOldPreview)
					.onChange(async (value) => {
						this.plugin.settings.promoteOldPreview = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Focus existing tab (same panel only)")
			.setDesc(
				"If the file is already open in the same panel, focus it instead of opening a duplicate. / 같은 패널에 이미 열려 있으면 그 탭으로 이동합니다."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.jumpToDuplicate).onChange(async (value) => {
					this.plugin.settings.jumpToDuplicate = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Open new tab at the end")
			.setDesc(
				"Create new tabs at the end of the tab bar in the current panel. / 현재 패널의 탭바 끝에 새 탭을 만듭니다."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.openNewTabAtEnd)
					.onChange(async (value) => {
						this.plugin.settings.openNewTabAtEnd = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
