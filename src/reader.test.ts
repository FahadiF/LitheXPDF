import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseRenderResponse, PdfReaderUi, type ReaderBridge } from "./reader";

const id = "00112233445566778899aabbccddeeff";
const tab = Uint8Array.from(id.match(/../g)!.map((x) => Number.parseInt(x, 16)));

function pageFrame(pageIndex = 0, generation = 7, image = [0x89, 0x50, 0x4e, 0x47], documentId = id): ArrayBuffer {
  const payloadLength = 42 + image.length;
  const buffer = new ArrayBuffer(20 + payloadLength);
  const bytes = new Uint8Array(buffer);
  bytes.set([0x50, 0x44, 0x46, 0x57]);
  const view = new DataView(buffer);
  view.setUint16(4, 1, false); view.setUint16(6, 0x8003, false); view.setBigUint64(8, 19n, false); view.setUint32(16, payloadLength, false);
  bytes.set(documentId === id ? tab : Uint8Array.from(documentId.match(/../g)!.map((x) => Number.parseInt(x, 16))), 20); view.setBigUint64(36, BigInt(generation), false); view.setUint32(44, pageIndex, false);
  view.setUint32(48, 640, false); view.setUint32(52, 480, false); view.setUint16(56, 1, false); view.setUint32(58, image.length, false);
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
    document.body.innerHTML = `<main><button id="open-button"></button><button id="close-button"></button><button id="previous-button"></button><button id="next-button"></button><span id="page-counter"></span><span id="document-name"></span><span id="status-text"></span><span id="page-size"></span><section id="viewer"><div id="empty-state"></div><div id="loading-state" hidden></div><img id="page-image" hidden><div id="error-state" hidden></div></section></main>`;
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
    await ui.open("C:\\sample.pdf");
    expect((document.querySelector("#page-image") as HTMLImageElement).src).toContain("blob:test-1");
    const next = document.querySelector<HTMLButtonElement>("#next-button")!;
    next.click();
    await Promise.resolve();
    await ui.close();
    expect(bridge.invoke).toHaveBeenCalledWith("cancel_render", expect.objectContaining({ requestToken: expect.any(String) }));
    expect(revoked).toContain("blob:test-1");
    releaseRender(pageFrame(1, 7, [0x89, 0x50, 0x4e, 0x47], id));
    await Promise.resolve(); await Promise.resolve();
    expect(urls).toBe(1);
    expect((document.querySelector("#page-image") as HTMLImageElement).hasAttribute("src")).toBe(false);
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
    const ui = new PdfReaderUi(document, bridge);
    await ui.open("C:\\bad.pdf");
    expect(document.querySelector("#error-state")?.textContent).toContain("corrupt PDF page");
    expect((document.querySelector("#page-image") as HTMLImageElement).hasAttribute("src")).toBe(false);
  });
});
