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
const PREFETCH_DELAY_MS = 1_000;
const PREFETCH_CACHE_MAX_PAGES = 2;
const PREFETCH_CACHE_MAX_BYTES = 16 * 1024 * 1024;

interface PrefetchTask {
  pageIndex: number;
  requestToken: string;
  generationToken: number;
  cancelled: boolean;
  promoted: boolean;
  promise: Promise<ArrayBuffer | undefined>;
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
  private readonly image: HTMLImageElement;
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
  private pageSlots: HTMLElement[] = [];
  private current?: OpenPdfResult;
  private currentPath?: string;
  private bookmarks: Bookmark[] = [];
  private pageIndex = 0;
  private objectUrl?: string;
  private generationToken = 0;
  private renderToken = 0;
  private activeRequestToken?: string;
  private scrollTimer?: ReturnType<typeof setTimeout>;
  private prefetchTimer?: ReturnType<typeof setTimeout>;
  private prefetchTask?: PrefetchTask;
  private readonly prefetchedPages = new Map<number, ArrayBuffer>();
  private prefetchedBytes = 0;
  private searchTimer?: ReturnType<typeof setTimeout>;
  private searchSequence = 0;
  private searchRunning = false;
  private queuedSearch?: { sequence: number; documentId: string; generation: number; query: string; matchCase: boolean; wholeWord: boolean };

  constructor(private readonly root: ParentNode, private readonly bridge: ReaderBridge) {
    this.image = this.required("#page-image");
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
    this.openButton.addEventListener("click", () => void this.openPicker());
    this.closeButton.addEventListener("click", () => void this.close());
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
    } catch (error) { this.showError(error); }
  }

  async open(path: string): Promise<void> {
    const token = ++this.generationToken;
    this.renderToken++;
    this.cancelCurrentRender();
    this.clearPrefetchState();
    this.clearImage();
    this.current = undefined;
    this.currentPath = undefined;
    this.bookmarks = [];
    this.renderBookmarks();
    this.setBookmarksPanel(false);
    this.invalidateSearch();
    this.pageIndex = 0;
    this.pageSlots = [];
    this.pageNumber.value = "";
    this.pageTotal.textContent = "/ —";
    this.pageSize.textContent = "";
    this.pageStack.replaceChildren();
    this.pageStack.hidden = true;
    this.updateControls();
    this.name.textContent = "Opening document…";
    this.status.textContent = "Opening PDF";
    this.loading.hidden = false;
    this.empty.hidden = true;
    this.clearError();
    const documentId = crypto.randomUUID().replaceAll("-", "");
    try {
      const result = await this.bridge.invoke<OpenPdfResult>("open_pdf", { documentId, path });
      if (token !== this.generationToken) { await this.bridge.invoke("close_pdf", { documentId, generation: result.generation }); return; }
      this.current = result;
      this.currentPath = path;
      try {
        this.bookmarks = (await this.bookmarkStore.load(path))
          .filter((bookmark) => bookmark.pageNumber <= result.page_count);
      } catch (error) {
        this.bookmarks = [];
        this.showError(`Could not load bookmarks: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (token !== this.generationToken) {
        await this.bridge.invoke("close_pdf", { documentId, generation: result.generation });
        return;
      }
      this.renderBookmarks();
      this.name.textContent = path.split(/[\\/]/).at(-1) ?? path;
      this.pageIndex = 0;
      this.createPageSlots(result);
      this.pageNumber.value = "1";
      this.pageTotal.textContent = `/ ${result.page_count}`;
      this.pageSize.textContent = `${result.page_width_points.toFixed(0)} × ${result.page_height_points.toFixed(0)} pt`;
      this.updateControls();
      await this.showPage(0, true);
    } catch (error) {
      if (token === this.generationToken) {
        this.loading.hidden = true;
        this.pageStack.hidden = true;
        this.pageStack.replaceChildren();
        this.pageSlots = [];
        this.current = undefined;
        this.currentPath = undefined;
        this.bookmarks = [];
        this.renderBookmarks();
        this.name.textContent = "No document open";
        this.empty.hidden = false;
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
    this.bookmarksPanel.hidden = !open;
    this.bookmarksToggle.setAttribute("aria-expanded", String(open));
    if (open) this.searchPanel.hidden = true;
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

  private async showPage(index: number, opening = false): Promise<void> {
    const doc = this.current;
    if (!doc || index < 0 || index >= doc.page_count) return;
    const generationToken = this.generationToken;
    const renderToken = ++this.renderToken;
    this.cancelCurrentRender();
    if (this.prefetchTimer !== undefined) clearTimeout(this.prefetchTimer);
    this.prefetchTimer = undefined;
    if (this.prefetchTask && this.prefetchTask.pageIndex !== index) this.cancelPrefetch();
    this.clearError();
    if (opening) {
      this.loading.hidden = false;
      this.status.textContent = "Rendering page";
    } else if (this.objectUrl) {
      this.loading.hidden = true;
    }
    this.pageIndex = index;
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
      let buffer = this.takePrefetchedPage(index);
      if (!buffer) {
        const task = this.prefetchTask;
        if (task?.pageIndex === index && !task.cancelled) {
          task.promoted = true;
          buffer = await task.promise;
        } else {
          this.cancelPrefetch();
        }
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
      if (generationToken !== this.generationToken || renderToken !== this.renderToken
        || this.current?.document_id !== doc.document_id || this.current.generation !== doc.generation
        || this.pageIndex !== index) return;

      const imageBuffer = parsed.png.slice().buffer as ArrayBuffer;
      const slot = this.pageSlots[index];
      slot.style.aspectRatio = parsed.width + " / " + parsed.height;
      this.clearImage();
      this.objectUrl = (this.bridge.createObjectURL ?? URL.createObjectURL.bind(URL))(
        new Blob([imageBuffer], { type: "image/png" }),
      );
      this.image.onload = () => {
        if (generationToken === this.generationToken && renderToken === this.renderToken) {
          this.image.hidden = false;
          this.loading.hidden = true;
          this.status.textContent = "Ready";
        }
      };
      this.image.onerror = () => {
        if (generationToken === this.generationToken && renderToken === this.renderToken) {
          this.clearImage();
          this.loading.hidden = true;
          this.showError("The rendered page could not be decoded by WebView2.");
        }
      };
      slot.append(this.image);
      this.image.hidden = true;
      this.image.src = this.objectUrl;
      this.scheduleNextPagePrefetch(index, doc, generationToken);
    } catch (error) {
      if (generationToken === this.generationToken && renderToken === this.renderToken) {
        this.loading.hidden = true;
        this.showError(error);
      }
    }
  }

  private scheduleNextPagePrefetch(pageIndex: number, doc: OpenPdfResult, generationToken: number): void {
    this.cancelPrefetch();
    if (pageIndex + 1 >= doc.page_count) return;
    this.prefetchTimer = setTimeout(() => {
      this.prefetchTimer = undefined;
      if (generationToken !== this.generationToken || this.current?.document_id !== doc.document_id
        || this.current.generation !== doc.generation || this.pageIndex !== pageIndex) return;
      const task: PrefetchTask = {
        pageIndex: pageIndex + 1, requestToken: crypto.randomUUID(), generationToken,
        cancelled: false, promoted: false, promise: Promise.resolve(undefined),
      };
      this.prefetchTask = task;
      task.promise = this.runPrefetch(task, doc);
    }, PREFETCH_DELAY_MS);
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
      parseRenderResponse(buffer, {
        documentId: doc.document_id, generation: doc.generation, pageIndex: task.pageIndex,
        tabId: uuidBytes(doc.document_id),
      });
      if (task.promoted) return buffer;
      if (buffer.byteLength <= PREFETCH_CACHE_MAX_BYTES) this.cachePrefetchedPage(task.pageIndex, buffer);
      return undefined;
    } catch {
      return undefined;
    } finally {
      if (this.prefetchTask === task) this.prefetchTask = undefined;
    }
  }

  private cachePrefetchedPage(pageIndex: number, buffer: ArrayBuffer): void {
    const previous = this.prefetchedPages.get(pageIndex);
    if (previous) this.prefetchedBytes -= previous.byteLength;
    this.prefetchedPages.delete(pageIndex);
    this.prefetchedPages.set(pageIndex, buffer);
    this.prefetchedBytes += buffer.byteLength;
    while (this.prefetchedPages.size > PREFETCH_CACHE_MAX_PAGES || this.prefetchedBytes > PREFETCH_CACHE_MAX_BYTES) {
      const oldest = this.prefetchedPages.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      const evicted = this.prefetchedPages.get(oldest);
      this.prefetchedPages.delete(oldest);
      if (evicted) this.prefetchedBytes -= evicted.byteLength;
    }
  }

  private takePrefetchedPage(pageIndex: number): ArrayBuffer | undefined {
    const buffer = this.prefetchedPages.get(pageIndex);
    if (!buffer) return undefined;
    this.prefetchedPages.delete(pageIndex);
    this.prefetchedBytes -= buffer.byteLength;
    return buffer;
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
    this.prefetchedPages.clear();
    this.prefetchedBytes = 0;
  }

  async close(): Promise<void> {
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
    this.image.onload = null;
    this.image.onerror = null;
    this.image.removeAttribute("src");
    this.image.hidden = true;
    if (this.objectUrl) { (this.bridge.revokeObjectURL ?? URL.revokeObjectURL.bind(URL))(this.objectUrl); this.objectUrl = undefined; }
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
