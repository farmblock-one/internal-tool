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
    args: [
      '--disable-blink-features=AutomationControlled',
      // Chrome dùng /dev/shm cho renderer process — trên nhiều VM vùng này rất nhỏ (mặc định
      // 64MB), dễ khiến Chrome crash khi render bảng dữ liệu lớn (vd danh sách ~2.000 contact
      // của Apollo). Cờ này bảo Chrome dùng /tmp thay vì /dev/shm — cách khắc phục tiêu chuẩn
      // khi chạy Chrome tự động trong VM/container.
      '--disable-dev-shm-usage',
      // Chrome tự "throttle"/tạm ngưng tab khi không thấy tương tác trong thời gian dài —
      // hành vi này đôi khi gây crash lạ khi tự động hoá phải đứng chờ lâu (vd chờ Apollo xử
      // lý export). Các cờ này là chuẩn khuyến nghị khi chạy Chrome tự động để tắt hẳn kiểu
      // "tối ưu cho tab nền" đó.
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--disable-features=CalculateNativeWinOcclusion',
    ],
  });
  return context;
}
