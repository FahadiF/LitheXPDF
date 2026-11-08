export interface Bookmark {
  pageNumber: number;
  label: string;
}

export interface BookmarkStore {
  load(path: string): Promise<Bookmark[]>;
  save(path: string, bookmarks: Bookmark[]): Promise<void>;
}

export class LocalBookmarkStore implements BookmarkStore {
  constructor(private readonly storage: Storage = globalThis.localStorage) {}

  async load(path: string): Promise<Bookmark[]> {
    const value = this.storage.getItem(await storageKey(path));
    if (!value) return [];
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isBookmark)
      .map(({ pageNumber, label }) => ({ pageNumber, label: label.slice(0, 80) }))
      .sort((left, right) => left.pageNumber - right.pageNumber);
  }

  async save(path: string, bookmarks: Bookmark[]): Promise<void> {
    const unique = new Map<number, Bookmark>();
    for (const bookmark of bookmarks) {
      if (isBookmark(bookmark)) {
        unique.set(bookmark.pageNumber, {
          pageNumber: bookmark.pageNumber,
          label: bookmark.label.trim().slice(0, 80) || `Page ${bookmark.pageNumber}`,
        });
      }
    }
    this.storage.setItem(
      await storageKey(path),
      JSON.stringify([...unique.values()].sort((left, right) => left.pageNumber - right.pageNumber)),
    );
  }
}

function isBookmark(value: unknown): value is Bookmark {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Bookmark>;
  return Number.isSafeInteger(candidate.pageNumber)
    && (candidate.pageNumber ?? 0) > 0
    && typeof candidate.label === "string";
}

async function storageKey(path: string): Promise<string> {
  const normalized = path.replaceAll("/", "\\").toLowerCase();
  const bytes = new TextEncoder().encode(normalized);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `lithexpdf.bookmarks.${hash}`;
}
