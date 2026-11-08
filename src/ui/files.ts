// Thin wrapper over the File System Access API (Chrome/Edge) with download/<input> fallbacks.

interface PickerType {
  description: string;
  accept: Record<string, string[]>;
}

// Not (yet) in TypeScript's DOM lib.
type FsWindow = Window & {
  showSaveFilePicker?: (o: { suggestedName?: string; types?: PickerType[] }) => Promise<FileSystemFileHandle>;
  showOpenFilePicker?: (o: { types?: PickerType[]; multiple?: boolean }) => Promise<FileSystemFileHandle[]>;
};
const w = window as FsWindow;

export const hasFsAccess = typeof w.showSaveFilePicker === "function";

export function isAbort(err: unknown) {
  return err instanceof DOMException && err.name === "AbortError";
}

/**
 * Save a blob. Returns the handle written to (FS Access) or null (download fallback).
 * Pass `handle` to overwrite a known file without asking.
 */
export async function saveBlob(
  blob: Blob,
  suggestedName: string,
  type: PickerType,
  handle: FileSystemFileHandle | null = null,
): Promise<FileSystemFileHandle | null> {
  if (hasFsAccess) {
    const h = handle ?? (await w.showSaveFilePicker!({ suggestedName, types: [type] }));
    const writable = await h.createWritable();
    await blob.stream().pipeTo(writable); // streams: embedded splats are never fully in memory
    return h;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = suggestedName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return null;
}

/** Ask for a file to open. Resolves to null if cancelled. */
export async function openFile(
  type: PickerType,
  fallbackInput: HTMLInputElement,
): Promise<{ file: File; handle: FileSystemFileHandle | null } | null> {
  if (typeof w.showOpenFilePicker === "function") {
    try {
      const [handle] = await w.showOpenFilePicker({ types: [type] });
      return { file: await handle.getFile(), handle };
    } catch (err) {
      if (isAbort(err)) return null;
      throw err;
    }
  }
  return new Promise((resolve) => {
    fallbackInput.onchange = () => {
      const file = fallbackInput.files?.[0];
      fallbackInput.value = "";
      resolve(file ? { file, handle: null } : null);
    };
    fallbackInput.click();
  });
}
