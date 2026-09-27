import path from 'node:path';
import { chromium, type BrowserContext } from 'playwright';
import { config } from './config.js';
import { logger } from './logger.js';

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
    // Log Chrome nội bộ cho thấy crash xảy ra ĐÚNG lúc bắt đầu tải file xuống — khả năng cao vì
    // không chỉ rõ nơi lưu, Chrome cố hiện hộp thoại "Save As" gốc của hệ điều hành, nhưng Xvfb
    // không có window manager nên hộp thoại đó không hiện được đúng cách. Khai báo rõ
    // acceptDownloads + downloadsPath để Playwright tự quản lý tải file qua CDP, không để Chrome
    // tự hiện UI tải file nào cả.
    acceptDownloads: true,
    downloadsPath: path.resolve('data/downloads'),
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
      // Ghi log chi tiết nội bộ của Chrome ra file trong thư mục profile — để biết chính xác
      // lý do khi Chrome tự thoát/crash mà không để lại dấu vết gì trong log hệ thống.
      '--enable-logging',
      '--v=1',
    ],
  });

  // Bắt sự kiện crash/đóng ngay khi xảy ra — nhanh và rõ ràng hơn nhiều so với đào log hệ thống.
  context.on('close', () => logger.warn('SỰ KIỆN: browser context đã đóng.'));
  context.on('page', (page) => {
    page.on('crash', () => logger.error('SỰ KIỆN: 1 trang bị CRASH (renderer process chết).'));
    page.on('close', () => logger.warn('SỰ KIỆN: 1 trang đã đóng.'));
  });

  return context;
}
