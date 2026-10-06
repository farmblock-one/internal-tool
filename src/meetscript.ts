import type { BrowserContext } from 'playwright';
import { logger } from './logger.js';
import { findVisibleLocator } from './curl-utils.js';

/**
 * Mở seacher.meetscript.io, chọn đúng tab (TEAM hoặc GOOGLE), dán lệnh cURL tương ứng + chọn file
 * Excel chứa các lead Risky, rồi bấm "Upload Data". Gọi 2 lần riêng (1 lần cho TEAM, 1 lần cho
 * GOOGLE) — mỗi lần tự mở trang mới từ đầu, không phụ thuộc trạng thái lẫn nhau.
 */
export async function uploadRiskyToMeetscript(
  context: BrowserContext,
  curlCommand: string,
  excelFilePath: string,
  downloadDir: string,
  tab: 'TEAM' | 'GOOGLE' = 'TEAM',
): Promise<void> {
  const page = await context.newPage();
  try {
    await page.goto('https://seacher.meetscript.io/', { waitUntil: 'domcontentloaded' });

    // isVisible() kiểm tra TỨC THÌ, không chờ/poll như waitFor — nếu trang chưa kịp render xong,
    // nó trả về false ngay và code bỏ qua luôn việc bấm nút, kẹt lại ở tab mặc định (TEAM). Đã gặp
    // đúng lỗi này ở teams.ts/gmail.ts trước đó, giờ sửa luôn ở đây bằng findVisibleLocator (poll thật).
    // Đổi sang khớp CÓ CHỨA (không neo ^...$) vẫn không ăn thua — khả năng cao đây không phải thẻ
    // <button> thật (không có role="button"), nên getByRole('button', ...) không bao giờ tìm
    // thấy dù tên đúng. Thử thêm nhiều cách nhận diện khác: role="tab", mọi phần tử có role
    // button/tab, và cuối cùng là bấm thẳng vào chữ hiển thị (dựa vào bubbling lên phần tử cha
    // có thể bấm được).
    const tabBtn = await findVisibleLocator(
      [
        page.getByRole('button', { name: new RegExp(tab, 'i') }).first(),
        page.getByRole('tab', { name: new RegExp(tab, 'i') }).first(),
        page
          .locator('button, [role="button"], [role="tab"]')
          .filter({ hasText: new RegExp(tab, 'i') })
          .first(),
        page.getByText(new RegExp(`^${tab}$`, 'i')).first(),
      ],
      10_000,
    );
    if (!tabBtn) {
      throw new Error(`Không tìm thấy nút tab "${tab}" trên meetscript.io.`);
    }
    await tabBtn.click();

    const curlTextarea = page.getByPlaceholder(new RegExp(`paste your ${tab} curl command`, 'i')).first();
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

    const resultPath = `${downloadDir}/result-meetscript-${tab.toLowerCase()}-${Date.now()}.png`;
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
    const debugPath = `${downloadDir}/debug-meetscript-${tab.toLowerCase()}-${Date.now()}.png`;
    await page.screenshot({ path: debugPath, fullPage: true }).catch(() => {});
    logger.error(`Lỗi khi upload lên meetscript.io (tab ${tab}) — đã lưu ảnh debug: ${debugPath}`);
    throw err;
  } finally {
    await page.close().catch(() => {});
  }
}
