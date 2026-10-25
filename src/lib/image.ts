// Уменьшение фото на устройстве перед сохранением (canvas → JPEG). Ничего не уходит в сеть.

function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Не удалось открыть изображение. Попробуйте другой файл (JPEG, PNG или HEIC).'));
    };
    img.src = url;
  });
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Не удалось сохранить изображение'))), type, quality);
  });
}

async function render(img: HTMLImageElement, maxSide: number, quality: number): Promise<{ blob: Blob; width: number; height: number }> {
  const w0 = img.naturalWidth, h0 = img.naturalHeight;
  const scale = maxSide > 0 ? Math.min(1, maxSide / Math.max(w0, h0)) : 1;
  const w = Math.max(1, Math.round(w0 * scale)), h = Math.max(1, Math.round(h0 * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  const blob = await toBlob(canvas, 'image/jpeg', quality);
  canvas.width = 0;
  canvas.height = 0;
  return { blob, width: w, height: h };
}

export interface ProcessedPhoto { full: Blob; thumb: Blob; width: number; height: number; type: string }

/** maxSide = 0 — сохранить оригинал без пересжатия (миниатюра всё равно создаётся). */
export async function processPhoto(file: Blob, maxSide: number): Promise<ProcessedPhoto> {
  const img = await loadImage(file);
  const thumb = await render(img, 480, 0.8);
  if (maxSide === 0) {
    return { full: file, thumb: thumb.blob, width: img.naturalWidth, height: img.naturalHeight, type: file.type || 'image/jpeg' };
  }
  const full = await render(img, maxSide, 0.88);
  return { full: full.blob, thumb: thumb.blob, width: full.width, height: full.height, type: 'image/jpeg' };
}
