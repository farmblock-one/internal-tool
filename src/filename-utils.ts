import fs from 'node:fs';
import path from 'node:path';

/** Làm sạch tên file do người dùng tự nhập (giữ chữ/số kể cả tiếng Việt, khoảng trắng, -, _). */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^\p{L}\p{N} _-]+/gu, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || 'output';
}

/**
 * Ghép đường dẫn file .xlsx từ tên mong muốn (do team nhập trên web UI) — nếu đã có sẵn 1 file
 * trùng tên, tự thêm hậu tố thời gian thay vì âm thầm ghi đè file cũ.
 */
export function buildOutputXlsxPath(dir: string, desiredName: string | undefined): string {
  const base = desiredName && desiredName.trim() ? sanitizeFileName(desiredName) : `output-${Date.now()}`;
  const direct = path.join(dir, `${base}.xlsx`);
  if (!fs.existsSync(direct)) return direct;
  return path.join(dir, `${base}-${Date.now()}.xlsx`);
}
