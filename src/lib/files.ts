// Сохранение файлов на iPad/iPhone: системное меню «Поделиться» → «Сохранить в Файлы»;
// запасной вариант — обычная загрузка. Чтение выбранных файлов — локально.

export type SaveResult = 'shared' | 'downloaded' | 'cancelled';

export function canShareFiles(): boolean {
  try {
    const f = new File(['x'], 'x.txt', { type: 'text/plain' });
    return !!navigator.canShare && navigator.canShare({ files: [f] });
  } catch {
    return false;
  }
}

/** Вызывать прямо из обработчика нажатия: Safari разрешает «Поделиться» только по жесту пользователя. */
export async function saveFile(bytes: Uint8Array | Blob | string, fileName: string, type: string): Promise<SaveResult> {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes as BlobPart], { type });
  const file = new File([blob], fileName, { type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: fileName });
      return 'shared';
    } catch (e: any) {
      if (e?.name === 'AbortError') return 'cancelled';
      // NotAllowedError и др. — пробуем обычную загрузку
    }
  }
  downloadBlob(blob, fileName);
  return 'downloaded';
}

export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function shareText(text: string, title: string): Promise<'shared' | 'copied' | 'cancelled'> {
  if (navigator.share) {
    try {
      await navigator.share({ text, title });
      return 'shared';
    } catch (e: any) {
      if (e?.name === 'AbortError') return 'cancelled';
    }
  }
  await copyText(text);
  return 'copied';
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

export function readFileText(file: File): Promise<string> {
  return file.text();
}

export async function readFileBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

export function isStandalone(): boolean {
  return (navigator as any).standalone === true || matchMedia('(display-mode: standalone)').matches;
}
