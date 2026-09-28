import { openPersistentChrome } from './browser.js';
import { config } from './config.js';
import { logger } from './logger.js';

/**
 * Chạy 1 LẦN DUY NHẤT (thủ công) để đăng nhập Microsoft Teams (teams.live.com) và lưu session
 * vào CHUNG profile Chrome với Apollo (CHROME_USER_DATA_DIR) — 1 profile lưu cookie riêng theo
 * từng domain nên dùng chung không ảnh hưởng gì tới session Apollo đã đăng nhập trước đó.
 *
 * Chạy: npm run teams:login
 */
async function main() {
  const context = await openPersistentChrome();
  const page = await context.newPage();
  await page.goto('https://teams.live.com/v2/');

  logger.info('Cửa sổ Chrome đã mở. Đăng nhập Microsoft Teams (email/password + 2FA nếu có).');
  logger.info(`Session sẽ được lưu vào: ${config.chromeUserDataDir}`);
  logger.info('Sau khi đăng nhập xong và thấy giao diện Teams, quay lại đây và nhấn Enter để đóng.');

  await new Promise<void>((resolve) => {
    process.stdin.once('data', () => resolve());
  });

  await context.close();
  logger.info('Đã lưu session Teams. Từ giờ có thể chạy luồng xử lý Risky.');
  process.exit(0);
}

main().catch((err) => {
  logger.error('Lỗi khi đăng nhập Teams:', err);
  process.exit(1);
});
