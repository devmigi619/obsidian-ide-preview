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
 */

interface ExtendedWorkspace extends Workspace {
	createLeafInParent(parent: WorkspaceItem, index: number): WorkspaceLeaf;
}

type LeafParent = WorkspaceItem & {
	children: WorkspaceItem[];
};

interface ExtendedLeaf extends WorkspaceLeaf {
	tabHeaderEl?: HTMLElement;
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

type FileLikeView = {
	file?: {
		path?: unknown;
	};
};

type EditorChangeInfoLike = {
	leaf?: WorkspaceLeaf;
};

export default class PreviewModePlugin extends Plugin {
	settings: PreviewModeSettings;

	/** 패널별 preview leaf */
	private previewByPanel = new Map<LeafParent, WorkspaceLeaf>();

	/** 파일 생성 복구용 상태 */
	private fileCreationState: {
		newFile: TFile | null;
		hijackedLeaf: WorkspaceLeaf | null;
		oldFile: TFile | null;
	} = {
		newFile: null,
		hijackedLeaf: null,
		oldFile: null,
	};

	/** 삭제 후 중복 탭 정리용 상태 */
	private deleteState: {
		deletedPath: string | null;
		affectedLeaves: WorkspaceLeaf[];
	} = {
		deletedPath: null,
		affectedLeaves: [],
	};

	/**
	 * ✅ 핵심: 마지막으로 활성화된 "markdown 노트 leaf"를 기억해 둔다
	 * - 검색/북마크/탐색기 같은 "비-markdown" 뷰에서 클릭해도
	 *   이 leaf의 패널을 기준으로 파일을 열도록 하기 위함.
	 */
	private lastMarkdownLeaf: WorkspaceLeaf | null = null;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new PreviewModeSettingTab(this.app, this));

		// "마지막 markdown leaf" 추적
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				if (!leaf) return;
				if (this.isMarkdownFileLeaf(leaf)) {
					this.lastMarkdownLeaf = leaf;
				}
			})
		);

		// Explorer/Bookmarks/Search 등 네비게이션 클릭 가로채기 (capture)
		this.registerDomEvent(document, "click", this.handleClick, true);
		this.registerDomEvent(document, "dblclick", this.handleDblClick, true);
		this.registerDomEvent(document, "dblclick", this.handleHeaderDblClick, true);
		this.registerDomEvent(document, "input", this.handleInput, true);

		this.setupFileCreationHandling();
		this.setupDeleteCleanupHandling();

		// 파일 이름 변경 시: 해당 패널의 preview였다면 승격
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

		// 편집 시작 시: 해당 패널의 preview였다면 승격
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

		// 레이아웃 변경 시: 패널별 preview 유효성 정리
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				this.cleanupPreviewMap();
				if (this.lastMarkdownLeaf && !this.isLeafStillPresent(this.lastMarkdownLeaf)) {
					this.lastMarkdownLeaf = null;
				}
			})
		);
	}

	onunload() {
		document.querySelectorAll(`.${PREVIEW_CLASS}`).forEach((el) => {
			el.classList.remove(PREVIEW_CLASS);
		});

		this.previewByPanel.clear();
		this.fileCreationState = { newFile: null, hijackedLeaf: null, oldFile: null };
		this.deleteState = { deletedPath: null, affectedLeaves: [] };
		this.lastMarkdownLeaf = null;
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/**
	 * 파일 생성 감지 및 복구 로직 (이벤트 기반)
	 */
	private setupFileCreationHandling() {
		// create: 스냅샷 저장
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

		// file-open: 다음 이벤트에서만 처리/폐기
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				const state = this.fileCreationState;
				if (!state.newFile) return;

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
	 * 삭제 후 중복 탭/유령 탭 정리 (1번 문제 해결 로직)
	 */
	private setupDeleteCleanupHandling() {
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (!(file instanceof TFile)) return;

				const affected: WorkspaceLeaf[] = [];
				this.app.workspace.iterateAllLeaves((leaf) => {
					const openedPath = this.getLeafFilePath(leaf);
					if (openedPath === file.path) affected.push(leaf);
				});

				this.deleteState = { deletedPath: file.path, affectedLeaves: affected };

				setTimeout(() => {
					requestAnimationFrame(() => {
						requestAnimationFrame(() => {
							void this.cleanupAfterDelete();
						});
					});
				}, 0);
			})
		);
	}

	private async cleanupAfterDelete() {
		const { deletedPath, affectedLeaves } = this.deleteState;
		this.deleteState = { deletedPath: null, affectedLeaves: [] };
		if (!deletedPath) return;

		for (const leaf of affectedLeaves) {
			if (!this.isLeafStillPresent(leaf)) continue;

			const nowPath = this.getLeafFilePath(leaf);

			if (!nowPath || nowPath === deletedPath) {
				await this.setLeafEmptyBestEffort(leaf);
				continue;
			}

			const panel = this.getPanelParent(leaf);
			if (!panel) continue;

			const nowFile = this.app.vault.getAbstractFileByPath(nowPath);
			if (!(nowFile instanceof TFile)) continue;

			const other = this.findOtherLeafWithFileInPanel(nowFile, panel, leaf);
			if (!other) continue;

			await this.closeLeafBestEffort(leaf);
			this.app.workspace.setActiveLeaf(other, { focus: true });
		}
	}

	private async closeLeafBestEffort(leaf: WorkspaceLeaf) {
		const anyLeaf = leaf as any;

		if (typeof anyLeaf.detach === "function") {
			try {
				anyLeaf.detach();
				return;
			} catch {
				// ignore
			}
		}

		await this.setLeafEmptyBestEffort(leaf);
	}

	private async setLeafEmptyBestEffort(leaf: WorkspaceLeaf) {
		try {
			const anyLeaf = leaf as any;
			if (typeof anyLeaf.setViewState === "function") {
				await anyLeaf.setViewState({ type: "empty", active: false });
			}
		} catch {
			// ignore
		}
	}

	/**
	 * Best-effort: inline title focus & select
	 */
	private focusInlineTitleAndSelect(leaf: WorkspaceLeaf): boolean {
		const viewAny = leaf.view as any;
		const container: HTMLElement | undefined = viewAny?.containerEl;
		if (!(container instanceof HTMLElement)) return false;

		const titleEl = container.querySelector(".inline-title") as HTMLElement | null;
		if (!titleEl) return false;

		titleEl.focus();

		try {
			const sel = window.getSelection();
			if (!sel) return true;

			const range = document.createRange();
			range.selectNodeContents(titleEl);
			sel.removeAllRanges();
			sel.addRange(range);
		} catch {
			// ignore
		}

		return true;
	}

	private focusEditorBestEffort(leaf: WorkspaceLeaf) {
		const viewAny = leaf.view as any;

		try {
			if (viewAny?.editor?.focus) {
				viewAny.editor.focus();
				return;
			}
		} catch {}

		try {
			const container: HTMLElement | undefined = viewAny?.containerEl;
			if (container instanceof HTMLElement) container.focus();
		} catch {}
	}

	private ensureTitleEditAfterCreate(targetLeaf: WorkspaceLeaf, createdFile: TFile) {
		const openedPath = this.getLeafFilePath(targetLeaf);
		if (openedPath !== createdFile.path) return;

		setTimeout(() => {
			requestAnimationFrame(() => {
				this.app.workspace.setActiveLeaf(targetLeaf, { focus: true });
				this.app.commands.executeCommandById("rename-current-file");

				requestAnimationFrame(() => {
					const ok = this.focusInlineTitleAndSelect(targetLeaf);
					if (!ok) this.focusEditorBestEffort(targetLeaf);

					requestAnimationFrame(() => {
						const ok2 = this.focusInlineTitleAndSelect(targetLeaf);
						if (!ok2) this.focusEditorBestEffort(targetLeaf);
					});
				});
			});
		}, 0);
	}

	private handleFileCreation(
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
				this.ensureTitleEditAfterCreate(currentLeaf, newFile);

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

		// Case 2-1: 복구할 파일이 없음
		if (!oldFile || oldFile.path === newFile.path) {
			setTimeout(() => {
				this.markAsPermanent(currentLeaf);
				this.ensureTitleEditAfterCreate(currentLeaf, newFile);
			}, 0);
			return;
		}

		// Case 2-2: 복구 필요
		setTimeout(() => {
			void this.restoreHijackedTab(currentLeaf, oldFile, newFile);
		}, 0);
	}

	private async restoreHijackedTab(
		hijackedLeaf: WorkspaceLeaf,
		oldFile: TFile,
		newFile: TFile
	) {
		const parent = this.getPanelParent(hijackedLeaf);

		if (!parent || !parent.children) {
			this.markAsPermanent(hijackedLeaf);
			this.ensureTitleEditAfterCreate(hijackedLeaf, newFile);
			return;
		}

		const hijackedIndex = parent.children.indexOf(hijackedLeaf as unknown as WorkspaceItem);
		if (hijackedIndex === -1) {
			this.markAsPermanent(hijackedLeaf);
			this.ensureTitleEditAfterCreate(hijackedLeaf, newFile);
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
			const fallbackLeaf = this.app.workspace.getLeaf("tab");
			await fallbackLeaf.openFile(oldFile);
			this.markAsPermanent(fallbackLeaf);
		}

		this.app.workspace.setActiveLeaf(hijackedLeaf, { focus: true });
		this.markAsPermanent(hijackedLeaf);

		this.ensureTitleEditAfterCreate(hijackedLeaf, newFile);
	}

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
	 * ✅ “이 leaf가 markdown 노트(FileView markdown)인가?”
	 */
	private isMarkdownFileLeaf(leaf: WorkspaceLeaf): boolean {
		const view = leaf.view;
		if (!(view instanceof FileView)) return false;
		// markdown 파일 뷰는 보통 view.getViewType() === "markdown"
		return view.getViewType() === "markdown";
	}

	/**
	 * ✅ 네비게이션(검색/북마크/탐색기 등)에서 클릭했을 때,
	 * “열기를 적용할 기준 leaf(패널)”을 결정한다.
	 *
	 * - 클릭이 markdown leaf 내부라면: 현재 활성 leaf 사용
	 * - 클릭이 비-markdown leaf(검색/북마크/탐색기 등)라면:
	 *   마지막 markdown leaf를 우선 사용 (없으면 active leaf fallback)
	 */
	private getBaseLeafForOpen(clickTarget: HTMLElement): WorkspaceLeaf {
		const leafContent = clickTarget.closest<HTMLElement>(".workspace-leaf-content");
		const leafType = leafContent?.getAttribute("data-type") ?? null;

		// markdown leaf에서 발생한 클릭(우리는 보통 isSafeNavArea에서 막지만, 안전하게)
		if (leafType === "markdown") {
			return this.app.workspace.getLeaf(false);
		}

		// 비-markdown 뷰(탐색기/북마크/검색/그래프 등): 마지막 markdown 패널을 기준으로
		if (this.lastMarkdownLeaf && this.isLeafStillPresent(this.lastMarkdownLeaf)) {
			return this.lastMarkdownLeaf;
		}

		// fallback
		return this.app.workspace.getLeaf(false);
	}

	private resolveToFile(candidate: string | null): TFile | null {
		if (!candidate) return null;

		const byPath = this.app.vault.getAbstractFileByPath(candidate);
		if (byPath instanceof TFile) return byPath;

		const byLink = this.app.metadataCache.getFirstLinkpathDest(candidate, "");
		if (byLink instanceof TFile) return byLink;

		return null;
	}

	/**
	 * Search 결과의 title 텍스트가 "Mumbler1"처럼 붙는 경우가 있어서,
	 * - 원문
	 * - 숫자 꼬리 제거본
	 * 두 후보로 resolve 시도.
	 */
	private getSearchTitleCandidates(titleEl: HTMLElement): string[] {
		const raw = (titleEl.textContent ?? "").trim();
		if (!raw) return [];

		const stripped = raw.replace(/\s*\d+\s*$/, "").trim();

		const out: string[] = [];
		out.push(raw);
		if (stripped && stripped !== raw) out.push(stripped);

		return Array.from(new Set(out));
	}

	private resolveAny(candidates: string[]): TFile | null {
		for (const c of candidates) {
			const f = this.resolveToFile(c);
			if (f) return f;
		}
		return null;
	}

	/**
	 * 클릭된 DOM에서 파일을 최대한 일반적으로 추출
	 * - data-path / data-href / a[href] / obsidian://open
	 * - search 뷰는 구조상 속성이 없으므로 “결과 블록의 title 텍스트”로 resolve
	 */
	private extractFileFromClick(target: HTMLElement): TFile | null {
		// A) data-path
		const byPath = target.closest<HTMLElement>("[data-path]");
		const dataPath = byPath?.getAttribute("data-path") ?? null;
		{
			const f = this.resolveToFile(dataPath);
			if (f) return f;
		}

		// B) data-href
		const byHref = target.closest<HTMLElement>("[data-href]");
		const dataHref = byHref?.getAttribute("data-href") ?? null;
		{
			const f = this.resolveToFile(dataHref);
			if (f) return f;
		}

		// C) anchor href
		const a = target.closest<HTMLAnchorElement>("a[href]");
		const href = a?.getAttribute("href") ?? null;
		if (href) {
			if (href.startsWith("obsidian://open")) {
				try {
					const url = new URL(href);
					const p = url.searchParams.get("path");
					if (p) {
						const decoded = decodeURIComponent(p);
						const f = this.resolveToFile(decoded);
						if (f) return f;
					}
				} catch {
					// ignore
				}
			}

			const f = this.resolveToFile(href);
			if (f) return f;
		}

		// D) Search leaf fallback: 제목 클릭/매칭 라인 클릭 모두 “.search-result” 기준으로 처리
		const leafContent = target.closest<HTMLElement>(".workspace-leaf-content");
		const leafType = leafContent?.getAttribute("data-type") ?? null;

		if (leafType === "search") {
			const searchResult = target.closest<HTMLElement>(".search-result");
			const titleEl =
				searchResult?.querySelector<HTMLElement>(".search-result-file-title") ??
				target.closest<HTMLElement>(".search-result-file-title");

			if (titleEl) {
				const candidates = this.getSearchTitleCandidates(titleEl);
				const f = this.resolveAny(candidates);
				if (f) return f;
			}
		}

		return null;
	}

	/**
	 * 안전 영역 판단
	 * - markdown 편집/프리뷰 내부는 건드리지 않는다
	 */
	private isSafeNavArea(target: HTMLElement): boolean {
		const leafContent = target.closest<HTMLElement>(".workspace-leaf-content");
		if (!leafContent) return false;

		// do not intercept actual note editor/preview
		if (target.closest(".markdown-preview-view")) return false;
		if (target.closest(".cm-editor")) return false;

		return true;
	}

	private handleClick = (evt: MouseEvent) => {
		const target = evt.target as HTMLElement;
		if (evt.ctrlKey || evt.metaKey || evt.shiftKey) return;
		if (!this.isSafeNavArea(target)) return;

		const file = this.extractFileFromClick(target);
		if (!file) return;

		evt.preventDefault();
		evt.stopPropagation();
		evt.stopImmediatePropagation();

		const baseLeaf = this.getBaseLeafForOpen(target);
		void this.openFileLogic(file, false, baseLeaf);
	};

	private handleDblClick = (evt: MouseEvent) => {
		const target = evt.target as HTMLElement;
		if (!this.isSafeNavArea(target)) return;

		const file = this.extractFileFromClick(target);
		if (!file) return;

		evt.preventDefault();
		evt.stopPropagation();
		evt.stopImmediatePropagation();

		const baseLeaf = this.getBaseLeafForOpen(target);
		void this.openFileLogic(file, true, baseLeaf);
	};

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
	 * ✅ baseLeaf를 명시적으로 받아서 “어느 패널 기준으로 열지”를 고정한다.
	 * - 검색/북마크/탐색기 클릭에서 의도대로 동작하게 만드는 핵심 수정점.
	 */
	private async openFileLogic(file: TFile, isDoubleClick: boolean, baseLeaf: WorkspaceLeaf) {
		const activeLeaf = baseLeaf;
		const panel = this.getPanelParent(activeLeaf);

		if (!panel) {
			await activeLeaf.openFile(file);
			this.app.workspace.setActiveLeaf(activeLeaf, { focus: true });

			if (isDoubleClick) {
				this.markAsPermanent(activeLeaf);
			} else {
				this.applyPreviewStyling(activeLeaf);
			}
			return;
		}

		if (this.settings.jumpToDuplicate) {
			const existingLeaf = this.findLeafWithFileInPanel(file, panel);
			if (existingLeaf) {
				this.app.workspace.setActiveLeaf(existingLeaf, { focus: true });

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

	private async handleDoubleClickInPanel(file: TFile, activeLeaf: WorkspaceLeaf) {
		const panel = this.getPanelParent(activeLeaf);
		if (!panel) {
			await activeLeaf.openFile(file);
			this.app.workspace.setActiveLeaf(activeLeaf, { focus: true });
			this.markAsPermanent(activeLeaf);
			return;
		}

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

		// Case B: reuse empty tab
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

	private createNewTabInSamePanel(activeLeaf: WorkspaceLeaf): WorkspaceLeaf {
		const panel = this.getPanelParent(activeLeaf);

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

	private findLeafWithFileInPanel(file: TFile, panel: LeafParent): WorkspaceLeaf | null {
		let result: WorkspaceLeaf | null = null;

		this.app.workspace.iterateAllLeaves((leaf) => {
			if (result) return;
			const openedPath = this.getLeafFilePath(leaf);
			if (openedPath !== file.path) return;

			const p = this.getPanelParent(leaf);
			if (p === panel) result = leaf;
		});

		return result;
	}

	private findOtherLeafWithFileInPanel(
		file: TFile,
		panel: LeafParent,
		excludeLeaf: WorkspaceLeaf
	): WorkspaceLeaf | null {
		let result: WorkspaceLeaf | null = null;

		this.app.workspace.iterateAllLeaves((leaf) => {
			if (result) return;
			if (leaf === excludeLeaf) return;

			const openedPath = this.getLeafFilePath(leaf);
			if (openedPath !== file.path) return;

			const p = this.getPanelParent(leaf);
			if (p === panel) result = leaf;
		});

		return result;
	}

	private getPanelParent(leaf: WorkspaceLeaf): LeafParent | null {
		const obj = leaf as unknown as { parent?: unknown };
		const parent = obj.parent;

		if (typeof parent !== "object" || parent === null) return null;

		const maybe = parent as { children?: unknown };
		if (!Array.isArray(maybe.children)) return null;

		return parent as LeafParent;
	}

	private isSamePanel(leaf1: WorkspaceLeaf | null, leaf2: WorkspaceLeaf | null): boolean {
		if (!leaf1 || !leaf2) return false;
		const p1 = this.getPanelParent(leaf1);
		const p2 = this.getPanelParent(leaf2);
		return !!p1 && p1 === p2;
	}

	private getPreviewLeafForPanel(panel: LeafParent): WorkspaceLeaf | null {
		const leaf = this.previewByPanel.get(panel) ?? null;
		if (!leaf) return null;
		if (!this.isLeafStillPresent(leaf)) {
			this.previewByPanel.delete(panel);
			return null;
		}
		return leaf;
	}

	private isPanelPreviewLeaf(leaf: WorkspaceLeaf): boolean {
		const panel = this.getPanelParent(leaf);
		if (!panel) return false;
		const preview = this.previewByPanel.get(panel);
		return preview === leaf;
	}

	private cleanupPreviewMap() {
		for (const [panel, leaf] of this.previewByPanel.entries()) {
			if (!leaf || !this.isLeafStillPresent(leaf)) {
				this.previewByPanel.delete(panel);
			}
		}
	}

	private isLeafStillPresent(leaf: WorkspaceLeaf): boolean {
		let present = false;
		this.app.workspace.iterateAllLeaves((l) => {
			if (l === leaf) present = true;
		});
		return present;
	}

	private getLeafFilePath(leaf: WorkspaceLeaf): string | null {
		const view = leaf.view as unknown;
		if (typeof view !== "object" || view === null) return null;

		const v = view as FileLikeView;
		const path = v.file?.path;

		return typeof path === "string" ? path : null;
	}

	private getTabHeaderEl(leaf: WorkspaceLeaf): HTMLElement | null {
		const obj = leaf as unknown as Partial<ExtendedLeaf>;
		const el = obj.tabHeaderEl;
		return el instanceof HTMLElement ? el : null;
	}

	private applyPreviewStyling(leaf: WorkspaceLeaf) {
		if (!this.settings.useItalicTitle) return;
		const headerEl = this.getTabHeaderEl(leaf);
		if (!headerEl) return;
		headerEl.classList.add(PREVIEW_CLASS);
	}

	private markAsPreview(leaf: WorkspaceLeaf) {
		const panel = this.getPanelParent(leaf);
		if (!panel) {
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
