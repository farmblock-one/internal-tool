import { openPersistentChrome } from './browser.js';
import { config } from './config.js';
import { logger } from './logger.js';

/**
 * Chạy 1 LẦN DUY NHẤT (thủ công) để đăng nhập Microsoft Teams (teams.live.com) VÀ Gmail
 * (mail.google.com), lưu session vào profile Chrome RIÊNG cho Risky (RISKY_CHROME_USER_DATA_DIR)
 * — TÁCH BIỆT với profile Apollo, để hàng đợi xử lý Risky (Teams/Gmail -> meetscript.io) chạy
 * đồng thời được với hàng đợi Apollo/Debounce mà không tranh nhau khoá 1 profile Chrome.
 *
 * Mở 2 tab cùng lúc (Teams + Gmail) để đăng nhập cả 2 trong 1 lượt thao tác thủ công.
 *
 * Chạy: npm run risky:login
 */
async function main() {
  const context = await openPersistentChrome(config.riskyChromeUserDataDir);
  const teamsPage = await context.newPage();
  await teamsPage.goto('https://teams.live.com/v2/');
  const gmailPage = await context.newPage();
  await gmailPage.goto('https://mail.google.com/');

  logger.info('Đã mở 2 tab Chrome: Microsoft Teams và Gmail. Đăng nhập cả 2 (email/password + 2FA nếu có).');
  logger.info(`Session sẽ được lưu vào: ${config.riskyChromeUserDataDir}`);
  logger.info('Sau khi đăng nhập xong CẢ 2 và thấy giao diện chính, quay lại đây và nhấn Enter để đóng.');

  await new Promise<void>((resolve) => {
    process.stdin.once('data', () => resolve());
  });

  await context.close();
  logger.info('Đã lưu session Teams + Gmail. Từ giờ có thể chạy luồng xử lý Risky.');
  process.exit(0);
}

main().catch((err) => {
  logger.error('Lỗi khi đăng nhập Teams/Gmail cho Risky:', err);
  process.exit(1);
});
