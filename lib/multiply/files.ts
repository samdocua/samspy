// SamSpy — «Размножение»: collect image files from a folder pick or a drop (client only)
//
//   <input webkitdirectory> gives a flat FileList with webkitRelativePath.
//   A drop gives DataTransfer items; folders are walked recursively via the
//   (non-standard but universal) webkitGetAsEntry / FileSystemDirectoryReader API.
//
// Version history:
//   v0.1.0 (2026-11-20) — initial: recursive folder drop, hidden files skipped,
//                         natural path order.

export interface PickedFile {
  file: File;
  path: string; // relative path inside the dropped / picked folder (or just the name)
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function walk(entry: any, prefix: string, out: PickedFile[]): Promise<void> {
  if (!entry || entry.name?.startsWith('.')) return; // .DS_Store, hidden folders
  if (entry.isFile) {
    try {
      const file: File = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, path: prefix + file.name });
    } catch {
      /* unreadable file — skip */
    }
    return;
  }
  if (entry.isDirectory) {
    const reader = entry.createReader();
    // readEntries returns results in batches (≈100) until an empty batch
    for (;;) {
      const batch: any[] = await new Promise((res, rej) => reader.readEntries(res, rej)).catch(() => []) as any[];
      if (!batch.length) break;
      for (const child of batch) await walk(child, `${prefix}${entry.name}/`, out);
    }
  }
}

/**
 * Files from a drop event. Must be called synchronously inside the drop handler:
 * the DataTransfer entries are read before the first await.
 */
export async function filesFromDrop(dt: DataTransfer): Promise<PickedFile[]> {
  const entries = Array.from(dt.items ?? [])
    .map((i) => (i as any).webkitGetAsEntry?.())
    .filter(Boolean);
  if (!entries.length) return Array.from(dt.files ?? []).map((file) => ({ file, path: file.name }));
  const out: PickedFile[] = [];
  for (const e of entries) await walk(e, '', out);
  return sortByPath(out);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Files from an <input type="file"> (plain or webkitdirectory). */
export function filesFromInput(list: FileList | File[] | null | undefined): PickedFile[] {
  return sortByPath(
    Array.from(list ?? [])
      .filter((f) => !f.name.startsWith('.'))
      .map((file) => ({
        file,
        path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
      }))
  );
}

/** Natural order: 2.jpg before 10.jpg, folders keep their grouping. */
export function sortByPath(list: PickedFile[]): PickedFile[] {
  return [...list].sort((a, b) =>
    a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' })
  );
}

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif)$/i;

export function isImage(f: File): boolean {
  return f.type.startsWith('image/') || IMAGE_EXT.test(f.name);
}
