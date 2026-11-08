import type { InvokeArgs } from "@tauri-apps/api/core";

const HEADER = 20;
const IMAGE_MAX = 32 * 1024 * 1024;
const METADATA_MAX = 4 * 1024;
const MAX_DIMENSION = 8192;
const MAX_PIXELS = 8_388_608;
const VERSION = 1;
const PAGE_KIND = 0x8003;

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
}

export class PdfReaderUi {
  private readonly image: HTMLImageElement;
  private readonly pageStack: HTMLElement;
  private readonly viewer: HTMLElement;
  private readonly status: HTMLElement;
  private readonly loading: HTMLElement;
  private readonly error: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly pageCounter: HTMLElement;
  private readonly name: HTMLElement;
  private readonly pageSize: HTMLElement;
  private readonly openButton: HTMLButtonElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly previousButton: HTMLButtonElement;
  private readonly nextButton: HTMLButtonElement;
  private pageSlots: HTMLElement[] = [];
  private current?: OpenPdfResult;
  private pageIndex = 0;
  private objectUrl?: string;
  private generationToken = 0;
  private renderToken = 0;
  private activeRequestToken?: string;
  private scrollTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly root: ParentNode, private readonly bridge: ReaderBridge) {
    this.image = this.required("#page-image");
    this.pageStack = this.required("#page-stack");
    this.viewer = this.required("#viewer");
    this.status = this.required("#status-text");
    this.loading = this.required("#loading-state");
    this.error = this.required("#error-state");
    this.empty = this.required("#empty-state");
    this.pageCounter = this.required("#page-counter");
    this.name = this.required("#document-name");
    this.pageSize = this.required("#page-size");
    this.openButton = this.required("#open-button");
    this.closeButton = this.required("#close-button");
    this.previousButton = this.required("#previous-button");
    this.nextButton = this.required("#next-button");
    this.openButton.addEventListener("click", () => void this.openPicker());
    this.closeButton.addEventListener("click", () => void this.close());
    this.previousButton.addEventListener("click", () => this.navigateToPage(this.pageIndex - 1));
    this.nextButton.addEventListener("click", () => this.navigateToPage(this.pageIndex + 1));
    this.viewer.addEventListener("scroll", () => this.scheduleViewportPageRender());
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
    this.clearImage();
    this.current = undefined;
    this.pageIndex = 0;
    this.pageSlots = [];
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
      this.name.textContent = path.split(/[\\/]/).at(-1) ?? path;
      this.pageIndex = 0;
      this.createPageSlots(result);
      this.pageCounter.textContent = `1 / ${result.page_count}`;
      this.pageSize.textContent = `${result.page_width_points.toFixed(0)} × ${result.page_height_points.toFixed(0)} pt`;
      this.updateControls();
      await this.showPage(0);
    } catch (error) {
      if (token === this.generationToken) {
        this.loading.hidden = true;
        this.pageStack.hidden = true;
        this.pageStack.replaceChildren();
        this.pageSlots = [];
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

  private async showPage(index: number): Promise<void> {
    const doc = this.current;
    if (!doc || index < 0 || index >= doc.page_count) return;
    const generationToken = this.generationToken;
    const renderToken = ++this.renderToken;
    this.cancelCurrentRender();
    const requestToken = crypto.randomUUID();
    this.activeRequestToken = requestToken;
    this.clearImage();
    this.clearError();
    this.loading.hidden = false;
    this.status.textContent = "Rendering page";
    this.pageIndex = index;
    this.pageCounter.textContent = `${index + 1} / ${doc.page_count}`;
    this.updateControls();
    try {
      const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
      const cssWidth = Math.max(1, this.pageStack.clientWidth || this.viewer.clientWidth - 56 || 1000);
      const [width, height] = targetDimensions(cssWidth * dpr, doc.page_width_points, doc.page_height_points);
      const buffer = await this.bridge.invoke<ArrayBuffer>("render_page", { requestToken, documentId: doc.document_id, generation: doc.generation, pageIndex: index, width, height, zoom: 1 });
      const parsed = parseRenderResponse(buffer, { documentId: doc.document_id, generation: doc.generation, pageIndex: index, tabId: uuidBytes(doc.document_id) });
      if (this.activeRequestToken === requestToken) this.activeRequestToken = undefined;
      if (generationToken !== this.generationToken || renderToken !== this.renderToken || this.current?.document_id !== doc.document_id || this.current.generation !== doc.generation || this.pageIndex !== index) return;
      const imageBuffer = parsed.png.slice().buffer as ArrayBuffer;
      const slot = this.pageSlots[index];
      slot.style.aspectRatio = `${parsed.width} / ${parsed.height}`;
      this.objectUrl = (this.bridge.createObjectURL ?? URL.createObjectURL.bind(URL))(new Blob([imageBuffer], { type: "image/png" }));
      this.image.onload = () => {
        if (generationToken === this.generationToken && renderToken === this.renderToken) {
          this.image.hidden = false;
          this.loading.hidden = true;
          this.status.textContent = "Ready";
        }
      };
      this.image.onerror = () => { if (generationToken === this.generationToken && renderToken === this.renderToken) { this.clearImage(); this.loading.hidden = true; this.showError("The rendered page could not be decoded by WebView2."); } };
      slot.append(this.image);
      this.image.hidden = true;
      this.image.src = this.objectUrl;
    } catch (error) {
      if (this.activeRequestToken === requestToken) this.activeRequestToken = undefined;
      if (generationToken === this.generationToken && renderToken === this.renderToken) { this.loading.hidden = true; this.showError(error); }
    }
  }

  async close(): Promise<void> {
    const current = this.current;
    ++this.generationToken;
    ++this.renderToken;
    this.cancelCurrentRender();
    this.current = undefined;
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
      this.pageCounter.textContent = "— / —";
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
    this.openButton.disabled = false;
  }
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
