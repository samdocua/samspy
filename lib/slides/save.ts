// SamSpy — browser save helpers (download / «Save as» dialog / timestamp)
//
// Same behaviour as the helpers inside SlidesView; shared here for «Размножение».
//
// Version history:
//   v0.1.0 (2026-11-20) — triggerDownload, pickSaveTarget (showSaveFilePicker on
//                         Chrome/Edge, plain download elsewhere), stamp().

export function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export type SaveTarget = { write: (blob: Blob) => Promise<void> } | null;

/**
 * Opens a «Save as» dialog where supported so the user picks the folder.
 * Must run straight from the click, before any slow work.
 * Returns a writer, `null` if the user cancelled, or a plain-download fallback.
 */
export async function pickSaveTarget(filename: string, mime: string, ext: string): Promise<SaveTarget> {
  const w = window as unknown as {
    showSaveFilePicker?: (o: unknown) => Promise<{
      createWritable: () => Promise<{ write: (b: Blob) => Promise<void>; close: () => Promise<void> }>;
    }>;
  };
  if (typeof w.showSaveFilePicker !== 'function') {
    return { write: async (blob) => triggerDownload(blob, filename) };
  }
  try {
    const handle = await w.showSaveFilePicker({
      suggestedName: filename,
      types: [{ description: ext.toUpperCase(), accept: { [mime]: [`.${ext}`] } }],
    });
    return {
      write: async (blob) => {
        const out = await handle.createWritable();
        await out.write(blob);
        await out.close();
      },
    };
  } catch (e) {
    if ((e as Error).name === 'AbortError') return null;
    return { write: async (blob) => triggerDownload(blob, filename) };
  }
}

export function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
}
