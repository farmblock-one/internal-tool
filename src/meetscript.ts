import type { BrowserContext } from 'playwright';
import { logger } from './logger.js';

/**
 * Mở seacher.meetscript.io, đảm bảo đang ở tab "TEAM", dán lệnh cURL (lấy từ Teams) + chọn file
 * Excel chứa các lead Risky, rồi bấm "Upload Data".
 *
 * LƯU Ý: chưa biết chính xác trang có báo thành công/thất bại rõ ràng thế nào (chưa test thật
 * lần nào) — nếu có lỗi, xem ảnh debug được lưu lại cùng thư mục downloads.
 */
export async function uploadRiskyToMeetscript(
  context: BrowserContext,
  curlCommand: string,
  excelFilePath: string,
  downloadDir: string,
): Promise<void> {
  const page = await context.newPage();
  try {
    await page.goto('https://seacher.meetscript.io/', { waitUntil: 'domcontentloaded' });

    const teamTabBtn = page.getByRole('button', { name: /^team$/i }).first();
    if (await teamTabBtn.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await teamTabBtn.click();
    }

    const curlTextarea = page.getByPlaceholder(/paste your team curl command/i).first();
    await curlTextarea.waitFor({ state: 'visible', timeout: 15_000 });
    await curlTextarea.fill(curlCommand);

    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.waitFor({ state: 'attached', timeout: 15_000 });
    await fileInput.setInputFiles(excelFilePath);

    const uploadBtn = page.getByRole('button', { name: /^upload data$/i }).first();
    await uploadBtn.waitFor({ state: 'visible', timeout: 15_000 });
    await uploadBtn.click();

    logger.info('Đã submit upload file Risky lên meetscript.io.');
  } catch (err) {
    const debugPath = `${downloadDir}/debug-meetscript-${Date.now()}.png`;
    await page.screenshot({ path: debugPath, fullPage: true }).catch(() => {});
    logger.error(`Lỗi khi upload lên meetscript.io — đã lưu ảnh debug: ${debugPath}`);
    throw err;
  } finally {
    await page.close().catch(() => {});
  }
}
