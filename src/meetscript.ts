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

    // Chưa biết chính xác endpoint backend của meetscript.io gọi khi bấm Upload — ghi lại MỌI
    // response không phải file tĩnh (js/css/ảnh/font) trong lúc submit, để biết request thật sự
    // có được gửi đi không và server trả về gì (thay vì chỉ tin là bấm được nút là xong — lần
    // trước đã bấm "thành công" nhưng thực chất không có request hợp lệ nào tới nơi).
    const staticAssetPattern = /\.(js|css|png|jpe?g|svg|gif|woff2?|ico)(\?|$)/i;
    const responseLogs: string[] = [];
    page.on('response', (res) => {
      if (!staticAssetPattern.test(res.url())) {
        responseLogs.push(`${res.status()} ${res.request().method()} ${res.url()}`);
      }
    });

    // Kết quả THẬT SỰ không phải 1 phần tử HTML trên trang mà là popup gốc của trình duyệt
    // (window.alert) — Playwright coi đây là 1 loại sự kiện riêng ("dialog"), không thể tìm bằng
    // locator/getByRole như các phần tử thường. Phải đăng ký lắng nghe TRƯỚC khi nó xuất hiện, và
    // nó có thể mất tới ~5 phút mới hiện ra (server xử lý xong mới bắn alert), nên không được đóng
    // trang sớm — lỗi trước đó là do đóng trang chỉ sau 5 giây, alert chưa kịp xuất hiện.
    const dialogPromise = new Promise<string>((resolve) => {
      page.once('dialog', (dialog) => {
        const message = dialog.message();
        dialog.accept().catch(() => {});
        resolve(message);
      });
    });

    const uploadBtn = page.getByRole('button', { name: /^upload data$/i }).first();
    await uploadBtn.waitFor({ state: 'visible', timeout: 15_000 });
    await uploadBtn.click();

    logger.info('Đã bấm Upload Data — đang chờ popup xác nhận (có thể mất tới ~5 phút)...');
    const dialogMessage = await Promise.race([
      dialogPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 6 * 60_000)),
    ]);

    const resultPath = `${downloadDir}/result-meetscript-${Date.now()}.png`;
    await page.screenshot({ path: resultPath, fullPage: true }).catch(() => {});

    if (dialogMessage === null) {
      logger.warn(`Chờ quá 6 phút mà không thấy popup xác nhận — ảnh chụp lúc này: ${resultPath}`);
      if (responseLogs.length > 0) {
        logger.info(`Các response ghi nhận được:\n${responseLogs.join('\n')}`);
      }
      throw new Error('Không thấy popup xác nhận sau khi Upload Data (chờ 6 phút).');
    }

    logger.info(`Đã bấm OK trên popup xác nhận: "${dialogMessage}" — ảnh: ${resultPath}`);
  } catch (err) {
    const debugPath = `${downloadDir}/debug-meetscript-${Date.now()}.png`;
    await page.screenshot({ path: debugPath, fullPage: true }).catch(() => {});
    logger.error(`Lỗi khi upload lên meetscript.io — đã lưu ảnh debug: ${debugPath}`);
    throw err;
  } finally {
    await page.close().catch(() => {});
  }
}
