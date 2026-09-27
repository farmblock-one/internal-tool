import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * Chạy 1 lệnh shell và trả về output, không bao giờ throw — nếu lệnh lỗi/thiếu quyền thì trả
 * về chính thông báo lỗi đó để vẫn có thông tin trong file chẩn đoán.
 */
function safeExec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 5000, shell: '/bin/bash' });
  } catch (err) {
    return `[lỗi khi chạy "${cmd}": ${err instanceof Error ? err.message : String(err)}]`;
  }
}

/**
 * Gọi ngay khi 1 lần export Apollo thất bại (context/page bị đóng đột ngột) — chụp lại toàn bộ
 * thông tin hệ thống tại thời điểm đó (RAM/swap, log OOM của kernel, tiến trình chrome còn sót,
 * và log nội bộ của chính Chrome) để chẩn đoán nguyên nhân crash mà không cần người dùng phải tự
 * gõ lệnh đúng lúc crash xảy ra (rất khó canh thời điểm thủ công).
 */
export function captureCrashDiagnostics(label: string): string {
  const dir = path.resolve('data/diagnostics');
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, `crash-${label}-${Date.now()}.log`);

  const chromeLogPath = path.join(config.chromeUserDataDir, 'chrome_debug.log');
  const chromeLogTail = fs.existsSync(chromeLogPath)
    ? safeExec(`tail -n 200 "${chromeLogPath}"`)
    : '[không tìm thấy chrome_debug.log tại ' + chromeLogPath + ']';

  const sections = [
    `=== THỜI ĐIỂM CHỤP: ${new Date().toISOString()} (nhãn: ${label}) ===`,
    `=== dmesg -T (lỗi kernel / OOM killer) ===\n${safeExec('dmesg -T 2>/dev/null | tail -n 100')}`,
    `=== free -h (RAM/swap còn trống) ===\n${safeExec('free -h')}`,
    `=== journalctl gần nhất liên quan oom/chrome (nếu có quyền) ===\n${safeExec(
      'journalctl -k --since "-5 min" 2>/dev/null | grep -iE "oom|killed process|out of memory" | tail -n 40',
    )}`,
    `=== tiến trình chrome còn sống (có thể là zombie từ lần chạy trước) ===\n${safeExec(
      'ps aux | grep -i chrome | grep -v grep',
    )}`,
    `=== tiến trình Xvfb / openbox / Xorg ===\n${safeExec(
      'ps aux | grep -Ei "xvfb|openbox|Xorg" | grep -v grep',
    )}`,
    `=== chrome_debug.log (200 dòng cuối, log nội bộ của Chrome) ===\n${chromeLogTail}`,
  ];

  fs.writeFileSync(outPath, sections.join('\n\n'));
  return outPath;
}
