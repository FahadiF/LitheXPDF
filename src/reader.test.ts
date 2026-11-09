import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseRenderResponse, PdfReaderUi, type ReaderBridge } from "./reader";
import { LocalBookmarkStore, type Bookmark, type BookmarkStore } from "./bookmarks";
import { installThemeToggle } from "./theme";

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
    const storageValues = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storageValues.get(key) ?? null,
        setItem: (key: string, value: string) => { storageValues.set(key, value); },
        removeItem: (key: string) => { storageValues.delete(key); },
        clear: () => storageValues.clear(),
        key: (index: number) => [...storageValues.keys()][index] ?? null,
        get length() { return storageValues.size; },
      } as Storage,
    });
    document.body.innerHTML = `<main>
      <button id="open-button"></button><button id="close-button"></button><button id="previous-button"></button><button id="next-button"></button>
      <input id="page-number" type="number"/><span id="page-total"></span><span id="document-name"></span><span id="status-text"></span><span id="page-size"></span>
      <button id="bookmark-current"></button><button id="bookmarks-toggle"></button><button id="bookmarks-panel-close"></button>
      <aside id="bookmarks-panel" hidden><p id="bookmarks-empty"></p><ul id="bookmark-list"></ul></aside>
      <form id="search-form"><input id="search-input"/><button id="search-button"></button></form>
      <input id="search-match-case" type="checkbox"/><input id="search-whole-word" type="checkbox"/>
      <aside id="search-panel" hidden><button id="search-panel-close"></button><p id="search-summary"></p><ol id="search-results"></ol></aside>
      <button id="theme-toggle"></button>
      <section id="viewer"><div id="loading-state" class="loading-state" hidden></div><div id="page-stack" class="page-stack" hidden><img id="page-image" hidden></div><div id="empty-state" class="empty-state"></div><div id="error-state" class="error-state" hidden></div></section></main>`;
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

  it("does not show the centered loader or clear the current image while navigating", async () => {
    let releaseRender!: (value: ArrayBuffer) => void;
    const bridge: ReaderBridge = {
      pickPdf: async () => null,
      invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
        if (command === "open_pdf") return { document_id: id, generation: 7, page_count: 2, page_width_points: 612, page_height_points: 792 } as never;
        if (command === "render_page" && args?.pageIndex === 1) return await new Promise<ArrayBuffer>((resolve) => { releaseRender = resolve; }) as never;
        if (command === "render_page") return pageFrame(0) as never;
        return undefined as never;
      }),
      createObjectURL: () => "blob:navigation",
      revokeObjectURL: vi.fn(),
    };
    const ui = new PdfReaderUi(document, bridge);
    await ui.open("C:\\navigation.pdf");
    const image = document.querySelector<HTMLImageElement>("#page-image")!;
    image.dispatchEvent(new Event("load"));
    const originalSrc = image.src;
    document.querySelector<HTMLButtonElement>("#next-button")!.click();
    await Promise.resolve();
    expect(document.querySelector<HTMLElement>("#loading-state")?.hidden).toBe(true);
    expect(image.src).toBe(originalSrc);
    releaseRender(pageFrame(1));
    await Promise.resolve();
    await Promise.resolve();
    expect(image.src).toBe("blob:navigation");
    await ui.close();
  });

  it("keeps the previous image through a distant page jump until the new image decodes", async () => {
    let releaseRender!: (value: ArrayBuffer) => void;
    let urls = 0;
    const revoked: string[] = [];
    const bridge: ReaderBridge = {
      pickPdf: async () => null,
      invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
        if (command === "open_pdf") return { document_id: id, generation: 7, page_count: 8, page_width_points: 612, page_height_points: 792 } as never;
        if (command === "render_page" && args?.pageIndex === 7) return await new Promise<ArrayBuffer>((resolve) => { releaseRender = resolve; }) as never;
        if (command === "render_page") return pageFrame(Number(args?.pageIndex ?? 0)) as never;
        return undefined as never;
      }),
      createObjectURL: (blob) => `blob:distant-${++urls}-${blob.size}`,
      revokeObjectURL: (url) => revoked.push(url),
    };
    const ui = new PdfReaderUi(document, bridge);
    await ui.open("C:\\distant-jump.pdf");
    const originalImage = document.querySelector<HTMLImageElement>("#page-image")!;
    originalImage.dispatchEvent(new Event("load"));
    const pageInput = document.querySelector<HTMLInputElement>("#page-number")!;
    pageInput.value = "8";
    pageInput.dispatchEvent(new Event("change"));
    await Promise.resolve();

    expect(originalImage.isConnected).toBe(true);
    expect(originalImage.hasAttribute("src")).toBe(true);
    expect(revoked).toHaveLength(0);

    releaseRender(pageFrame(7));
    await Promise.resolve();
    await Promise.resolve();
    const replacement = document.querySelector<HTMLImageElement>("#page-image")!;
    expect(replacement.dataset.pageIndex).toBe("7");
    expect(originalImage.isConnected).toBe(true);
    replacement.dispatchEvent(new Event("load"));
    expect(originalImage.isConnected).toBe(false);
    expect(revoked).toHaveLength(1);
    await ui.close();
  });

  it("warms nearby page images shortly after opening and reuses them during navigation", async () => {
    vi.useFakeTimers();
    const calls: number[] = [];
    let urls = 0;
    const bridge: ReaderBridge = {
      pickPdf: async () => null,
      invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
        if (command === "open_pdf") return { document_id: id, generation: 7, page_count: 3, page_width_points: 612, page_height_points: 792 } as never;
        if (command === "render_page") {
          const pageIndex = Number(args?.pageIndex ?? 0);
          calls.push(pageIndex);
          return pageFrame(pageIndex) as never;
        }
        return undefined as never;
      }),
      createObjectURL: () => "blob:prefetch-" + (++urls),
      revokeObjectURL: vi.fn(),
    };
    try {
      const ui = new PdfReaderUi(document, bridge);
      await ui.open("C:\\prefetch.pdf");
      await vi.advanceTimersByTimeAsync(249);
      expect(calls).toEqual([0]);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toEqual([0, 1]);
      expect(urls).toBe(2);
      expect(document.querySelector('.page-image[data-page-index="1"]')?.getAttribute("src")).toBe("blob:prefetch-2");
      await vi.advanceTimersByTimeAsync(16);
      expect(calls).toEqual([0, 1, 2]);
      expect(urls).toBe(3);
      document.querySelector<HTMLButtonElement>("#next-button")!.click();
      await Promise.resolve();
      await Promise.resolve();
      expect(calls).toEqual([0, 1, 2]);
      expect(urls).toBe(3);
      await ui.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops prefetching when the decoded-image budget cannot hold another page", async () => {
    vi.useFakeTimers();
    const calls: number[] = [];
    const revoked: string[] = [];
    let urls = 0;
    const bridge: ReaderBridge = {
      pickPdf: async () => null,
      invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
        if (command === "open_pdf") return { document_id: id, generation: 7, page_count: 20, page_width_points: 612, page_height_points: 792 } as never;
        if (command === "render_page") {
          const pageIndex = Number(args?.pageIndex ?? 0);
          calls.push(pageIndex);
          return pageFrame(pageIndex, 7, [0x89, 0x50, 0x4e, 0x47], id, 4096, 2048) as never;
        }
        return undefined as never;
      }),
      createObjectURL: () => `blob:large-${++urls}`,
      revokeObjectURL: (url) => revoked.push(url),
    };
    try {
      const ui = new PdfReaderUi(document, bridge);
      await ui.open("C:\\large-pages.pdf");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(calls).toEqual([0, 1, 2]);
      expect(document.querySelectorAll(".page-image")).toHaveLength(2);
      expect(revoked).toContain("blob:large-3");
      await ui.close();
      expect(revoked).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards an in-flight prefetched result after navigation changes", async () => {
    vi.useFakeTimers();
    let releasePrefetch!: (value: ArrayBuffer) => void;
    const calls: number[] = [];
    let urls = 0;
    const bridge: ReaderBridge = {
      pickPdf: async () => null,
      invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
        if (command === "open_pdf") return { document_id: id, generation: 7, page_count: 3, page_width_points: 612, page_height_points: 792 } as never;
        if (command === "render_page") {
          const pageIndex = Number(args?.pageIndex ?? 0);
          calls.push(pageIndex);
          if (pageIndex === 1) return await new Promise<ArrayBuffer>((resolve) => { releasePrefetch = resolve; }) as never;
          return pageFrame(pageIndex) as never;
        }
        return undefined as never;
      }),
      createObjectURL: () => "blob:stale-" + (++urls),
      revokeObjectURL: vi.fn(),
    };
    try {
      const ui = new PdfReaderUi(document, bridge);
      await ui.open("C:\\stale-prefetch.pdf");
      await vi.advanceTimersByTimeAsync(250);
      expect(calls).toEqual([0, 1]);

      const next = document.querySelector<HTMLButtonElement>("#next-button")!;
      next.click(); // Promote the in-flight render for page 2.
      next.click(); // Move away before that render completes.
      await Promise.resolve();
      await Promise.resolve();
      releasePrefetch(pageFrame(1));
      await Promise.resolve();
      await Promise.resolve();
      expect(calls).toEqual([0, 1, 2]);
      expect(document.querySelector<HTMLInputElement>("#page-number")?.value).toBe("3");
      expect(urls).toBe(2);
      await ui.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the delayed prefetch when the document closes", async () => {
    vi.useFakeTimers();
    const calls: number[] = [];
    const bridge: ReaderBridge = {
      pickPdf: async () => null,
      invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
        if (command === "open_pdf") return { document_id: id, generation: 7, page_count: 2, page_width_points: 612, page_height_points: 792 } as never;
        if (command === "render_page") {
          calls.push(Number(args?.pageIndex ?? 0));
          return pageFrame(Number(args?.pageIndex ?? 0)) as never;
        }
        return undefined as never;
      }),
      createObjectURL: () => "blob:close-prefetch",
      revokeObjectURL: vi.fn(),
    };
    try {
      const ui = new PdfReaderUi(document, bridge);
      await ui.open("C:\\close-prefetch.pdf");
      await ui.close();
      await vi.advanceTimersByTimeAsync(250);
      expect(calls).toEqual([0]);
    } finally {
      vi.useRealTimers();
    }
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
      expect(document.querySelector<HTMLInputElement>("#page-number")?.value).toBe("2");
      expect(document.querySelector("#page-total")?.textContent).toBe("/ 3");
    } finally {
      vi.useRealTimers();
    }
  });

  it("navigates past five pages with a bounded decoded-image window and releases all URLs on close", async () => {
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
    const next = document.querySelector<HTMLButtonElement>("#next-button")!;

    expect(document.querySelectorAll(".page-slot")).toHaveLength(7);
    expect(document.querySelector<HTMLImageElement>("#page-image")?.closest<HTMLElement>(".page-slot")?.dataset.pageIndex).toBe("0");
    for (let pageIndex = 1; pageIndex < 7; pageIndex++) {
      next.click();
      expect(document.querySelector<HTMLInputElement>("#page-number")?.value).toBe(String(pageIndex + 1));
      expect(document.querySelector("#page-total")?.textContent).toBe("/ 7");
      await Promise.resolve();
      const activeImage = document.querySelector<HTMLImageElement>("#page-image");
      expect(activeImage?.closest<HTMLElement>(".page-slot")?.dataset.pageIndex).toBe(String(pageIndex));
      expect(document.querySelectorAll(".page-image").length).toBeLessThanOrEqual(3);
    }
    expect(next.disabled).toBe(true);
    expect(revoked.length).toBeGreaterThan(0);
    await ui.close();
    expect(revoked).toHaveLength(7);
    expect(document.querySelectorAll(".page-image")).toHaveLength(0);
    expect(document.querySelectorAll(".page-slot")).toHaveLength(0);
  });

  it("keeps object URLs bounded while visiting fifty pages", async () => {
    vi.useFakeTimers();
    const revoked: string[] = [];
    let urls = 0;
    const bridge: ReaderBridge = {
      pickPdf: async () => null,
      invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
        if (command === "open_pdf") return { document_id: id, generation: 7, page_count: 50, page_width_points: 612, page_height_points: 792 } as never;
        if (command === "render_page") return pageFrame(Number(args?.pageIndex ?? 0)) as never;
        return undefined as never;
      }),
      createObjectURL: () => `blob:fifty-${++urls}`,
      revokeObjectURL: (url) => revoked.push(url),
    };
    try {
      const ui = new PdfReaderUi(document, bridge);
      await ui.open("C:\\fifty-pages.pdf");
      const next = document.querySelector<HTMLButtonElement>("#next-button")!;
      for (let pageIndex = 1; pageIndex < 50; pageIndex++) {
        next.click();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      }
      expect(document.querySelector<HTMLInputElement>("#page-number")?.value).toBe("50");
      expect(document.querySelectorAll(".page-image").length).toBeLessThanOrEqual(3);
      expect(urls).toBe(50);
      expect(revoked.length).toBeGreaterThanOrEqual(47);
      await ui.close();
      expect(revoked).toHaveLength(50);
      expect(document.querySelectorAll(".page-image")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
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
    expect(stylesheet).toMatch(/\.page-image\s*\{[^}]*width:\s*100%[^}]*height:\s*auto/s);
    await ui.close();
  });

  it("jumps to a typed page number and rejects values outside the document", async () => {
    const bridge: ReaderBridge = {
      pickPdf: async () => null,
      invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
        if (command === "open_pdf") return { document_id: id, generation: 7, page_count: 7, page_width_points: 612, page_height_points: 792 } as never;
        if (command === "render_page") return pageFrame(Number(args?.pageIndex ?? 0)) as never;
        return undefined as never;
      }),
      createObjectURL: () => "blob:jump",
      revokeObjectURL: vi.fn(),
    };
    const ui = new PdfReaderUi(document, bridge);
    await ui.open("C:\\jump.pdf");
    const input = document.querySelector<HTMLInputElement>("#page-number")!;
    input.value = "6";
    input.dispatchEvent(new Event("change"));
    await Promise.resolve();
    expect(bridge.invoke).toHaveBeenCalledWith("render_page", expect.objectContaining({ pageIndex: 5 }));
    expect(input.value).toBe("6");
    input.value = "8";
    input.dispatchEvent(new Event("change"));
    expect(input.getAttribute("aria-invalid")).toBe("true");
    await ui.close();
  });

  it("persists bookmarks for a document and jumps from its bookmark list", async () => {
    const saved = new Map<string, Bookmark[]>();
    const bookmarks: BookmarkStore = {
      load: async (path) => saved.get(path) ?? [],
      save: async (path, value) => { saved.set(path, value); },
    };
    const bridge: ReaderBridge = {
      pickPdf: async () => null,
      bookmarks,
      invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
        if (command === "open_pdf") return { document_id: id, generation: 7, page_count: 4, page_width_points: 612, page_height_points: 792 } as never;
        if (command === "render_page") return pageFrame(Number(args?.pageIndex ?? 0)) as never;
        return undefined as never;
      }),
      createObjectURL: () => "blob:bookmark",
      revokeObjectURL: vi.fn(),
    };
    const ui = new PdfReaderUi(document, bridge);
    await ui.open("C:\\bookmarked.pdf");
    document.querySelector<HTMLButtonElement>("#next-button")!.click();
    await Promise.resolve();
    document.querySelector<HTMLButtonElement>("#bookmark-current")!.click();
    await Promise.resolve();
    expect(saved.get("C:\\bookmarked.pdf")).toEqual([{ pageNumber: 2, label: "Page 2" }]);
    await ui.close();
    await ui.open("C:\\bookmarked.pdf");
    document.querySelector<HTMLButtonElement>("#bookmarks-toggle")!.click();
    const bookmarkButton = document.querySelector<HTMLButtonElement>(".bookmark-open")!;
    bookmarkButton.click();
    await Promise.resolve();
    expect(bridge.invoke).toHaveBeenCalledWith("render_page", expect.objectContaining({ pageIndex: 1 }));
    expect(document.querySelector<HTMLElement>("#bookmarks-panel")!.hidden).toBe(true);
    document.querySelector<HTMLButtonElement>("#bookmarks-toggle")!.click();
    document.querySelector<HTMLButtonElement>(".bookmark-remove")!.click();
    await Promise.resolve();
    expect(saved.get("C:\\bookmarked.pdf")).toEqual([]);
    expect(document.querySelectorAll(".bookmark-open")).toHaveLength(0);
    await ui.close();
  });

  it("searches through the worker bridge and jumps from a text result", async () => {
    const bridge: ReaderBridge = {
      pickPdf: async () => null,
      invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
        if (command === "open_pdf") return { document_id: id, generation: 7, page_count: 3, page_width_points: 612, page_height_points: 792 } as never;
        if (command === "render_page") return pageFrame(Number(args?.pageIndex ?? 0)) as never;
        if (command === "search_text") return { matches: [{ page_index: 2, text: "LitheXPDF search fixture" }], truncated: false } as never;
        return undefined as never;
      }),
      createObjectURL: () => "blob:search",
      revokeObjectURL: vi.fn(),
    };
    const ui = new PdfReaderUi(document, bridge);
    await ui.open("C:\\search.pdf");
    const input = document.querySelector<HTMLInputElement>("#search-input")!;
    input.value = "LitheXPDF";
    document.querySelector<HTMLInputElement>("#search-match-case")!.checked = true;
    document.querySelector<HTMLFormElement>("#search-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(bridge.invoke).toHaveBeenCalledWith("search_text", expect.objectContaining({ query: "LitheXPDF", matchCase: true }));
    expect(document.querySelector("#search-summary")?.textContent).toContain("1 match");
    document.querySelector<HTMLButtonElement>("#search-results button")!.click();
    await Promise.resolve();
    expect(bridge.invoke).toHaveBeenCalledWith("render_page", expect.objectContaining({ pageIndex: 2 }));
    await ui.close();
  });

  it("rejects a search result page outside the active document", async () => {
    const bridge: ReaderBridge = {
      pickPdf: async () => null,
      invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
        if (command === "open_pdf") return { document_id: id, generation: 7, page_count: 2, page_width_points: 612, page_height_points: 792 } as never;
        if (command === "render_page") return pageFrame(Number(args?.pageIndex ?? 0)) as never;
        if (command === "search_text") return { matches: [{ page_index: 2, text: "outside document" }], truncated: false } as never;
        return undefined as never;
      }),
      createObjectURL: () => "blob:search-invalid",
      revokeObjectURL: vi.fn(),
    };
    const ui = new PdfReaderUi(document, bridge);
    await ui.open("C:\\invalid-search.pdf");
    const input = document.querySelector<HTMLInputElement>("#search-input")!;
    input.value = "outside";
    document.querySelector<HTMLFormElement>("#search-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector("#search-summary")?.textContent).toContain("invalid search result entry");
    expect(document.querySelector("#search-results")?.textContent).toBe("");
    await ui.close();
  });

  it("ignores a search response after the document generation changes", async () => {
    let resolveSearch!: (value: { matches: { page_index: number; text: string }[]; truncated: boolean }) => void;
    let opens = 0;
    const bridge: ReaderBridge = {
      pickPdf: async () => null,
      invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
        if (command === "open_pdf") {
          opens++;
          return { document_id: opens === 1 ? id : "ffeeddccbbaa99887766554433221100", generation: opens + 6, page_count: 2, page_width_points: 612, page_height_points: 792 } as never;
        }
        if (command === "render_page") return pageFrame(Number(args?.pageIndex ?? 0), Number(args?.generation ?? 7), undefined, String(args?.documentId ?? id)) as never;
        if (command === "search_text") return await new Promise<{ matches: { page_index: number; text: string }[]; truncated: boolean }>((resolve) => { resolveSearch = resolve; }) as never;
        return undefined as never;
      }),
      createObjectURL: () => `blob:stale-${opens}`,
      revokeObjectURL: vi.fn(),
    };
    const ui = new PdfReaderUi(document, bridge);
    await ui.open("C:\\old.pdf");
    const input = document.querySelector<HTMLInputElement>("#search-input")!;
    input.value = "old query";
    document.querySelector<HTMLFormElement>("#search-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await ui.open("C:\\new.pdf");
    resolveSearch({ matches: [{ page_index: 1, text: "old result" }], truncated: false });
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector("#search-results")?.textContent).not.toContain("old result");
    await ui.close();
  });
});

describe("theme preference", () => {
  it("restores, toggles, and persists the selected theme", () => {
    document.body.innerHTML = `<button id="theme-toggle"></button>`;
    const values = new Map<string, string>([["lithexpdf.theme", "light"]]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    } as unknown as Storage;
    installThemeToggle(document.documentElement, storage);
    expect(document.documentElement.dataset.theme).toBe("light");
    document.querySelector<HTMLButtonElement>("#theme-toggle")!.click();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(values.get("lithexpdf.theme")).toBe("dark");
  });

  it("stores document bookmarks under a path-derived key without storing the path", async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    } as unknown as Storage;
    const store = new LocalBookmarkStore(storage);
    await store.save("C:\\Documents\\Research.pdf", [{ pageNumber: 9, label: "Page 9" }]);
    const [key, value] = [...values.entries()][0];
    expect(key).toMatch(/^lithexpdf\.bookmarks\.[a-f0-9]{64}$/);
    expect(key).not.toContain("Research");
    expect(JSON.parse(value)).toEqual([{ pageNumber: 9, label: "Page 9" }]);
    expect(await store.load("c:/documents/research.PDF")).toEqual([{ pageNumber: 9, label: "Page 9" }]);
  });
});
