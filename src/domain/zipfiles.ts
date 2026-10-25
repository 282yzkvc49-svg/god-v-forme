// Сборка ZIP отчёта и резервной копии, шифрование копии паролем (WebCrypto), проверка целостности.
import JSZip from 'jszip';
import type { AppData, PhotoBlobRec, PhotoMeta } from '../state/types';
import { RECORD_STORES } from '../state/types';
import { buildReport, photoFileName, REPORT_SCHEMA_VERSION, type ReportOptions } from './report';
import { dataToStores } from '../state/model';
import { sha256Hex } from '../lib/util';
import { parts } from '../lib/dates';
import type { Op } from '../state/idb';

async function blobBytes(b: Blob): Promise<Uint8Array> {
  return new Uint8Array(await b.arrayBuffer());
}

// ------------------------------------------------------------------ месячный отчёт

export async function buildReportZip(
  data: AppData, o: ReportOptions, getPhoto: (id: string) => Promise<Blob | null>,
): Promise<{ bytes: Uint8Array; fileName: string; counts: Record<string, number>; json: any; md: string }> {
  const { json, md } = buildReport(data, o);
  const zip = new JSZip();
  const files: { name: string; bytes: number; sha256: string; items?: number }[] = [];
  const add = async (name: string, content: Uint8Array | string, items?: number) => {
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    zip.file(name, bytes);
    files.push({ name, bytes: bytes.length, sha256: await sha256Hex(bytes), ...(items != null ? { items } : {}) });
  };
  await add('monthly_report.json', JSON.stringify(json, null, 2));
  await add('monthly_summary.md', md);
  let photos = 0;
  for (const p of o.photos) {
    const b = await getPhoto(p.id);
    if (!b) continue;
    await add(photoFileName(p), await blobBytes(b));
    photos++;
  }
  const counts = {
    weights: json.weights.length,
    workouts: json.workouts.length,
    meals_planned: json.nutrition_adherence.planned,
    photos,
    observations: json.observations.length,
  };
  const manifest = {
    schema_version: REPORT_SCHEMA_VERSION,
    report_type: 'monthly_review',
    app_version: o.appVersion,
    generated_at: o.generatedAt,
    period: { from: o.from, to: o.to },
    photos_included: photos > 0,
    files,
    counts,
  };
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  const { y, m } = parts(o.from);
  const fileName = `report_${y}-${String(m).padStart(2, '0')}.zip`;
  return { bytes, fileName, counts, json, md };
}

// ------------------------------------------------------------------ резервная копия

export const BACKUP_FORMAT = 'god-v-forme-backup';
export const BACKUP_FORMAT_VERSION = 1;
const MAGIC = 'GVFENC01';

export interface BackupCounts { [k: string]: number }

export async function buildBackupZip(data: AppData, blobs: PhotoBlobRec[], appVersion: string, createdAt: string): Promise<{ bytes: Uint8Array; counts: BackupCounts }> {
  const zip = new JSZip();
  const stores = dataToStores(data);
  const counts: BackupCounts = {};
  for (const [k, v] of Object.entries(stores)) counts[k] = v.length;
  const files: { path: string; bytes: number; sha256: string }[] = [];
  const add = async (path: string, bytes: Uint8Array) => {
    zip.file(path, bytes);
    files.push({ path, bytes: bytes.length, sha256: await sha256Hex(bytes) });
  };
  const body = new TextEncoder().encode(JSON.stringify({ format: BACKUP_FORMAT, format_version: BACKUP_FORMAT_VERSION, app_version: appVersion, created_at: createdAt, stores }));
  await add('backup.json', body);
  const metaIds = new Set(Object.keys(data.photos));
  let photoFiles = 0;
  for (const b of blobs) {
    if (!metaIds.has(b.id)) continue;
    await add(`photos/${b.id}.full`, await blobBytes(b.full));
    await add(`photos/${b.id}.thumb`, await blobBytes(b.thumb));
    photoFiles++;
  }
  counts.photoBlobs = photoFiles;
  const manifest = { format: BACKUP_FORMAT, format_version: BACKUP_FORMAT_VERSION, app_version: appVersion, created_at: createdAt, counts, files };
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 3 } });
  return { bytes, counts };
}

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password) as BufferSource, 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptBytes(plain: Uint8Array, password: string, iterations = 210_000): Promise<Uint8Array> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, iterations);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, plain as BufferSource));
  const header = new TextEncoder().encode(JSON.stringify({ alg: 'AES-GCM-256', kdf: 'PBKDF2-SHA256', iterations, salt: b64(salt), iv: b64(iv) }));
  const out = new Uint8Array(8 + 4 + header.length + cipher.length);
  out.set(new TextEncoder().encode(MAGIC), 0);
  new DataView(out.buffer).setUint32(8, header.length);
  out.set(header, 12);
  out.set(cipher, 12 + header.length);
  return out;
}

export function isEncrypted(bytes: Uint8Array): boolean {
  return bytes.length > 12 && new TextDecoder().decode(bytes.slice(0, 8)) === MAGIC;
}

export async function decryptBytes(bytes: Uint8Array, password: string): Promise<Uint8Array> {
  const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8);
  const header = JSON.parse(new TextDecoder().decode(bytes.slice(12, 12 + len)));
  const key = await deriveKey(password, unb64(header.salt), header.iterations);
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(header.iv) as BufferSource }, key, bytes.slice(12 + len) as BufferSource);
    return new Uint8Array(plain);
  } catch {
    throw new Error('Неверный пароль или файл повреждён');
  }
}

export interface ParsedBackup {
  createdAt: string;
  appVersion: string;
  stores: Record<string, any[]>;
  photos: PhotoBlobRec[];
  counts: BackupCounts;
}

/** Чтение и проверка целостности: контрольные суммы каждого файла, количество записей. */
export async function readBackup(bytes: Uint8Array, password?: string): Promise<ParsedBackup> {
  let zipBytes = bytes;
  if (isEncrypted(bytes)) {
    if (!password) throw new Error('Копия зашифрована — введите пароль');
    zipBytes = await decryptBytes(bytes, password);
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(zipBytes);
  } catch {
    throw new Error('Это не файл резервной копии «Мой год в форме» (не ZIP)');
  }
  const mf = zip.file('manifest.json');
  if (!mf) throw new Error('В архиве нет manifest.json — это не резервная копия приложения');
  const manifest = JSON.parse(await mf.async('string'));
  if (manifest.format !== BACKUP_FORMAT) {
    if (manifest.report_type === 'monthly_review') throw new Error('Это ежемесячный отчёт для ChatGPT, а не резервная копия');
    throw new Error('Неизвестный формат файла');
  }
  if (manifest.format_version > BACKUP_FORMAT_VERSION) throw new Error('Копия сделана более новой версией приложения — сначала обновите приложение');
  const contents = new Map<string, Uint8Array>();
  for (const f of manifest.files as { path: string; sha256: string; bytes: number }[]) {
    const entry = zip.file(f.path);
    if (!entry) throw new Error(`Файл ${f.path} отсутствует — копия неполная`);
    const b = await entry.async('uint8array');
    if (b.length !== f.bytes || (await sha256Hex(b)) !== f.sha256) throw new Error(`Файл ${f.path} повреждён (контрольная сумма не совпала)`);
    contents.set(f.path, b);
  }
  const body = JSON.parse(new TextDecoder().decode(contents.get('backup.json')!));
  const stores = body.stores as Record<string, any[]>;
  for (const [k, n] of Object.entries(manifest.counts as BackupCounts)) {
    if (k === 'photoBlobs') continue;
    if ((stores[k]?.length ?? 0) !== n) throw new Error(`Количество записей «${k}» не совпадает с описанием копии`);
  }
  const photos: PhotoBlobRec[] = [];
  for (const meta of (stores.photos || []) as PhotoMeta[]) {
    const full = contents.get(`photos/${meta.id}.full`), thumb = contents.get(`photos/${meta.id}.thumb`);
    if (!full || !thumb) continue;
    photos.push({ id: meta.id, full: new Blob([full as BlobPart], { type: meta.type || 'image/jpeg' }), thumb: new Blob([thumb as BlobPart], { type: 'image/jpeg' }) });
  }
  return { createdAt: body.created_at, appVersion: body.app_version, stores, photos, counts: manifest.counts };
}

const STAMP_FIELDS = ['updatedAt', 'createdAt', 'importedAt', 'movedAt'];
function stampOf(r: any): string {
  for (const f of STAMP_FIELDS) if (typeof r?.[f] === 'string') return r[f];
  return '';
}

/** Операции восстановления. replace — всё заменить; merge — добавить недостающее, при совпадении оставить более свежую запись. */
export function restoreOps(p: ParsedBackup, mode: 'replace' | 'merge', current: AppData, keyOf: (store: string, rec: any) => string): Op[] {
  const ops: Op[] = [];
  if (mode === 'replace') {
    for (const [store, rows] of Object.entries(p.stores)) for (const r of rows) ops.push({ store, put: r });
    for (const b of p.photos) ops.push({ store: 'photoBlobs', put: b });
    return ops;
  }
  for (const store of RECORD_STORES) {
    const cur = current[store] as Record<string, any>;
    for (const r of p.stores[store] || []) {
      const k = keyOf(store, r);
      const existing = cur[k];
      if (!existing || stampOf(r) > stampOf(existing)) ops.push({ store, put: r });
    }
  }
  const curPhotos = new Set(Object.keys(current.photos));
  for (const b of p.photos) if (!curPhotos.has(b.id)) ops.push({ store: 'photoBlobs', put: b });
  return ops;
}
