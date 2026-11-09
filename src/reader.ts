import type { InvokeArgs } from "@tauri-apps/api/core";
import { LocalBookmarkStore, type Bookmark, type BookmarkStore } from "./bookmarks";

const HEADER = 20;
const IMAGE_MAX = 32 * 1024 * 1024;
const METADATA_MAX = 4 * 1024;
const MAX_DIMENSION = 8192;
const MAX_PIXELS = 8_388_608;
const MAX_SEARCH_RESULTS = 250;
const MAX_SEARCH_EXCERPT_BYTES = 128;
const VERSION = 1;
const PAGE_KIND = 0x8003;
const PREFETCH_INITIAL_DELAY_MS = 250;
const PREFETCH_CONTINUATION_DELAY_MS = 16;
const PREFETCH_NEARBY_PAGES = 3;
const PREFETCH_RECOMMENDED_PAGES = 12;
const PREFETCH_MAXIMUM_PAGES = 30;
const PREFETCH_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const DECODED_PAGE_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const PAGE_CACHE_BACKTRACK = 2;
const PAGE_CACHE_MAX_PAGES = 30;
const MAX_TABS = 100;
const MAX_RECENT_FILES = 10;
const RECENT_STORAGE_KEY = "lithexpdf.recent";
const RENDER_MODE_STORAGE_KEY = "lithexpdf.renderMode.v3";
const APP_VERSION = "0.1.0";

type RenderMode = "current" | "nearby" | "balanced" | "maximum";
type PageRotation = 0 | 90 | 180 | 270;

interface ReaderTab {
  id: string;
  path: string;
  name: string;
  pageIndex: number;
  zoom: number;
  rotation: PageRotation;
  scrollTop: number;
  scrollLeft: number;
}

interface PrefetchTask {
  pageIndex: number;
  requestToken: string;
  generationToken: number;
  cancelled: boolean;
  promoted: boolean;
  promise: Promise<ArrayBuffer | undefined>;
}

interface CachedPageImage {
  image: HTMLImageElement;
  objectUrl: string;
  encodedBytes: number;
  decodedBytes: number;
  loaded: boolean;
}

export interface OpenPdfResult {
  document_id: string;
  generation: number;
  page_count: number;
  page_width_points: number;
  page_height_points: number;
}

export interface RenderIdentity {
  documentId: string;
  generation: number;
  pageIndex: number;
  tabId?: Uint8Array;
}

export interface ParsedPage { requestId: bigint; width: number; height: number; png: Uint8Array; }

export interface TextSearchMatch { page_index: number; text: string; }
export interface TextSearchResponse { matches: TextSearchMatch[]; truncated: boolean; }

export function parseRenderResponse(buffer: ArrayBuffer, expected: RenderIdentity): ParsedPage {
  if (buffer.byteLength < HEADER + 42 || buffer.byteLength > HEADER + IMAGE_MAX + METADATA_MAX) throw new Error("The PDF worker returned a response with an invalid size.");
  const bytes = new Uint8Array(buffer);
  if (bytes[0] !== 0x50 || bytes[1] !== 0x44 || bytes[2] !== 0x46 || bytes[3] !== 0x57) throw new Error("The PDF worker response has an invalid signature.");
  const view = new DataView(buffer);
  if (view.getUint16(4, false) !== VERSION) throw new Error("This PDF worker protocol version is not supported.");
  if (view.getUint16(6, false) !== PAGE_KIND) throw new Error("The PDF worker response is not a page image.");
  const requestId = view.getBigUint64(8, false);
  if (requestId === 0n) throw new Error("The PDF worker returned an invalid request identifier.");
  const payloadLength = view.getUint32(16, false);
  if (payloadLength > IMAGE_MAX + METADATA_MAX || HEADER + payloadLength !== bytes.byteLength) throw new Error("The PDF worker response length is invalid.");
  const tabId = bytes.subarray(HEADER, HEADER + 16);
  const generation = view.getBigUint64(HEADER + 16, false);
  const pageIndex = view.getUint32(HEADER + 24, false);
  const width = view.getUint32(HEADER + 28, false);
  const height = view.getUint32(HEADER + 32, false);
  const contentType = view.getUint16(HEADER + 36, false);
  const imageLength = view.getUint32(HEADER + 38, false);
  if (expected.tabId && !equalBytes(tabId, expected.tabId)) throw new Error("The PDF page belongs to a different document.");
  if (generation !== BigInt(expected.generation) || pageIndex !== expected.pageIndex) throw new Error("The PDF page is stale and was discarded.");
  if (contentType !== 1) throw new Error("The PDF worker returned an unsupported image format.");
  const pixels = BigInt(width) * BigInt(height);
  if (width === 0 || height === 0 || width > MAX_DIMENSION || height > MAX_DIMENSION || pixels > BigInt(MAX_PIXELS) || pixels * 4n > 32n * 1024n * 1024n) throw new Error("The PDF worker returned image dimensions outside the allowed limits.");
  if (imageLength === 0 || imageLength > IMAGE_MAX || payloadLength - 42 !== imageLength) throw new Error("The PDF worker image payload length is invalid.");
  const png = bytes.subarray(HEADER + 42);
  if (png[0] !== 0x89 || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) throw new Error("The PDF worker image is not a PNG.");
  return { requestId, width, height, png };
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export interface ReaderBridge {
  pickPdf(): Promise<string | string[] | null>;
  invoke<T>(command: string, args?: InvokeArgs): Promise<T>;
  createObjectURL?(blob: Blob): string;
  revokeObjectURL?(url: string): void;
  bookmarks?: BookmarkStore;
}

export class PdfReaderUi {
  private image: HTMLImageElement;
  private readonly bootstrapImage: HTMLImageElement;
  private readonly pageStack: HTMLElement;
  private readonly viewer: HTMLElement;
  private readonly status: HTMLElement;
  private readonly loading: HTMLElement;
  private readonly error: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly pageNumber: HTMLInputElement;
  private readonly pageTotal: HTMLElement;
  private readonly name: HTMLElement;
  private readonly pageSize: HTMLElement;
  private readonly openButton: HTMLButtonElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly previousButton: HTMLButtonElement;
  private readonly nextButton: HTMLButtonElement;
  private readonly bookmarkButton: HTMLButtonElement;
  private readonly bookmarksToggle: HTMLButtonElement;
  private readonly bookmarksPanel: HTMLElement;
  private readonly bookmarksList: HTMLElement;
  private readonly bookmarksEmpty: HTMLElement;
  private readonly searchForm: HTMLFormElement;
  private readonly searchInput: HTMLInputElement;
  private readonly searchButton: HTMLButtonElement;
  private readonly searchPanel: HTMLElement;
  private readonly searchSummary: HTMLElement;
  private readonly searchResults: HTMLElement;
  private readonly searchMatchCase: HTMLInputElement;
  private readonly searchWholeWord: HTMLInputElement;
  private readonly bookmarkStore: BookmarkStore;
  private readonly tabStrip: HTMLElement | null;
  private readonly tabsEmpty: HTMLElement | null;
  private readonly newTabButton: HTMLButtonElement | null;
  private readonly menuButton: HTMLButtonElement | null;
  private readonly menuPanel: HTMLElement | null;
  private readonly recentMenuWrap: HTMLElement | null;
  private readonly recentTrigger: HTMLButtonElement | null;
  private readonly recentSubmenu: HTMLElement | null;
  private readonly recentList: HTMLElement | null;
  private readonly zoomInButton: HTMLButtonElement | null;
  private readonly zoomOutButton: HTMLButtonElement | null;
  private readonly rotateLeftButton: HTMLButtonElement | null;
  private readonly rotateRightButton: HTMLButtonElement | null;
  private readonly zoomLevel: HTMLElement | null;
  private readonly printButton: HTMLButtonElement | null;
  private readonly tabs: ReaderTab[] = [];
  private activeTabId?: string;
  private zoom = 1;
  private rotation: PageRotation = 0;
  private renderMode: RenderMode = readRenderMode();
  private recentPaths = readRecentPaths();
  private pageSlots: HTMLElement[] = [];
  private current?: OpenPdfResult;
  private currentPath?: string;
  private bookmarks: Bookmark[] = [];
  private pageIndex = 0;
  private renderedPageIndex?: number;
  private generationToken = 0;
  private renderToken = 0;
  private activeRequestToken?: string;
  private scrollTimer?: ReturnType<typeof setTimeout>;
  private prefetchTimer?: ReturnType<typeof setTimeout>;
  private prefetchTask?: PrefetchTask;
  private readonly pageImages = new Map<number, CachedPageImage>();
  private cachedEncodedBytes = 0;
  private cachedDecodedBytes = 0;
  private prefetchCursor = 0;
  private prefetchCapacityBlocked = false;
  private searchTimer?: ReturnType<typeof setTimeout>;
  private searchSequence = 0;
  private searchRunning = false;
  private queuedSearch?: { sequence: number; documentId: string; generation: number; query: string; matchCase: boolean; wholeWord: boolean };

  constructor(private readonly root: ParentNode, private readonly bridge: ReaderBridge) {
    this.bootstrapImage = this.required("#page-image");
    this.image = this.bootstrapImage;
    this.pageStack = this.required("#page-stack");
    this.viewer = this.required("#viewer");
    this.status = this.required("#status-text");
    this.loading = this.required("#loading-state");
    this.error = this.required("#error-state");
    this.empty = this.required("#empty-state");
    this.pageNumber = this.required("#page-number");
    this.pageTotal = this.required("#page-total");
    this.name = this.required("#document-name");
    this.pageSize = this.required("#page-size");
    this.openButton = this.required("#open-button");
    this.closeButton = this.required("#close-button");
    this.previousButton = this.required("#previous-button");
    this.nextButton = this.required("#next-button");
    this.bookmarkButton = this.required("#bookmark-current");
    this.bookmarksToggle = this.required("#bookmarks-toggle");
    this.bookmarksPanel = this.required("#bookmarks-panel");
    this.bookmarksList = this.required("#bookmark-list");
    this.bookmarksEmpty = this.required("#bookmarks-empty");
    this.searchForm = this.required("#search-form");
    this.searchInput = this.required("#search-input");
    this.searchButton = this.required("#search-button");
    this.searchPanel = this.required("#search-panel");
    this.searchSummary = this.required("#search-summary");
    this.searchResults = this.required("#search-results");
    this.searchMatchCase = this.required("#search-match-case");
    this.searchWholeWord = this.required("#search-whole-word");
    this.bookmarkStore = bridge.bookmarks ?? new LocalBookmarkStore();
    this.tabStrip = this.optional("#tab-strip");
    this.tabsEmpty = this.optional("#tabs-empty");
    this.newTabButton = this.optional<HTMLButtonElement>("#new-tab-button");
    this.menuButton = this.optional<HTMLButtonElement>("#menu-button");
    this.menuPanel = this.optional("#menu-panel");
    this.recentMenuWrap = this.optional(".recent-menu-wrap");
    this.recentTrigger = this.optional<HTMLButtonElement>("#recent-trigger");
    this.recentSubmenu = this.optional("#recent-submenu");
    this.recentList = this.optional("#recent-list");
    this.zoomInButton = this.optional<HTMLButtonElement>("#zoom-in-button");
    this.zoomOutButton = this.optional<HTMLButtonElement>("#zoom-out-button");
    this.rotateLeftButton = this.optional<HTMLButtonElement>("#rotate-left-button");
    this.rotateRightButton = this.optional<HTMLButtonElement>("#rotate-right-button");
    this.zoomLevel = this.optional("#zoom-level");
    this.printButton = this.optional<HTMLButtonElement>("#print-button");
    const versionElement = this.optional("#app-version");
    if (versionElement) versionElement.textContent = APP_VERSION;
    this.openButton.addEventListener("click", () => void this.openPicker());
    this.closeButton.addEventListener("click", () => void this.close());
    this.newTabButton?.addEventListener("click", () => void this.openPicker());
    this.zoomInButton?.addEventListener("click", () => this.changeZoom(0.1));
    this.zoomOutButton?.addEventListener("click", () => this.changeZoom(-0.1));
    this.rotateLeftButton?.addEventListener("click", () => this.rotateCurrentView(-90));
    this.rotateRightButton?.addEventListener("click", () => this.rotateCurrentView(90));
    this.printButton?.addEventListener("click", () => void this.printDocument());
    this.menuButton?.addEventListener("click", () => this.setMenuOpen(this.menuPanel?.hidden ?? true));
    this.recentMenuWrap?.addEventListener("pointerenter", () => this.setRecentMenuOpen(true));
    this.recentMenuWrap?.addEventListener("pointerleave", () => this.setRecentMenuOpen(false));
    this.recentMenuWrap?.addEventListener("focusin", () => this.setRecentMenuOpen(true));
    this.recentMenuWrap?.addEventListener("focusout", (event) => {
      const nextTarget = (event as FocusEvent).relatedTarget;
      if (!(nextTarget instanceof Node) || !this.recentMenuWrap?.contains(nextTarget)) this.setRecentMenuOpen(false);
    });
    this.recentTrigger?.addEventListener("click", () => this.setRecentMenuOpen(true));
    this.recentMenuWrap?.addEventListener("keydown", (event) => {
      if ((event as KeyboardEvent).key === "Escape") {
        event.preventDefault();
        this.setRecentMenuOpen(false);
        this.recentTrigger?.focus();
      }
    });
    this.optional<HTMLButtonElement>("#clear-recent")?.addEventListener("click", () => this.clearRecentPaths());
    this.optional<HTMLButtonElement>("#menu-open")?.addEventListener("click", () => { this.setMenuOpen(false); void this.openPicker(); });
    this.optional<HTMLButtonElement>("#menu-new")?.addEventListener("click", () => { this.setMenuOpen(false); void this.openPicker(); });
    this.optional<HTMLButtonElement>("#menu-zoom-in")?.addEventListener("click", () => { this.setMenuOpen(false); this.changeZoom(0.1); });
    this.optional<HTMLButtonElement>("#menu-zoom-out")?.addEventListener("click", () => { this.setMenuOpen(false); this.changeZoom(-0.1); });
    this.optional<HTMLButtonElement>("#menu-rotate-left")?.addEventListener("click", () => { this.setMenuOpen(false); this.rotateCurrentView(-90); });
    this.optional<HTMLButtonElement>("#menu-rotate-right")?.addEventListener("click", () => { this.setMenuOpen(false); this.rotateCurrentView(90); });
    this.optional<HTMLButtonElement>("#menu-print")?.addEventListener("click", () => { this.setMenuOpen(false); void this.printDocument(); });
    this.optional<HTMLButtonElement>("#menu-settings")?.addEventListener("click", () => { this.setMenuOpen(false); this.showDialog("#settings-dialog"); });
    this.optional<HTMLButtonElement>("#menu-about")?.addEventListener("click", () => { this.setMenuOpen(false); this.showDialog("#about-dialog"); });
    this.optional<HTMLButtonElement>("#menu-help")?.addEventListener("click", () => { this.setMenuOpen(false); this.showDialog("#help-dialog"); });
    this.renderTabs();
    this.renderRecentMenu();
    this.syncRenderModeSettings();
    this.appDocument().querySelectorAll<HTMLInputElement>('input[name="render-mode"]').forEach((radio) => {
      radio.checked = radio.value === this.renderMode;
      radio.addEventListener("change", () => {
        if (radio.checked) this.setRenderMode(radio.value);
      });
    });
    this.appDocument().querySelectorAll<HTMLElement>("[data-dialog-close]").forEach((button) => {
      button.addEventListener("click", () => this.closeDialog(button.closest("dialog")));
    });
    this.appDocument().querySelectorAll<HTMLDialogElement>(".app-dialog").forEach((dialog) => {
      dialog.addEventListener("click", (event) => {
        if (event.target === dialog) this.closeDialog(dialog);
      });
    });
    this.appDocument().addEventListener("pointerdown", (event) => {
      const target = event.target;
      if (this.menuPanel && this.menuButton && target instanceof Node
        && !this.menuPanel.contains(target) && !this.menuButton.contains(target)) this.setMenuOpen(false);
    });
    this.appDocument().addEventListener("keydown", (event) => this.handleKeyboardShortcuts(event as KeyboardEvent));
    this.previousButton.addEventListener("click", () => this.navigateToPage(this.pageIndex - 1));
    this.nextButton.addEventListener("click", () => this.navigateToPage(this.pageIndex + 1));
    this.viewer.addEventListener("scroll", () => this.scheduleViewportPageRender());
    this.pageNumber.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); this.jumpToEnteredPage(); }
    });
    this.pageNumber.addEventListener("change", () => this.jumpToEnteredPage());
    this.pageNumber.addEventListener("blur", () => this.resetPageInput());
    this.bookmarkButton.addEventListener("click", () => void this.toggleBookmark());
    this.bookmarksToggle.addEventListener("click", () => this.toggleBookmarksPanel());
    this.required<HTMLButtonElement>("#bookmarks-panel-close").addEventListener("click", () => this.setBookmarksPanel(false));
    this.required<HTMLButtonElement>("#search-panel-close").addEventListener("click", () => { this.searchPanel.hidden = true; });
    this.searchForm.addEventListener("submit", (event) => { event.preventDefault(); this.startSearch(true); });
    this.searchInput.addEventListener("input", () => this.startSearch(false));
    this.searchMatchCase.addEventListener("change", () => this.startSearch(true));
    this.searchWholeWord.addEventListener("change", () => this.startSearch(true));
  }

  private optional<T extends HTMLElement = HTMLElement>(selector: string): T | null {
    return this.root.querySelector<T>(selector);
  }

  private appDocument(): Document { return this.bootstrapImage.ownerDocument; }

  private renderTabs(): void {
    if (!this.tabStrip) return;
    this.tabStrip.querySelectorAll(".tab-item").forEach((item) => item.remove());
    if (this.tabsEmpty) this.tabsEmpty.hidden = this.tabs.length > 0;
    const doc = this.appDocument();
    for (const tab of this.tabs) {
      const item = doc.createElement("div");
      item.className = "tab-item";
      const active = tab.id === this.activeTabId;
      item.classList.toggle("active", active);
      const select = doc.createElement("button");
      select.type = "button";
      select.className = "document-tab";
      select.setAttribute("role", "tab");
      select.setAttribute("aria-selected", String(active));
      select.setAttribute("aria-controls", "viewer");
      select.title = tab.path;
      const title = doc.createElement("span");
      title.className = "document-tab-title";
      title.textContent = tab.name;
      select.append(title);
      select.addEventListener("click", () => void this.activateTab(tab.id));
      const close = doc.createElement("button");
      close.type = "button";
      close.className = "document-tab-close";
      close.textContent = "×";
      close.title = "Close " + tab.name;
      close.setAttribute("aria-label", "Close tab " + tab.name);
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        void this.closeTabById(tab.id);
      });
      item.append(select, close);
      this.tabStrip.insertBefore(item, this.newTabButton);
    }
  }

  private async closeTabById(tabId: string): Promise<void> {
    if (tabId === this.activeTabId) {
      await this.close();
      return;
    }
    const index = this.tabs.findIndex((tab) => tab.id === tabId);
    if (index < 0) return;
    this.tabs.splice(index, 1);
    this.renderTabs();
  }

  private saveActiveTabState(): void {
    if (!this.activeTabId) return;
    const tab = this.tabs.find((item) => item.id === this.activeTabId);
    if (!tab) return;
    tab.pageIndex = this.pageIndex;
    tab.zoom = this.zoom;
    tab.rotation = this.rotation;
    tab.scrollTop = this.viewer.scrollTop;
    tab.scrollLeft = this.viewer.scrollLeft;
  }

  private recordRecentPath(path: string): void {
    this.recentPaths = [path, ...this.recentPaths.filter((item) => normalizeLocalPath(item) !== normalizeLocalPath(path))]
      .slice(0, MAX_RECENT_FILES);
    try { this.appDocument().defaultView?.localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(this.recentPaths)); } catch { /* Recent files remain available for this session. */ }
    this.renderRecentMenu();
  }

  private clearRecentPaths(): void {
    this.recentPaths = [];
    try { this.appDocument().defaultView?.localStorage.removeItem(RECENT_STORAGE_KEY); } catch { /* Recent files remain cleared for this session. */ }
    this.renderRecentMenu();
    this.setRecentMenuOpen(true);
  }

  private renderRecentMenu(): void {
    if (!this.recentList) return;
    this.recentList.replaceChildren();
    if (this.recentPaths.length === 0) {
      const empty = this.appDocument().createElement("p");
      empty.className = "recent-empty";
      empty.textContent = "No recent PDFs";
      this.recentList.append(empty);
      return;
    }
    for (const path of this.recentPaths) {
      const button = this.appDocument().createElement("button");
      button.type = "button";
      button.className = "menu-item recent-item";
      button.setAttribute("role", "menuitem");
      button.title = path;
      button.textContent = path.split(/[\\/]/).at(-1) ?? path;
      button.addEventListener("click", () => {
        this.setMenuOpen(false);
        void this.open(path);
      });
      this.recentList.append(button);
    }
  }

  private setMenuOpen(open: boolean): void {
    if (!this.menuPanel) return;
    this.menuPanel.hidden = !open;
    this.menuButton?.setAttribute("aria-expanded", String(open));
    if (!open) this.setRecentMenuOpen(false);
  }

  private setRecentMenuOpen(open: boolean): void {
    if (!this.recentSubmenu) return;
    this.recentSubmenu.hidden = !open;
    this.recentTrigger?.setAttribute("aria-expanded", String(open));
  }

  private showDialog(selector: string): void {
    const dialog = this.optional<HTMLDialogElement>(selector);
    if (!dialog) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }

  private closeDialog(dialog: HTMLDialogElement | null): void {
    if (!dialog) return;
    if (typeof dialog.close === "function" && dialog.open) dialog.close();
    else dialog.removeAttribute("open");
  }

  private handleKeyboardShortcuts(event: KeyboardEvent): void {
    const target = event.target;
    const isEditing = target instanceof HTMLElement
      && (target.isContentEditable || target.matches("input, textarea, select"));
    if (event.key === "F1") {
      event.preventDefault();
      this.showDialog("#help-dialog");
      return;
    }
    if (!(event.ctrlKey || event.metaKey) && !event.altKey && !isEditing) {
      if (event.key === "ArrowLeft" && this.current) {
        event.preventDefault();
        this.navigateToPage(this.pageIndex - 1);
      } else if (event.key === "ArrowRight" && this.current) {
        event.preventDefault();
        this.navigateToPage(this.pageIndex + 1);
      }
      return;
    }
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "o") { event.preventDefault(); void this.openPicker(); }
    else if (key === "t") { event.preventDefault(); void this.openPicker(); }
    else if (key === "w") { event.preventDefault(); void this.close(); }
    else if (key === "p") { event.preventDefault(); void this.printDocument(); }
    else if (key === "+" || key === "=") { event.preventDefault(); this.changeZoom(0.1); }
    else if (key === "-") { event.preventDefault(); this.changeZoom(-0.1); }
    else if (key === "tab" && this.tabs.length > 1) {
      event.preventDefault();
      const index = this.tabs.findIndex((tab) => tab.id === this.activeTabId);
      const direction = event.shiftKey ? -1 : 1;
      const next = this.tabs[(index + direction + this.tabs.length) % this.tabs.length];
      if (next) void this.activateTab(next.id);
    }
  }

  private applyZoom(): void {
    this.pageStack.style.width = (this.zoom * 100) + "%";
    this.pageStack.style.maxWidth = Math.round(1200 * this.zoom) + "px";
    this.pageStack.dataset.zoom = String(this.zoom);
    if (this.zoomLevel) this.zoomLevel.textContent = Math.round(this.zoom * 100) + "%";
  }

  private changeZoom(delta: number): void {
    if (!this.current) return;
    const next = Math.max(0.25, Math.min(4, Math.round((this.zoom + delta) * 100) / 100));
    if (next === this.zoom) return;
    this.zoom = next;
    this.saveActiveTabState();
    this.applyZoom();
    this.clearPrefetchCache();
    this.prefetchCapacityBlocked = false;
    this.prefetchCursor = this.pageIndex + 1;
    const top = this.viewer.scrollTop;
    const left = this.viewer.scrollLeft;
    void this.showPage(this.pageIndex, false, true);
    this.appDocument().defaultView?.requestAnimationFrame(() => {
      this.viewer.scrollTop = top;
      this.viewer.scrollLeft = left;
    });
  }

  private rotateCurrentView(delta: -90 | 90): void {
    if (!this.current) return;
    const slot = this.pageSlots[this.pageIndex];
    const beforeTop = slot ? slot.getBoundingClientRect().top - this.viewer.getBoundingClientRect().top + this.viewer.scrollTop : 0;
    const beforeHeight = slot?.offsetHeight ?? 0;
    const pageScrollFraction = beforeHeight > 0
      ? Math.max(0, Math.min(1, (this.viewer.scrollTop - beforeTop) / beforeHeight))
      : 0;
    this.rotation = normalizeRotation(this.rotation + delta);
    this.saveActiveTabState();
    this.applyRotationToSlots();
    this.appDocument().defaultView?.requestAnimationFrame(() => {
      if (slot && this.pageSlots[this.pageIndex] === slot) {
        const top = slot.getBoundingClientRect().top - this.viewer.getBoundingClientRect().top + this.viewer.scrollTop;
        this.viewer.scrollTop = top + pageScrollFraction * slot.offsetHeight;
      }
      this.saveActiveTabState();
    });
  }

  private applyRotationToSlots(): void {
    for (const slot of this.pageSlots) {
      const width = Number(slot.dataset.pageWidth);
      const height = Number(slot.dataset.pageHeight);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) continue;
      slot.style.aspectRatio = this.rotation % 180 === 0 ? `${width} / ${height}` : `${height} / ${width}`;
    }
    for (const [pageIndex, cached] of this.pageImages) this.applyImageRotation(cached.image, pageIndex);
  }

  private applyImageRotation(image: HTMLImageElement, pageIndex: number): void {
    const slot = this.pageSlots[pageIndex];
    if (!slot) return;
    const width = Number(slot.dataset.pageWidth);
    const height = Number(slot.dataset.pageHeight);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
    if (this.rotation === 0) {
      image.style.position = "";
      image.style.left = "";
      image.style.top = "";
      image.style.width = "";
      image.style.height = "";
      image.style.maxWidth = "";
      image.style.maxHeight = "";
      image.style.transform = "";
      return;
    }
    image.style.position = "absolute";
    image.style.left = "50%";
    image.style.top = "50%";
    image.style.maxWidth = "none";
    image.style.maxHeight = "none";
    image.style.width = this.rotation % 180 === 0 ? "100%" : `${(100 * width) / height}%`;
    image.style.height = this.rotation % 180 === 0 ? "auto" : `${(100 * height) / width}%`;
    image.style.transform = `translate(-50%, -50%) rotate(${this.rotation}deg)`;
  }

  private async printDocument(): Promise<void> {
    const doc = this.current;
    if (!doc) return;
    const generationToken = this.generationToken;
    const pageIndex = this.pageIndex;
    this.status.textContent = "Opening print settings";
    try {
      const result = await this.bridge.invoke<{ cancelled: boolean; pages_printed: number }>("print_pdf", {
        documentId: doc.document_id,
        generation: doc.generation,
        currentPage: pageIndex,
      });
      if (generationToken !== this.generationToken || this.current?.document_id !== doc.document_id
        || this.current.generation !== doc.generation) return;
      this.status.textContent = result.cancelled
        ? "Ready"
        : `Submitted ${result.pages_printed} ${result.pages_printed === 1 ? "page" : "pages"} to printer`;
    } catch (error) {
      if (generationToken === this.generationToken && this.current?.document_id === doc.document_id
        && this.current.generation === doc.generation) this.showError(error);
    }
  }

  private syncRenderModeSettings(): void {
    this.appDocument().querySelectorAll<HTMLInputElement>('input[name="render-mode"]').forEach((radio) => {
      radio.checked = radio.value === this.renderMode;
    });
  }

  private setRenderMode(value: string): void {
    if (value !== "current" && value !== "nearby" && value !== "balanced" && value !== "maximum") return;
    this.renderMode = value;
    this.prefetchCapacityBlocked = false;
    try { this.appDocument().defaultView?.localStorage.setItem(RENDER_MODE_STORAGE_KEY, value); } catch { /* The selected mode remains active for this session. */ }
    this.syncRenderModeSettings();
    this.cancelPrefetch();
    if (value === "current") {
      this.clearPrefetchCache();
    } else {
      this.prefetchCursor = this.pageIndex + 1;
      this.trimPageImageCache(this.cachePageLimit());
      if (this.current) this.scheduleNextPagePrefetch(this.pageIndex, this.current, this.generationToken);
    }
  }

  async close(): Promise<void> {
    const closingId = this.activeTabId;
    if (!closingId) {
      await this.closeCurrentDocument();
      return;
    }
    this.saveActiveTabState();
    const closingIndex = this.tabs.findIndex((tab) => tab.id === closingId);
    const nextId = this.tabs[closingIndex + 1]?.id ?? this.tabs[closingIndex - 1]?.id;
    await this.closeCurrentDocument();
    const latestIndex = this.tabs.findIndex((tab) => tab.id === closingId);
    if (latestIndex >= 0) this.tabs.splice(latestIndex, 1);
    this.activeTabId = undefined;
    this.renderTabs();
    if (nextId && this.tabs.some((tab) => tab.id === nextId)) await this.activateTab(nextId);
  }

  private required<T extends HTMLElement>(selector: string): T {
    const element = this.root.querySelector<T>(selector);
    if (!element) throw new Error(`Missing UI element ${selector}`);
    return element;
  }

  private async openPicker(): Promise<void> {
    this.clearError();
    try {
      const selected = await this.bridge.pickPdf();
      if (typeof selected === "string") await this.open(selected);
      else if (Array.isArray(selected)) for (const path of selected) await this.open(path);
    } catch (error) { this.showError(error); }
  }

  async open(path: string): Promise<void> {
    const existing = this.tabs.find((tab) => normalizeLocalPath(tab.path) === normalizeLocalPath(path));
    if (existing) {
      await this.activateTab(existing.id);
      return;
    }
    if (this.tabs.length >= MAX_TABS) {
      this.showError("This window has reached the " + MAX_TABS + "-tab limit. Close a document before opening another.");
      return;
    }
    const tab: ReaderTab = {
      id: crypto.randomUUID().replaceAll("-", ""),
      path,
      name: path.split(/[\\/]/).at(-1) ?? path,
      pageIndex: 0,
      zoom: 1,
      rotation: 0,
      scrollTop: 0,
      scrollLeft: 0,
    };
    this.tabs.push(tab);
    this.renderTabs();
    await this.activateTab(tab.id);
  }

  private async activateTab(tabId: string): Promise<void> {
    const tab = this.tabs.find((item) => item.id === tabId);
    if (!tab) return;
    if (this.activeTabId === tabId && this.current) return;

    this.saveActiveTabState();
    const previousDocument = this.current;
    const token = ++this.generationToken;
    this.renderToken++;
    this.cancelCurrentRender();
    this.clearPrefetchState();
    this.clearImage();
    this.current = undefined;
    this.currentPath = undefined;
    this.activeTabId = tabId;
    this.invalidateSearch();
    this.bookmarks = [];
    this.renderBookmarks();
    this.setBookmarksPanel(false);
    this.pageIndex = tab.pageIndex;
    this.zoom = clampZoom(tab.zoom);
    this.rotation = normalizeRotation(tab.rotation);
    this.prefetchCursor = this.pageIndex + 1;
    this.pageSlots = [];
    this.pageNumber.value = "";
    this.pageTotal.textContent = "/ —";
    this.pageSize.textContent = "";
    this.pageStack.replaceChildren();
    this.pageStack.hidden = true;
    this.empty.hidden = true;
    this.name.textContent = tab.name;
    this.status.textContent = "Opening PDF";
    this.loading.hidden = false;
    this.clearError();
    this.applyZoom();
    this.updateControls();
    this.renderTabs();

    if (previousDocument) {
      try {
        await this.bridge.invoke("close_pdf", {
          documentId: previousDocument.document_id,
          generation: previousDocument.generation,
        });
      } catch (error) {
        if (token === this.generationToken) this.showError("Could not close the previous PDF: " + errorMessage(error));
      }
    }
    if (token !== this.generationToken) return;

    try {
      const result = await this.bridge.invoke<OpenPdfResult>("open_pdf", {
        documentId: tab.id,
        path: tab.path,
      });
      if (token !== this.generationToken) {
        await this.bridge.invoke("close_pdf", { documentId: result.document_id, generation: result.generation });
        return;
      }

      this.current = result;
      this.currentPath = tab.path;
      this.zoom = clampZoom(tab.zoom);
      this.pageIndex = Math.max(0, Math.min(tab.pageIndex, result.page_count - 1));
      tab.pageIndex = this.pageIndex;
      this.recordRecentPath(tab.path);
      try {
        this.bookmarks = (await this.bookmarkStore.load(tab.path))
          .filter((bookmark) => bookmark.pageNumber <= result.page_count);
      } catch (error) {
        this.bookmarks = [];
        this.showError("Could not load bookmarks: " + errorMessage(error));
      }
      if (token !== this.generationToken) {
        await this.bridge.invoke("close_pdf", { documentId: result.document_id, generation: result.generation });
        return;
      }

      this.renderBookmarks();
      this.name.textContent = tab.name;
      this.createPageSlots(result);
      this.applyRotationToSlots();
      this.applyZoom();
      this.viewer.scrollTop = tab.scrollTop;
      this.viewer.scrollLeft = tab.scrollLeft;
      this.pageNumber.value = String(this.pageIndex + 1);
      this.pageTotal.textContent = "/ " + result.page_count;
      this.pageSize.textContent = result.page_width_points.toFixed(0) + " × " + result.page_height_points.toFixed(0) + " pt";
      this.updateControls();
      this.renderTabs();
      await this.showPage(this.pageIndex, true);
    } catch (error) {
      if (token === this.generationToken) {
        this.loading.hidden = true;
        this.pageStack.hidden = true;
        this.pageStack.replaceChildren();
        this.pageSlots = [];
        this.current = undefined;
        this.currentPath = undefined;
        this.renderTabs();
        this.name.textContent = tab.name;
        this.empty.hidden = false;
        this.updateControls();
        this.showError(error);
      }
    }
  }

  private createPageSlots(doc: OpenPdfResult): void {
    this.pageSlots = Array.from({ length: doc.page_count }, (_, index) => {
      const slot = document.createElement("section");
      slot.className = "page-slot";
      slot.dataset.pageIndex = String(index);
      slot.setAttribute("aria-label", `Page ${index + 1}`);
      slot.dataset.pageWidth = String(doc.page_width_points);
      slot.dataset.pageHeight = String(doc.page_height_points);
      slot.style.aspectRatio = `${doc.page_width_points} / ${doc.page_height_points}`;
      return slot;
    });
    this.pageStack.replaceChildren(...this.pageSlots);
    this.pageStack.hidden = false;
  }

  private scheduleViewportPageRender(): void {
    if (!this.current) return;
    if (this.scrollTimer !== undefined) clearTimeout(this.scrollTimer);
    this.scrollTimer = setTimeout(() => {
      this.scrollTimer = undefined;
      const center = this.viewer.scrollTop + this.viewer.clientHeight / 2;
      let closest = this.pageIndex;
      let closestDistance = Number.POSITIVE_INFINITY;
      for (let index = 0; index < this.pageSlots.length; index++) {
        const slot = this.pageSlots[index];
        const top = slot.offsetTop;
        const bottom = top + slot.offsetHeight;
        const distance = center < top ? top - center : center > bottom ? center - bottom : 0;
        if (distance < closestDistance) {
          closest = index;
          closestDistance = distance;
        }
      }
      if (closest !== this.pageIndex) void this.showPage(closest);
    }, 100);
  }

  private navigateToPage(index: number): void {
    if (index < 0 || index >= this.pageSlots.length) return;
    const slot = this.pageSlots[index];
    if (typeof slot.scrollIntoView === "function") {
      slot.scrollIntoView({ behavior: "auto", block: "start" });
    } else {
      this.viewer.scrollTop = slot.offsetTop;
    }
    void this.showPage(index);
  }

  private jumpToEnteredPage(): void {
    if (!this.current) return;
    const pageNumber = Number(this.pageNumber.value);
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > this.current.page_count) {
      this.pageNumber.setAttribute("aria-invalid", "true");
      return;
    }
    this.pageNumber.setAttribute("aria-invalid", "false");
    if (pageNumber === this.pageIndex + 1) return;
    this.navigateToPage(pageNumber - 1);
  }

  private resetPageInput(): void {
    this.pageNumber.setAttribute("aria-invalid", "false");
    if (this.current) this.pageNumber.value = String(this.pageIndex + 1);
  }

  private async toggleBookmark(): Promise<void> {
    const doc = this.current;
    const path = this.currentPath;
    if (!doc || !path) return;
    const existing = this.bookmarks.some((bookmark) => bookmark.pageNumber === this.pageIndex + 1);
    const updated = existing
      ? this.bookmarks.filter((bookmark) => bookmark.pageNumber !== this.pageIndex + 1)
      : [...this.bookmarks, { pageNumber: this.pageIndex + 1, label: `Page ${this.pageIndex + 1}` }]
        .sort((left, right) => left.pageNumber - right.pageNumber);
    try {
      await this.bookmarkStore.save(path, updated);
      if (this.current?.document_id !== doc.document_id || this.current.generation !== doc.generation) return;
      this.bookmarks = updated;
      this.renderBookmarks();
      this.updateControls();
    } catch (error) {
      this.showError(`Could not save bookmark: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private renderBookmarks(): void {
    this.bookmarksList.replaceChildren();
    this.bookmarksEmpty.hidden = this.bookmarks.length > 0;
    for (const bookmark of this.bookmarks) {
      const item = this.image.ownerDocument.createElement("li");
      item.className = "bookmark-row";
      const open = this.image.ownerDocument.createElement("button");
      open.type = "button";
      open.className = "bookmark-open";
      open.textContent = `${bookmark.label} · page ${bookmark.pageNumber}`;
      open.addEventListener("click", () => {
        this.navigateToPage(bookmark.pageNumber - 1);
        this.setBookmarksPanel(false);
      });
      const remove = this.image.ownerDocument.createElement("button");
      remove.type = "button";
      remove.className = "bookmark-remove";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Remove bookmark for page ${bookmark.pageNumber}`);
      remove.addEventListener("click", () => void this.removeBookmark(bookmark.pageNumber));
      item.append(open, remove);
      this.bookmarksList.append(item);
    }
    this.updateControls();
  }

  private async removeBookmark(pageNumber: number): Promise<void> {
    const doc = this.current;
    const path = this.currentPath;
    if (!doc || !path) return;
    const updated = this.bookmarks.filter((bookmark) => bookmark.pageNumber !== pageNumber);
    try {
      await this.bookmarkStore.save(path, updated);
      if (this.current?.document_id !== doc.document_id || this.current.generation !== doc.generation) return;
      this.bookmarks = updated;
      this.renderBookmarks();
    } catch (error) {
      this.showError(`Could not remove bookmark: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private toggleBookmarksPanel(): void {
    this.setBookmarksPanel(this.bookmarksPanel.hidden);
  }

  private setBookmarksPanel(open: boolean): void {
    if (open && !this.current) return;
    const restoreFocus = !open && this.bookmarksPanel.contains(this.appDocument().activeElement);
    this.bookmarksPanel.hidden = !open;
    this.bookmarksToggle.setAttribute("aria-expanded", String(open));
    if (open) {
      this.searchPanel.hidden = true;
      this.renderBookmarks();
      this.appDocument().defaultView?.requestAnimationFrame(() => {
        if (!this.bookmarksPanel.hidden) this.bookmarksPanel.focus();
      });
    } else if (restoreFocus && !this.bookmarksToggle.disabled) {
      this.bookmarksToggle.focus();
    }
  }

  private startSearch(immediate: boolean): void {
    const doc = this.current;
    const query = this.searchInput.value.trim();
    const sequence = ++this.searchSequence;
    if (this.searchTimer !== undefined) clearTimeout(this.searchTimer);
    this.searchTimer = undefined;
    if (!doc || query.length === 0) {
      this.queuedSearch = undefined;
      this.searchPanel.hidden = !doc;
      this.searchResults.replaceChildren();
      this.searchSummary.textContent = doc ? "Enter text to search for." : "";
      return;
    }
    const request = {
      sequence,
      documentId: doc.document_id,
      generation: doc.generation,
      query,
      matchCase: this.searchMatchCase.checked,
      wholeWord: this.searchWholeWord.checked,
    };
    this.searchPanel.hidden = false;
    this.bookmarksPanel.hidden = true;
    this.bookmarksToggle.setAttribute("aria-expanded", "false");
    this.searchSummary.textContent = "Searching document…";
    this.searchResults.replaceChildren();
    if (immediate) this.queueSearch(request);
    else this.searchTimer = setTimeout(() => { this.searchTimer = undefined; this.queueSearch(request); }, 250);
  }

  private queueSearch(request: NonNullable<PdfReaderUi["queuedSearch"]>): void {
    if (this.searchRunning) {
      this.queuedSearch = request;
      return;
    }
    void this.executeSearch(request);
  }

  private async executeSearch(request: NonNullable<PdfReaderUi["queuedSearch"]>): Promise<void> {
    this.searchRunning = true;
    try {
      const response = await this.bridge.invoke<unknown>("search_text", {
        documentId: request.documentId,
        generation: request.generation,
        query: request.query,
        matchCase: request.matchCase,
        wholeWord: request.wholeWord,
      });
      const result = validateTextSearchResponse(response, this.current?.page_count ?? 0);
      if (request.sequence === this.searchSequence
        && this.current?.document_id === request.documentId
        && this.current.generation === request.generation) this.renderSearchResults(result);
    } catch (error) {
      if (request.sequence === this.searchSequence) {
        this.searchSummary.textContent = `Search failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    } finally {
      this.searchRunning = false;
      const queued = this.queuedSearch;
      this.queuedSearch = undefined;
      if (queued && queued.sequence === this.searchSequence) void this.executeSearch(queued);
    }
  }

  private renderSearchResults(result: TextSearchResponse): void {
    this.searchResults.replaceChildren();
    const count = result.matches.length;
    this.searchSummary.textContent = count === 0
      ? "No text matches found. Scanned-image pages are not searchable."
      : `${result.truncated ? `First ${count} matches shown; refine your search. ` : ""}${count} match${count === 1 ? "" : "es"}.`;
    for (const match of result.matches) {
      const item = this.image.ownerDocument.createElement("li");
      const button = this.image.ownerDocument.createElement("button");
      button.type = "button";
      const page = this.image.ownerDocument.createElement("span");
      page.className = "result-page";
      page.textContent = `Page ${match.page_index + 1}`;
      const excerpt = this.image.ownerDocument.createElement("span");
      excerpt.className = "result-excerpt";
      excerpt.textContent = match.text;
      button.append(page, excerpt);
      button.addEventListener("click", () => {
        this.navigateToPage(match.page_index);
        this.searchPanel.hidden = true;
      });
      item.append(button);
      this.searchResults.append(item);
    }
  }

  private invalidateSearch(): void {
    this.searchSequence++;
    if (this.searchTimer !== undefined) clearTimeout(this.searchTimer);
    this.searchTimer = undefined;
    this.queuedSearch = undefined;
    this.searchInput.value = "";
    this.searchSummary.textContent = "";
    this.searchResults.replaceChildren();
    this.searchPanel.hidden = true;
  }

  private async showPage(index: number, opening = false, forceRender = false): Promise<void> {
    const doc = this.current;
    if (!doc || index < 0 || index >= doc.page_count) return;
    if (this.pageIndex !== index) this.prefetchCapacityBlocked = false;
    const generationToken = this.generationToken;
    const renderToken = ++this.renderToken;
    this.cancelCurrentRender();
    if (this.prefetchTimer !== undefined) clearTimeout(this.prefetchTimer);
    this.prefetchTimer = undefined;
    if (this.prefetchTask && this.prefetchTask.pageIndex !== index) this.cancelPrefetch();
    this.clearError();
    if (opening) {
      this.loading.hidden = false;
      this.status.textContent = "Preparing pages";
    } else {
      this.loading.hidden = true;
    }
    this.pageIndex = index;
    this.prunePrefetchedPages(index);
    this.pageNumber.value = String(index + 1);
    this.pageNumber.setAttribute("aria-invalid", "false");
    this.pageTotal.textContent = "/ " + doc.page_count;
    this.updateControls();
    const isCurrentRequest = () => generationToken === this.generationToken
      && renderToken === this.renderToken
      && this.current?.document_id === doc.document_id
      && this.current.generation === doc.generation
      && this.pageIndex === index;

    try {
      let cached = forceRender ? undefined : this.pageImages.get(index);
      if (!cached) {
        let buffer: ArrayBuffer | undefined;
        const task = this.prefetchTask;
        if (task?.pageIndex === index && !task.cancelled) {
          task.promoted = true;
          buffer = await task.promise;
        } else {
          this.cancelPrefetch();
        }
        if (!isCurrentRequest()) return;
        if (!buffer) {
          const requestToken = crypto.randomUUID();
          this.activeRequestToken = requestToken;
          const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
          const cssWidth = Math.max(1, this.pageStack.clientWidth || this.viewer.clientWidth - 56 || 1000);
          const [width, height] = targetDimensions(cssWidth * dpr, doc.page_width_points, doc.page_height_points);
          try {
            buffer = await this.bridge.invoke<ArrayBuffer>("render_page", {
              requestToken, documentId: doc.document_id, generation: doc.generation,
              pageIndex: index, width, height, zoom: 1,
            });
          } finally {
            if (this.activeRequestToken === requestToken) this.activeRequestToken = undefined;
          }
          if (!isCurrentRequest()) return;
        }
        if (!buffer) throw new Error("The requested page could not be rendered.");
        const parsed = parseRenderResponse(buffer, {
          documentId: doc.document_id, generation: doc.generation, pageIndex: index,
          tabId: uuidBytes(doc.document_id),
        });
        if (!isCurrentRequest()) return;
        this.prefetchCursor = Math.max(this.prefetchCursor, index + 1);
        cached = this.cachePageImage(index, parsed, generationToken);
      }
      if (!isCurrentRequest()) return;
      this.activatePageImage(index, cached);
      this.applyImageRotation(cached.image, index);
      if (cached.loaded) {
        this.loading.hidden = true;
        this.status.textContent = "Ready";
        this.prunePrefetchedPages(index);
      }
      this.trimPageImageCache(this.cachePageLimit());
      this.scheduleNextPagePrefetch(index, doc, generationToken, !opening);
      this.updateControls();
    } catch (error) {
      if (generationToken === this.generationToken && renderToken === this.renderToken) {
        this.loading.hidden = true;
        this.showError(error);
      }
    }
  }

  private scheduleNextPagePrefetch(pageIndex: number, doc: OpenPdfResult, generationToken: number, continuation = false): void {
    this.cancelPrefetch();
    if (this.renderMode === "current" || this.prefetchCapacityBlocked) return;
    const lookAhead = this.lookAheadPageCount();
    const lastPage = Math.min(doc.page_count - 1, pageIndex + lookAhead);
    if (this.prefetchCursor <= pageIndex || this.prefetchCursor > lastPage) this.prefetchCursor = pageIndex + 1;
    const targetPage = this.nextUncachedPrefetchPage(this.prefetchCursor, lastPage);
    if (targetPage < 0) return;
    this.prefetchTimer = setTimeout(() => {
      this.prefetchTimer = undefined;
      if (generationToken !== this.generationToken || this.current?.document_id !== doc.document_id
        || this.current.generation !== doc.generation) return;
      const task: PrefetchTask = {
        pageIndex: targetPage, requestToken: crypto.randomUUID(), generationToken,
        cancelled: false, promoted: false, promise: Promise.resolve(undefined),
      };
      this.prefetchTask = task;
      task.promise = this.runPrefetch(task, doc);
    }, continuation ? PREFETCH_CONTINUATION_DELAY_MS : PREFETCH_INITIAL_DELAY_MS);
  }

  private lookAheadPageCount(): number {
    if (this.renderMode === "nearby") return PREFETCH_NEARBY_PAGES;
    if (this.renderMode === "maximum") return PREFETCH_MAXIMUM_PAGES;
    return PREFETCH_RECOMMENDED_PAGES;
  }

  private cachePageLimit(): number {
    if (this.renderMode === "current") return 1;
    return Math.min(PAGE_CACHE_MAX_PAGES, this.lookAheadPageCount() + PAGE_CACHE_BACKTRACK + 1);
  }

  private nextUncachedPrefetchPage(startPage: number, lastPage: number): number {
    let page = startPage;
    while (page <= lastPage && this.pageImages.has(page)) page++;
    this.prefetchCursor = page;
    return page <= lastPage ? page : -1;
  }

  private async runPrefetch(task: PrefetchTask, doc: OpenPdfResult): Promise<ArrayBuffer | undefined> {
    try {
      const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
      const cssWidth = Math.max(1, this.pageStack.clientWidth || this.viewer.clientWidth - 56 || 1000);
      const [width, height] = targetDimensions(cssWidth * dpr, doc.page_width_points, doc.page_height_points);
      const buffer = await this.bridge.invoke<ArrayBuffer>("render_page", {
        requestToken: task.requestToken, documentId: doc.document_id, generation: doc.generation,
        pageIndex: task.pageIndex, width, height, zoom: 1,
      });
      if (task.cancelled || task.generationToken !== this.generationToken
        || this.current?.document_id !== doc.document_id || this.current.generation !== doc.generation) return undefined;
      const parsed = parseRenderResponse(buffer, {
        documentId: doc.document_id, generation: doc.generation, pageIndex: task.pageIndex,
        tabId: uuidBytes(doc.document_id),
      });
      this.prefetchCursor = Math.max(this.prefetchCursor, task.pageIndex + 1);
      if (task.promoted) return buffer;
      this.cachePageImage(task.pageIndex, parsed, task.generationToken);
      if (!this.pageImages.has(task.pageIndex)) this.prefetchCapacityBlocked = true;
      return undefined;
    } catch {
      if (!task.cancelled) this.prefetchCursor = Math.max(this.prefetchCursor, task.pageIndex + 1);
      return undefined;
    } finally {
      if (this.prefetchTask === task) this.prefetchTask = undefined;
      if (!task.promoted && this.renderMode !== "current" && !this.prefetchCapacityBlocked && !task.cancelled
        && task.generationToken === this.generationToken
        && this.current?.document_id === doc.document_id
        && this.current.generation === doc.generation) {
        this.scheduleNextPagePrefetch(this.pageIndex, doc, task.generationToken, true);
      }
    }
  }

  private cachePageImage(pageIndex: number, parsed: ParsedPage, generationToken: number): CachedPageImage {
    this.releasePageImage(pageIndex);
    const slot = this.pageSlots[pageIndex];
    if (!slot) throw new Error("The page is no longer part of the active document.");

    const image = !this.bootstrapImage.isConnected && !this.bootstrapImage.hasAttribute("src")
      ? this.bootstrapImage
      : this.appDocument().createElement("img");
    image.className = "page-image";
    image.alt = `Page ${pageIndex + 1}`;
    image.dataset.pageIndex = String(pageIndex);
    image.hidden = false;

    slot.dataset.pageWidth = String(parsed.width);
    slot.dataset.pageHeight = String(parsed.height);
    slot.style.aspectRatio = this.rotation % 180 === 0
      ? `${parsed.width} / ${parsed.height}`
      : `${parsed.height} / ${parsed.width}`;

    const imageBuffer = parsed.png.slice().buffer as ArrayBuffer;
    const objectUrl = (this.bridge.createObjectURL ?? URL.createObjectURL.bind(URL))(
      new Blob([imageBuffer], { type: "image/png" }),
    );
    const entry: CachedPageImage = {
      image,
      objectUrl,
      encodedBytes: parsed.png.byteLength,
      decodedBytes: parsed.width * parsed.height * 4,
      loaded: false,
    };
    this.pageImages.set(pageIndex, entry);
    this.cachedEncodedBytes += entry.encodedBytes;
    this.cachedDecodedBytes += entry.decodedBytes;
    image.onload = () => {
      if (this.pageImages.get(pageIndex) !== entry) return;
      entry.loaded = true;
      this.applyImageRotation(image, pageIndex);
      if (generationToken === this.generationToken && this.renderedPageIndex === pageIndex
        && this.current && this.pageIndex === pageIndex) {
        this.loading.hidden = true;
        this.status.textContent = "Ready";
        this.prunePrefetchedPages(pageIndex);
        this.updateControls();
      }
    };
    image.onerror = () => {
      if (this.pageImages.get(pageIndex) !== entry) return;
      const wasActive = this.renderedPageIndex === pageIndex;
      this.releasePageImage(pageIndex);
      if (wasActive && generationToken === this.generationToken) {
        this.loading.hidden = true;
        this.showError("The rendered page could not be decoded by WebView2.");
      }
    };
    slot.append(image);
    image.src = objectUrl;
    this.trimPageImageCache(this.cachePageLimit());
    return entry;
  }

  private activatePageImage(pageIndex: number, entry: CachedPageImage): void {
    if (this.image !== entry.image) this.image.removeAttribute("id");
    this.image = entry.image;
    this.image.id = "page-image";
    this.image.hidden = false;
    this.renderedPageIndex = pageIndex;
  }

  private trimPageImageCache(maxPages: number): void {
    while (this.pageImages.size > maxPages
      || this.cachedEncodedBytes > PREFETCH_CACHE_MAX_BYTES
      || this.cachedDecodedBytes > DECODED_PAGE_CACHE_MAX_BYTES) {
      const candidates = [...this.pageImages.keys()].filter((page) =>
        page !== this.pageIndex && page !== this.renderedPageIndex);
      if (candidates.length === 0) break;
      const farthest = candidates.reduce((result, page) => {
        const distance = Math.abs(page - this.pageIndex);
        const farthestDistance = Math.abs(result - this.pageIndex);
        return distance > farthestDistance || (distance === farthestDistance && page > result) ? page : result;
      });
      this.releasePageImage(farthest);
    }
  }

  private prunePrefetchedPages(pageIndex: number): void {
    for (const cachedPage of this.pageImages.keys()) {
      if (cachedPage === this.renderedPageIndex || cachedPage >= pageIndex - PAGE_CACHE_BACKTRACK) continue;
      this.releasePageImage(cachedPage);
    }
    this.trimPageImageCache(this.cachePageLimit());
  }

  private clearPrefetchCache(): void {
    for (const cachedPage of this.pageImages.keys()) {
      if (cachedPage !== this.renderedPageIndex) this.releasePageImage(cachedPage);
    }
    this.trimPageImageCache(this.cachePageLimit());
  }

  private releasePageImage(pageIndex: number): void {
    const entry = this.pageImages.get(pageIndex);
    if (!entry) return;
    this.pageImages.delete(pageIndex);
    this.cachedEncodedBytes = Math.max(0, this.cachedEncodedBytes - entry.encodedBytes);
    this.cachedDecodedBytes = Math.max(0, this.cachedDecodedBytes - entry.decodedBytes);
    entry.image.onload = null;
    entry.image.onerror = null;
    entry.image.removeAttribute("src");
    entry.image.hidden = true;
    entry.image.style.position = "";
    entry.image.style.left = "";
    entry.image.style.top = "";
    entry.image.style.width = "";
    entry.image.style.height = "";
    entry.image.style.maxWidth = "";
    entry.image.style.maxHeight = "";
    entry.image.style.transform = "";
    entry.image.remove();
    (this.bridge.revokeObjectURL ?? URL.revokeObjectURL.bind(URL))(entry.objectUrl);
    if (this.image === entry.image) {
      this.image.removeAttribute("id");
      this.image = this.bootstrapImage;
      this.renderedPageIndex = undefined;
    }
  }

  private cancelPrefetch(): void {
    const task = this.prefetchTask;
    this.prefetchTask = undefined;
    if (this.prefetchTimer !== undefined) clearTimeout(this.prefetchTimer);
    this.prefetchTimer = undefined;
    if (!task) return;
    task.cancelled = true;
    void this.bridge.invoke("cancel_render", { requestToken: task.requestToken }).catch(() => undefined);
  }

  private clearPrefetchState(): void {
    this.cancelPrefetch();
    this.clearPrefetchCache();
    this.prefetchCursor = 0;
    this.prefetchCapacityBlocked = false;
  }

  private async closeCurrentDocument(): Promise<void> {
    const current = this.current;
    ++this.generationToken;
    ++this.renderToken;
    this.cancelCurrentRender();
    this.clearPrefetchState();
    this.current = undefined;
    this.currentPath = undefined;
    this.bookmarks = [];
    this.renderBookmarks();
    this.invalidateSearch();
    this.setBookmarksPanel(false);
    this.pageIndex = 0;
    if (this.scrollTimer !== undefined) clearTimeout(this.scrollTimer);
    this.scrollTimer = undefined;
    this.clearImage();
    this.loading.hidden = false;
    this.status.textContent = "Closing document";
    this.updateControls();
    if (!current) { this.loading.hidden = true; this.empty.hidden = false; return; }
    try {
      await this.bridge.invoke("close_pdf", { documentId: current.document_id, generation: current.generation });
      this.status.textContent = "Document closed";
    } catch (error) { this.showError(error); }
    finally {
      this.loading.hidden = true;
      this.pageStack.hidden = true;
      this.pageStack.replaceChildren();
      this.pageSlots = [];
      this.name.textContent = "No document open";
      this.empty.hidden = false;
      this.pageNumber.value = "";
      this.pageTotal.textContent = "/ —";
      this.pageSize.textContent = "";
    }
  }

  private clearImage(): void {
    for (const pageIndex of [...this.pageImages.keys()]) this.releasePageImage(pageIndex);
    this.cachedEncodedBytes = 0;
    this.cachedDecodedBytes = 0;
    this.renderedPageIndex = undefined;
    this.image = this.bootstrapImage;
    this.image.id = "page-image";
    this.image.onload = null;
    this.image.onerror = null;
    this.image.removeAttribute("src");
    this.image.hidden = true;
    this.image.dataset.pageIndex = "";
    this.image.style.position = "";
    this.image.style.left = "";
    this.image.style.top = "";
    this.image.style.width = "";
    this.image.style.height = "";
    this.image.style.maxWidth = "";
    this.image.style.maxHeight = "";
    this.image.style.transform = "";
  }

  private cancelCurrentRender(): void {
    const token = this.activeRequestToken;
    this.activeRequestToken = undefined;
    if (token) void this.bridge.invoke("cancel_render", { requestToken: token }).catch(() => undefined);
  }

  private clearError(): void { this.error.hidden = true; this.error.textContent = ""; }
  private showError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.status.textContent = "Unable to display PDF";
    this.error.textContent = message;
    this.error.hidden = false;
  }
  private updateControls(): void {
    const doc = this.current;
    this.closeButton.disabled = !doc;
    if (this.zoomInButton) this.zoomInButton.disabled = !doc || this.zoom >= 4;
    if (this.zoomOutButton) this.zoomOutButton.disabled = !doc || this.zoom <= 0.25;
    if (this.rotateLeftButton) this.rotateLeftButton.disabled = !doc;
    if (this.rotateRightButton) this.rotateRightButton.disabled = !doc;
    const menuRotateLeft = this.optional<HTMLButtonElement>("#menu-rotate-left");
    const menuRotateRight = this.optional<HTMLButtonElement>("#menu-rotate-right");
    if (menuRotateLeft) menuRotateLeft.disabled = !doc;
    if (menuRotateRight) menuRotateRight.disabled = !doc;
    if (this.printButton) this.printButton.disabled = !doc;
    this.previousButton.disabled = !doc || this.pageIndex <= 0;
    this.nextButton.disabled = !doc || this.pageIndex >= doc.page_count - 1;
    this.pageNumber.disabled = !doc;
    this.pageNumber.max = doc ? String(doc.page_count) : "";
    if (doc) this.pageNumber.value = String(this.pageIndex + 1);
    this.pageTotal.textContent = doc ? `/ ${doc.page_count}` : "/ —";
    this.bookmarkButton.disabled = !doc;
    this.bookmarksToggle.disabled = !doc;
    this.searchInput.disabled = !doc;
    this.searchButton.disabled = !doc;
    this.searchMatchCase.disabled = !doc;
    this.searchWholeWord.disabled = !doc;
    const currentIsBookmarked = this.bookmarks.some((bookmark) => bookmark.pageNumber === this.pageIndex + 1);
    this.bookmarkButton.textContent = currentIsBookmarked ? "★" : "☆";
    this.bookmarkButton.setAttribute("aria-label", currentIsBookmarked ? "Remove bookmark from current page" : "Bookmark current page");
    this.bookmarkButton.title = currentIsBookmarked ? "Remove bookmark" : "Bookmark current page";
    this.openButton.disabled = false;
  }
}

function normalizeLocalPath(path: string): string {
  return path.toLowerCase().replaceAll("/", String.fromCharCode(92));
}

function normalizeRotation(value: number): PageRotation {
  const normalized = ((Math.round(value / 90) * 90) % 360 + 360) % 360;
  return normalized as PageRotation;
}

function clampZoom(value: number): number {
  return Number.isFinite(value) ? Math.max(0.25, Math.min(4, value)) : 1;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readRenderMode(): RenderMode {
  try {
    const value = globalThis.localStorage?.getItem(RENDER_MODE_STORAGE_KEY);
    return value === "current" || value === "nearby" || value === "balanced" || value === "maximum" ? value : "balanced";
  } catch { return "balanced"; }
}

function readRecentPaths(): string[] {
  try {
    const value: unknown = JSON.parse(globalThis.localStorage?.getItem(RECENT_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((path): path is string => typeof path === "string" && path.length > 0).slice(0, MAX_RECENT_FILES);
  } catch { return []; }
}

function validateTextSearchResponse(value: unknown, pageCount: number): TextSearchResponse {
  if (!value || typeof value !== "object") throw new Error("Worker returned malformed search results.");
  const candidate = value as Partial<TextSearchResponse>;
  if (!Array.isArray(candidate.matches)
    || candidate.matches.length > MAX_SEARCH_RESULTS
    || typeof candidate.truncated !== "boolean") {
    throw new Error("Worker returned search results outside the allowed limits.");
  }
  const encoder = new TextEncoder();
  const matches: TextSearchMatch[] = candidate.matches.map((match) => {
    if (!match || typeof match !== "object"
      || !Number.isSafeInteger(match.page_index)
      || match.page_index < 0
      || match.page_index >= pageCount
      || typeof match.text !== "string"
      || match.text.length === 0
      || encoder.encode(match.text).byteLength > MAX_SEARCH_EXCERPT_BYTES) {
      throw new Error("Worker returned an invalid search result entry.");
    }
    return { page_index: match.page_index, text: match.text };
  });
  return { matches, truncated: candidate.truncated };
}

function uuidBytes(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/i.test(normalized)) throw new Error("Invalid document identity");
  return Uint8Array.from(normalized.match(/../g)!, (byte) => Number.parseInt(byte, 16));
}

function targetDimensions(cssWidth: number, pageWidth: number, pageHeight: number): [number, number] {
  const width = Number.isFinite(cssWidth) && cssWidth > 0 ? cssWidth : 1000;
  if (!Number.isFinite(pageWidth) || !Number.isFinite(pageHeight) || pageWidth <= 0 || pageHeight <= 0) {
    throw new Error("The PDF page has invalid dimensions.");
  }
  const ratio = pageHeight / pageWidth;
  const scale = Math.min(1, 8192 / width, 8192 / (width * ratio), Math.sqrt(8_388_608 / (width * width * ratio)));
  return [Math.max(1, Math.floor(width * scale)), Math.max(1, Math.floor(width * ratio * scale))];
}
