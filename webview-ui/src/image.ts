/**
 * Turning clipboard bitmaps into image attachments.
 *
 * A screenshot pasted into the composer never touches disk: the bytes ride on
 * the `Attachment.dataUri` and the host converts them into an Anthropic
 * `image` content block on submit (see `SessionManager.collectImages`).
 *
 * Two constraints shape `normalize()`:
 *   - The Messages API accepts only png / jpeg / gif / webp.
 *   - It rejects images over 5 MB, and downsamples anything whose long edge
 *     exceeds ~1568px anyway — so a raw 4K screenshot is both too big and
 *     wasted bytes. We shrink before upload rather than let the request 400.
 */
import type { Attachment } from '../../src/shared/protocol.js';

/** Media types the Messages API accepts for image blocks. */
const SUPPORTED = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Long edge above which Anthropic downsamples server-side anyway. */
const MAX_EDGE = 1568;

/** The API caps images at 5 MB; leave headroom for the request envelope. */
const MAX_BYTES = 3.75 * 1024 * 1024;

/** Image files carried by a paste/drop, in clipboard order. */
export function imagesFromDataTransfer(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (file) out.push(file);
  }
  // Some sources populate `files` but not `items`.
  if (!out.length) {
    for (const file of Array.from(dt.files ?? [])) {
      if (file.type.startsWith('image/')) out.push(file);
    }
  }
  return out;
}

/**
 * Build a pinned, external image attachment from a clipboard/file bitmap.
 * Returns `undefined` when the bytes can't be decoded as an image.
 */
export async function toImageAttachment(
  file: File,
  existing: Attachment[],
): Promise<Attachment | undefined> {
  const encoded = await normalize(file);
  if (!encoded) return undefined;
  const { dataUri, width, height } = encoded;
  const ext = dataUri.slice('data:image/'.length, dataUri.indexOf(';')).replace('jpeg', 'jpg');
  // Clipboard files are all named "image.png"; give each paste its own chip.
  const preferred = file.name && file.name !== 'image.png' ? file.name : `Pasted image.${ext}`;
  return { kind: 'image', label: uniqueLabel(preferred, existing), external: true, dataUri, width, height };
}

/** Intrinsic size of an already-encoded image, for chips built host-side. */
export function imageSize(dataUri: string): Promise<{ width: number; height: number } | undefined> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve(undefined);
    img.src = dataUri;
  });
}

interface Encoded {
  dataUri: string;
  /** Size of the *source* image — what the user recognises, not the downscale. */
  width: number;
  height: number;
}

/** Decode, shrink if oversized, and re-encode into an API-acceptable data URI. */
async function normalize(file: File): Promise<Encoded | undefined> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return undefined; // not a decodable raster image (e.g. an SVG)
  }
  const { width, height } = bitmap;
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    // Already small enough and in a supported format: keep the exact bytes
    // rather than round-tripping them through a lossy canvas re-encode.
    if (scale === 1 && SUPPORTED.has(file.type) && file.size <= MAX_BYTES) {
      const dataUri = await readDataUri(file);
      return dataUri ? { dataUri, width, height } : undefined;
    }

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    const png = canvas.toDataURL('image/png');
    // A photographic screenshot can stay huge as PNG; JPEG always fits.
    const dataUri = decodedBytes(png) <= MAX_BYTES ? png : canvas.toDataURL('image/jpeg', 0.85);
    return { dataUri, width, height };
  } finally {
    bitmap.close();
  }
}

function readDataUri(file: File): Promise<string | undefined> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : undefined);
    reader.onerror = () => resolve(undefined);
    reader.readAsDataURL(file);
  });
}

/** Decoded byte length of a base64 data URI, without materialising the bytes. */
function decodedBytes(dataUri: string): number {
  const b64 = dataUri.slice(dataUri.indexOf(',') + 1);
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

/**
 * `addAttachment` dedupes chips by label, so successive pastes need distinct
 * names: "Pasted image.png", "Pasted image 2.png", …
 */
function uniqueLabel(preferred: string, existing: Attachment[]): string {
  const taken = new Set(existing.map((a) => a.label));
  if (!taken.has(preferred)) return preferred;
  const dot = preferred.lastIndexOf('.');
  const stem = dot > 0 ? preferred.slice(0, dot) : preferred;
  const ext = dot > 0 ? preferred.slice(dot) : '';
  for (let n = 2; ; n++) {
    const candidate = `${stem} ${n}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}
