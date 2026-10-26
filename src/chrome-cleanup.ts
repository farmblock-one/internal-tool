import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function safeExec(cmd: string): void {
  try {
    execSync(cmd, { stdio: 'ignore', shell: '/bin/bash' });
  } catch {
    // Không sao — nghĩa là không có gì để dọn (vd không có tiến trình nào đang chạy).
  }
}

/**
 * Khi Chrome "crash" (context/page đóng đột ngột), tiến trình Chrome thật trên hệ điều hành đôi
 * khi KHÔNG thoát hẳn — vẫn là zombie giữ khoá (SingletonLock/SingletonSocket) trên thư mục
 * profile dùng chung (chromeUserDataDir). Lần retry tiếp theo mở 1 Chrome MỚI trỏ vào CÙNG
 * profile trong khi tiến trình cũ vẫn còn sống bên dưới, khiến 2 Chrome tranh nhau 1 profile —
 * đây là nguyên nhân crash lặp lại rất ổn định (đã xác nhận: nhiều tiến trình chrome zombie tích
 * tụ qua các lần chạy trước, và các file .crdownload dở dang luôn dừng ở cùng 1 kích thước).
 * Gọi hàm này trước MỌI lần mở Chrome để đảm bảo luôn chỉ có đúng 1 tiến trình dùng profile này.
 */
export function cleanupChromeProfile(profileDir: string): void {
  const resolved = path.resolve(profileDir);
  safeExec(`pkill -9 -f -- '${profileProcessPattern(profileDir)}'`);
  for (const lockFile of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    fs.rmSync(path.join(resolved, lockFile), { force: true });
  }
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Mẫu tìm tiến trình Chrome dùng ĐÚNG profile này: tham số `--user-data-dir=<đường dẫn>` phải kết
 * thúc ngay sau đường dẫn (dấu cách hoặc hết dòng). Trước đây tìm theo kiểu "có chứa chuỗi", nên
 * dọn profile Apollo (`.chrome-profile`) giết nhầm luôn Chrome của hàng đợi Risky
 * (`.chrome-profile-risky`) đang chạy song song — đã gặp thực tế: Chrome Risky bị đóng giữa lúc
 * upload meetscript.io đúng lúc 1 job Apollo khác bắt đầu.
 */
export function profileProcessPattern(profileDir: string): string {
  const variants = [...new Set([path.resolve(profileDir), profileDir])].map(escapeRegex);
  return `--user-data-dir=(${variants.join('|')})( |$)`;
}
