import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseRenderResponse, PdfReaderUi, type ReaderBridge } from "./reader";

const stylesheet = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

const id = "00112233445566778899aabbccddeeff";
const tab = Uint8Array.from(id.match(/../g)!.map((x) => Number.parseInt(x, 16)));

function pageFrame(pageIndex = 0, generation = 7, image = [0x89, 0x50, 0x4e, 0x47], documentId = id, width = 640, height = 480): ArrayBuffer {
  const payloadLength = 42 + image.length;
  const buffer = new ArrayBuffer(20 + payloadLength);
  const bytes = new Uint8Array(buffer);
  bytes.set([0x50, 0x44, 0x46, 0x57]);
  const view = new DataView(buffer);
  view.setUint16(4, 1, false); view.setUint16(6, 0x8003, false); view.setBigUint64(8, 19n, false); view.setUint32(16, payloadLength, false);
  bytes.set(documentId === id ? tab : Uint8Array.from(documentId.match(/../g)!.map((x) => Number.parseInt(x, 16))), 20); view.setBigUint64(36, BigInt(generation), false); view.setUint32(44, pageIndex, false);
  view.setUint32(48, width, false); view.setUint32(52, height, false); view.setUint16(56, 1, false); view.setUint32(58, image.length, false);
  bytes.set(image, 62);
  return buffer;
}

describe("bounded render response parsing", () => {
  it("accepts a matching PNG envelope and validates its identity and dimensions", () => {
    const result = parseRenderResponse(pageFrame(), { documentId: id, generation: 7, pageIndex: 0, tabId: tab });
    expect(result.requestId).toBe(19n);
    expect(result.width).toBe(640);
    expect([...result.png]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
  it("keeps the hidden display override in the stylesheet", () => {
    expect(stylesheet).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important;/);
  });
  it("rejects stale page, wrong tab, bad length, and invalid bitmap bounds", () => {
    expect(() => parseRenderResponse(pageFrame(1), { documentId: id, generation: 7, pageIndex: 0 })).toThrow(/stale/);
    expect(() => parseRenderResponse(pageFrame(), { documentId: id, generation: 7, pageIndex: 0, tabId: new Uint8Array(16) })).toThrow(/different document/);
    const overflow = pageFrame(); new DataView(overflow).setUint32(16, 0xffffffff, false);
    expect(() => parseRenderResponse(overflow, { documentId: id, generation: 7, pageIndex: 0 })).toThrow(/size|length/);
    const huge = pageFrame(); new DataView(huge).setUint32(48, 8192, false); new DataView(huge).setUint32(52, 8192, false);
    expect(() => parseRenderResponse(huge, { documentId: id, generation: 7, pageIndex: 0 })).toThrow(/dimensions/);
  });
});

describe("reader image lifecycle", () => {
  beforeEach(() => {
    document.head.innerHTML = `<style>${stylesheet}</style>`;
    document.body.innerHTML = `<main><button id="open-button"></button><button id="close-button"></button><button id="previous-button"></button><button id="next-button"></button><span id="page-counter"></span><span id="document-name"></span><span id="status-text"></span><span id="page-size"></span><section id="viewer"><div id="loading-state" class="loading-state" hidden></div><div id="page-stack" class="page-stack" hidden><img id="page-image" hidden></div><div id="empty-state" class="empty-state"></div><div id="error-state" class="error-state" hidden></div></section></main>`;
  });

  it("starts with the loading indicator and page image hidden", () => {
    expect(document.querySelector<HTMLElement>("#loading-state")?.hidden).toBe(true);
    expect(document.querySelector<HTMLImageElement>("#page-image")?.hidden).toBe(true);
  });

  it("revokes the prior page URL and rejects an image response that arrives after close", async () => {
    let releaseRender!: (value: ArrayBuffer) => void;
    const revoked: string[] = [];
    let urls = 0;
    const bridge: ReaderBridge = {
      pickPdf: async () => null,
      invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
        if (command === "open_pdf") return { document_id: id, generation: 7, page_count: 2, page_width_points: 612, page_height_points: 792 } as never;
        if (command === "render_page" && args?.pageIndex === 1) return await new Promise<ArrayBuffer>((resolve) => { releaseRender = resolve; }) as never;
        if (command === "render_page") return pageFrame(0) as never;
        return undefined as never;
      }),
      createObjectURL: () => `blob:test-${++urls}`,
      revokeObjectURL: (url) => revoked.push(url),
    };
    const ui = new PdfReaderUi(document, bridge);
    const image = document.querySelector<HTMLImageElement>("#page-image")!;
    await ui.open("C:\\sample.pdf");
    expect(document.querySelectorAll(".page-slot")).toHaveLength(2);
    expect((document.querySelector("#page-image") as HTMLImageElement).src).toContain("blob:test-1");
    (document.querySelector("#page-image") as HTMLImageElement).dispatchEvent(new Event("load"));
    expect((document.querySelector("#loading-state") as HTMLElement).hidden).toBe(true);
    expect(document.querySelector("#status-text")?.textContent).toBe("Ready");
    const next = document.querySelector<HTMLButtonElement>("#next-button")!;
    next.click();
    await Promise.resolve();
    await ui.close();
    expect(bridge.invoke).toHaveBeenCalledWith("cancel_render", expect.objectContaining({ requestToken: expect.any(String) }));
    expect(revoked).toContain("blob:test-1");
    releaseRender(pageFrame(1, 7, [0x89, 0x50, 0x4e, 0x47], id));
    await Promise.resolve(); await Promise.resolve();
    expect(urls).toBe(1);
    expect(image.hasAttribute("src")).toBe(false);
    expect(document.querySelectorAll(".page-slot")).toHaveLength(0);
  });

  it("shows an error and leaves no stale image when render fails", async () => {
    const bridge: ReaderBridge = {
      pickPdf: async () => null,
      invoke: vi.fn(async (command: string) => {
        if (command === "open_pdf") return { document_id: id, generation: 7, page_count: 1, page_width_points: 612, page_height_points: 792 } as never;
        if (command === "render_page") throw new Error("corrupt PDF page");
        return undefined as never;
      }),
      createObjectURL: () => "blob:unused",
      revokeObjectURL: vi.fn(),
    };
    const image = document.querySelector<HTMLImageElement>("#page-image")!;
    const ui = new PdfReaderUi(document, bridge);
    await ui.open("C:\\bad.pdf");
    expect(document.querySelector("#error-state")?.textContent).toContain("corrupt PDF page");
    expect(image.hasAttribute("src")).toBe(false);
  });

  it("renders the page nearest the scroll viewport after scrolling settles", async () => {
    vi.useFakeTimers();
    const bridge: ReaderBridge = {
      pickPdf: async () => null,
      invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
        if (command === "open_pdf") return { document_id: id, generation: 7, page_count: 3, page_width_points: 612, page_height_points: 792 } as never;
        if (command === "render_page") return pageFrame(Number(args?.pageIndex ?? 0)) as never;
        return undefined as never;
      }),
      createObjectURL: () => "blob:scroll",
      revokeObjectURL: vi.fn(),
    };
    try {
      const ui = new PdfReaderUi(document, bridge);
      await ui.open("C:\\scroll.pdf");
      const viewer = document.querySelector<HTMLElement>("#viewer")!;
      const slots = [...document.querySelectorAll<HTMLElement>(".page-slot")];
      Object.defineProperty(viewer, "clientHeight", { configurable: true, value: 400 });
      slots.forEach((slot, index) => {
        Object.defineProperty(slot, "offsetTop", { configurable: true, value: index * 500 });
        Object.defineProperty(slot, "offsetHeight", { configurable: true, value: 400 });
      });
      viewer.scrollTop = 500;
      viewer.dispatchEvent(new Event("scroll"));
      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();
      expect(bridge.invoke).toHaveBeenCalledWith("render_page", expect.objectContaining({ pageIndex: 1 }));
      expect(document.querySelector("#page-counter")?.textContent).toBe("2 / 3");
    } finally {
      vi.useRealTimers();
    }
  });

  it("navigates past five pages while retaining one shared image and revoking replaced URLs", async () => {
    const revoked: string[] = [];
    let urls = 0;
    const bridge: ReaderBridge = {
      pickPdf: async () => null,
      invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
        if (command === "open_pdf") return { document_id: id, generation: 7, page_count: 7, page_width_points: 612, page_height_points: 792 } as never;
        if (command === "render_page") return pageFrame(Number(args?.pageIndex ?? 0)) as never;
        return undefined as never;
      }),
      createObjectURL: () => `blob:long-${++urls}`,
      revokeObjectURL: (url) => revoked.push(url),
    };
    const ui = new PdfReaderUi(document, bridge);
    await ui.open("C:\\long.pdf");
    const image = document.querySelector<HTMLImageElement>("#page-image")!;
    const next = document.querySelector<HTMLButtonElement>("#next-button")!;

    expect(document.querySelectorAll(".page-slot")).toHaveLength(7);
    expect(image.closest<HTMLElement>(".page-slot")?.dataset.pageIndex).toBe("0");
    for (let pageIndex = 1; pageIndex < 7; pageIndex++) {
      next.click();
      expect(document.querySelector("#page-counter")?.textContent).toBe(`${pageIndex + 1} / 7`);
      await Promise.resolve();
      expect(document.querySelectorAll("img")).toHaveLength(1);
      expect(image.closest<HTMLElement>(".page-slot")?.dataset.pageIndex).toBe(String(pageIndex));
    }
    expect(next.disabled).toBe(true);
    expect(revoked).toHaveLength(6);
    await ui.close();
    expect(revoked).toHaveLength(7);
    expect(image.hasAttribute("src")).toBe(false);
    expect(document.querySelectorAll(".page-slot")).toHaveLength(0);
  });

  it("fits mixed page dimensions without stretching the shared image", async () => {
    const bridge: ReaderBridge = {
      pickPdf: async () => null,
      invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
        if (command === "open_pdf") return { document_id: id, generation: 7, page_count: 2, page_width_points: 612, page_height_points: 792 } as never;
        if (command === "render_page") return pageFrame(Number(args?.pageIndex ?? 0), 7, [0x89, 0x50, 0x4e, 0x47], id, 300, 600) as never;
        return undefined as never;
      }),
      createObjectURL: () => "blob:portrait",
      revokeObjectURL: vi.fn(),
    };
    const ui = new PdfReaderUi(document, bridge);
    await ui.open("C:\\mixed-size.pdf");
    const image = document.querySelector<HTMLImageElement>("#page-image")!;
    const slot = image.closest<HTMLElement>(".page-slot");
    expect(slot?.style.aspectRatio).toBe("300 / 600");
    expect(stylesheet).toMatch(/#page-image\s*\{[^}]*width:\s*100%[^}]*height:\s*auto/s);
    await ui.close();
  });
});
