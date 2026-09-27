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
  safeExec(`pkill -9 -f "${resolved}"`);
  for (const lockFile of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    fs.rmSync(path.join(resolved, lockFile), { force: true });
  }
}
