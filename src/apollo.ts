import path from 'node:path';
import type { BrowserContext } from 'playwright';
import { logger } from './logger.js';

/**
 * ⚠️ GIẢ ĐỊNH CẦN KIỂM CHỨNG:
 * Các selector dưới đây được viết theo cấu trúc UI phổ biến của Apollo.io (bấm "Clear all"
 * để xoá filter, tick checkbox đầu bảng rồi bấm link "Select all N contacts", mở menu bulk
 * action rồi chọn "Export Emails", chờ nút "Download" xuất hiện). Mình không có quyền truy
 * cập tài khoản Apollo thật để xác minh DOM chính xác, nên rất có thể 1-2 bước sẽ cần chỉnh
 * lại selector cho khớp giao diện thật.
 *
 * Cách debug khi 1 bước fail:
 *   HEADLESS=false npm run flow -- <url>     # xem trực tiếp trình duyệt đang làm gì
 *   PWDEBUG=1 npm run flow -- <url>          # mở Playwright Inspector, chạy từng bước,
 *                                             # bấm "Pick locator" để lấy đúng selector rồi
 *                                             # sửa lại trong file này.
 */

export async function exportListEmails(
  context: BrowserContext,
  listUrl: string,
  downloadDir: string,
): Promise<string> {
  const page = await context.newPage();
  logger.info(`Mở list Apollo: ${listUrl}`);
  await page.goto(listUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');

  // 1. Xoá tất cả filter đang áp dụng lên list
  const clearAllBtn = page.getByRole('button', { name: /clear all/i }).first();
  if (await clearAllBtn.isVisible().catch(() => false)) {
    await clearAllBtn.click();
    await page.waitForLoadState('networkidle');
    logger.info('Đã xoá filter.');
  } else {
    logger.warn('Không thấy nút "Clear all" — có thể list đang không có filter, hoặc selector cần chỉnh lại.');
  }

  // 2. Chọn tất cả contact trong list (không chỉ trang hiện tại)
  const headerCheckbox = page.locator('thead input[type="checkbox"]').first();
  await headerCheckbox.click();

  const selectAllLink = page.getByText(/select all .* contacts?/i).first();
  if (await selectAllLink.isVisible({ timeout: 3000 }).catch(() => false)) {
    await selectAllLink.click();
    logger.info('Đã chọn toàn bộ contact trong list.');
  } else {
    logger.warn('Không thấy link "Select all N contacts" — có thể list chỉ có 1 trang, hoặc selector cần chỉnh lại.');
  }

  // 3. Mở menu bulk action -> Export -> Export Emails
  await page.getByRole('button', { name: /export/i }).first().click();
  await page.getByText(/export emails?/i).first().click();

  // Một số flow của Apollo có thêm dialog xác nhận trước khi export thật sự
  const confirmExportBtn = page.getByRole('button', { name: /^export$/i }).last();
  if (await confirmExportBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await confirmExportBtn.click();
  }
  logger.info('Đã gửi yêu cầu export.');

  // 4. Chờ Apollo xử lý xong (nút Download xuất hiện) rồi tải file
  logger.info('Đang chờ Apollo xử lý export, có thể mất vài phút với list lớn...');
  const downloadBtn = page.getByRole('button', { name: /download/i }).first();
  await downloadBtn.waitFor({ state: 'visible', timeout: 5 * 60_000 });

  const [download] = await Promise.all([page.waitForEvent('download'), downloadBtn.click()]);

  const filePath = path.join(downloadDir, `apollo-export-${Date.now()}.csv`);
  await download.saveAs(filePath);
  logger.info(`Đã tải file export Apollo về: ${filePath}`);

  await page.close();
  return filePath;
}

export async function importCsv(context: BrowserContext, filePath: string): Promise<void> {
  const page = await context.newPage();
  await page.goto('https://app.apollo.io/#/import', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');

  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.setInputFiles(filePath);
  logger.info(`Đã chọn file để import: ${filePath}`);

  // Apollo thường yêu cầu map cột (email -> Email, RESULT -> cột tuỳ chỉnh) trước khi import.
  // Bước map cột phụ thuộc vào UI thực tế lúc đó nên KHÔNG tự động hoá ở đây — nếu Apollo tự
  // nhận diện đúng cột thì nút Import dưới đây sẽ bấm được ngay; nếu không, cần thêm bước
  // chọn mapping thủ công (hoặc mình bổ sung code sau khi biết chính xác UI mapping).
  const importBtn = page.getByRole('button', { name: /^import$/i }).first();
  await importBtn.waitFor({ state: 'visible', timeout: 60_000 });
  await importBtn.click();

  logger.info('Đã submit import CSV lên Apollo — vào Apollo kiểm tra lại kết quả import/mapping cột.');
  await page.close();
}
