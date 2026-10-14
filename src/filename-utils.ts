import fs from 'node:fs';
import path from 'node:path';

// Chỉ chữ cái (không dấu), số, và dấu "-" — không dấu cách, không ký tự đặc biệt khác. Bắt buộc
// theo yêu cầu, thay vì tự "làm sạch" tên người dùng nhập — để tên hiện trên web UI và tên file
// thật trên đĩa LUÔN giống hệt nhau, tránh người dùng bất ngờ vì tên bị tự đổi khác đi.
const OUTPUT_FILE_NAME_PATTERN = /^[A-Za-z0-9-]+$/;

export function isValidOutputFileName(name: string): boolean {
  return OUTPUT_FILE_NAME_PATTERN.test(name);
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
        `Tên file output "${desiredName}" không hợp lệ — chỉ được dùng chữ cái, số và dấu "-", không dấu cách/ký tự đặc biệt.`,
      );
    }
    base = desiredName;
  } else {
    base = `output-${Date.now()}`;
  }
  const direct = path.join(dir, `${base}.xlsx`);
  if (!fs.existsSync(direct)) return direct;
  return path.join(dir, `${base}-${Date.now()}.xlsx`);
}
