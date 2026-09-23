import { openPersistentChrome } from './browser.js';
import { config } from './config.js';
import { logger } from './logger.js';

/**
 * Script chạy 1 LẦN DUY NHẤT (thủ công) để đăng nhập Apollo và lưu session vào
 * CHROME_USER_DATA_DIR. Sau đó `npm run flow` sẽ tái sử dụng session này, kể cả khi
 * chạy headless.
 *
 * Server không có màn hình (headless VM) nên để thấy được cửa sổ Chrome và bấm đăng nhập,
 * cần 1 trong 2 cách — xem hướng dẫn chi tiết trong README:
 *   1) Cài Xvfb + x11vnc/noVNC tạm thời, xem màn hình ảo qua trình duyệt.
 *   2) Chạy script NÀY trên máy cá nhân (đã có Chrome + Node), rồi copy thư mục
 *      CHROME_USER_DATA_DIR (.chrome-profile) lên server, đúng đường dẫn cấu hình trong .env.
 *
 * Chạy: npm run apollo:login
 */
async function main() {
  const context = await openPersistentChrome();
  const page = await context.newPage();
  await page.goto('https://app.apollo.io/');

  logger.info('Cửa sổ Chrome đã mở. Đăng nhập Apollo (email/password + 2FA nếu có).');
  logger.info(`Session sẽ được lưu vào: ${config.chromeUserDataDir}`);
  logger.info('Sau khi đăng nhập xong và thấy dashboard Apollo, quay lại đây và nhấn Enter để đóng.');

  await new Promise<void>((resolve) => {
    process.stdin.once('data', () => resolve());
  });

  await context.close();
  logger.info('Đã lưu session. Từ giờ có thể chạy `npm run flow -- <apollo_list_url>`.');
  process.exit(0);
}

main().catch((err) => {
  logger.error('Lỗi khi đăng nhập Apollo:', err);
  process.exit(1);
});
