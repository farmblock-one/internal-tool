import fs from 'node:fs';
import path from 'node:path';

// Chỉ chữ cái (không dấu), số, và dấu "_" — không dấu cách, không ký tự đặc biệt khác. Bắt buộc
// theo yêu cầu, thay vì tự "làm sạch" tên người dùng nhập — để tên hiện trên web UI và tên file
// thật trên đĩa LUÔN giống hệt nhau, tránh người dùng bất ngờ vì tên bị tự đổi khác đi.
const OUTPUT_FILE_NAME_PATTERN = /^[A-Za-z0-9_]+$/;

export function isValidOutputFileName(name: string): boolean {
  return OUTPUT_FILE_NAME_PATTERN.test(name);
}

/**
 * Chuyển 1 chuỗi bất kỳ (vd tên list Apollo thật, có thể có dấu/dấu cách/ký tự đặc biệt) thành
 * tên file hợp lệ (khớp `OUTPUT_FILE_NAME_PATTERN`) — dùng để tự đặt tên file output theo đúng
 * tên list Apollo, không bắt người dùng tự gõ tay nữa. "đ/Đ" phải thay riêng (không tự tách dấu
 * được qua Unicode NFD như các chữ có dấu khác, vì là 1 chữ cái riêng, không phải chữ + dấu ghép).
 */
export function sanitizeToFileName(raw: string): string {
  let s = raw
    .trim()
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .normalize('NFD')
    // Bỏ dấu (chữ có dấu khác: NFD tách thành chữ cái + dấu riêng) — dùng Unicode property escape
    // (yêu cầu cờ "u") thay vì tự liệt kê range mã Unicode, tránh chép nhầm thành ký tự thật.
    .replace(/\p{Diacritic}/gu, '');
  s = s.replace(/[^A-Za-z0-9]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return s;
}

/**
 * Ghép đường dẫn file .xlsx từ tên mong muốn (do team nhập trên web UI) — nếu đã có sẵn 1 file
 * trùng tên, tự thêm hậu tố thời gian thay vì âm thầm ghi đè file cũ. Báo lỗi ngay nếu tên không
 * đúng định dạng cho phép, thay vì tự sửa tên người dùng nhập.
 */
export function buildOutputXlsxPath(dir: string, desiredName: string | undefined): string {
  let base: string;
  if (desiredName && desiredName.trim()) {
    if (!isValidOutputFileName(desiredName)) {
      throw new Error(
        `Tên file output "${desiredName}" không hợp lệ — chỉ được dùng chữ cái, số và dấu "_", không dấu cách/ký tự đặc biệt.`,
      );
    }
    base = desiredName;
  } else {
    base = `output_${Date.now()}`;
  }
  const direct = path.join(dir, `${base}.xlsx`);
  if (!fs.existsSync(direct)) return direct;
  return path.join(dir, `${base}_${Date.now()}.xlsx`);
}
