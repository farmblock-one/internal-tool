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

    const uploadBtn = page.getByRole('button', { name: /^upload data$/i }).first();
    await uploadBtn.waitFor({ state: 'visible', timeout: 15_000 });
    await uploadBtn.click();

    // Chờ 1 chút cho request thật (nếu có) và thông báo kết quả (toast/text) kịp xuất hiện, rồi
    // LUÔN chụp ảnh màn hình (không chỉ lúc lỗi) — cần bằng chứng thực tế xem có thành công thật
    // hay không, không tự suy diễn chỉ từ việc bấm nút không báo lỗi.
    await page.waitForTimeout(5000);
    const resultPath = `${downloadDir}/result-meetscript-${Date.now()}.png`;
    await page.screenshot({ path: resultPath, fullPage: true }).catch(() => {});

    logger.info(`Đã bấm Upload Data — ảnh kết quả: ${resultPath}`);
    if (responseLogs.length === 0) {
      logger.warn('KHÔNG thấy request nào (ngoài file tĩnh) được gửi đi sau khi bấm Upload Data — có thể nút không thực sự submit gì.');
    } else {
      logger.info(`Các response ghi nhận được sau khi bấm Upload Data:\n${responseLogs.join('\n')}`);
    }
  } catch (err) {
    const debugPath = `${downloadDir}/debug-meetscript-${Date.now()}.png`;
    await page.screenshot({ path: debugPath, fullPage: true }).catch(() => {});
    logger.error(`Lỗi khi upload lên meetscript.io — đã lưu ảnh debug: ${debugPath}`);
    throw err;
  } finally {
    await page.close().catch(() => {});
  }
}
