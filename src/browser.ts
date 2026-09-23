import { chromium, type BrowserContext } from 'playwright';
import { config } from './config.js';

/**
 * Mở Google Chrome (không phải Chromium đi kèm Playwright) với 1 profile lưu trên đĩa,
 * để tái sử dụng session đăng nhập Apollo giữa các lần chạy — tránh phải login lại mỗi lần
 * (login lại nhiều lần dễ khiến Apollo yêu cầu xác minh/khoá tài khoản do nghi ngờ bot).
 *
 * Yêu cầu: máy phải có Google Chrome thật (không phải Chromium) — cài bằng:
 *   npx playwright install chrome
 * hoặc cài google-chrome-stable qua apt.
 */
export async function openPersistentChrome(): Promise<BrowserContext> {
  const context = await chromium.launchPersistentContext(config.chromeUserDataDir, {
    channel: 'chrome',
    headless: config.headless,
    viewport: { width: 1440, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  return context;
}
