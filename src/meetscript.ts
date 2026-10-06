import fs from 'node:fs';
import type { BrowserContext, Locator, Page } from 'playwright';
import { logger } from './logger.js';

/**
 * 3 lần trước đổi cách đoán selector (role=button -> role=tab -> nhiều loại phần tử/text) đều
 * thất bại GIỐNG HỆT NHAU dù ảnh debug cho thấy nút hiển thị rõ ràng, bình thường trên trang. Ảnh
 * chụp (screenshot) ghi lại TOÀN BỘ hình ảnh hiển thị kể cả nội dung bên trong iframe, nhưng
 * page.getByRole()/page.locator() mặc định CHỈ tìm trong frame chính (main frame), không tự chui
 * vào iframe — nếu nút TEAM/GOOGLE nằm trong 1 iframe (ví dụ nhúng 1 widget bên thứ 3), ảnh vẫn
 * thấy nút nhưng locator tìm ở frame chính sẽ không bao giờ thấy, bất kể đổi kiểu selector nào.
 * Sửa bằng cách duyệt qua TẤT CẢ frame của trang (page.frames(), bao gồm cả frame chính), tự poll
 * định kỳ (vì không gọi waitFor trực tiếp được khi cần duyệt nhiều frame thay đổi theo thời gian).
 */
async function findTabButtonAnyFrame(page: Page, tab: string, timeoutMs: number): Promise<Locator | null> {
  const pattern = new RegExp(tab, 'i');
  const exactPattern = new RegExp(`^${tab}$`, 'i');
  const deadline = Date.now() + timeoutMs;
  do {
    for (const frame of page.frames()) {
      const candidates = [
        frame.getByRole('button', { name: pattern }).first(),
        frame.getByRole('tab', { name: pattern }).first(),
        frame.locator('button, [role="button"], [role="tab"]').filter({ hasText: pattern }).first(),
        frame.getByText(exactPattern).first(),
      ];
      for (const candidate of candidates) {
        const visible = await candidate.isVisible().catch(() => false);
        if (visible) return candidate;
      }
    }
    await page.waitForTimeout(300);
  } while (Date.now() < deadline);
  return null;
}

/** Lưu lại bằng chứng thật (HTML + danh sách frame) khi không tìm được nút, thay vì tiếp tục đoán mò. */
async function dumpDebugEvidence(page: Page, downloadDir: string, tab: string): Promise<string> {
  const ts = Date.now();
  const frames = page.frames();
  const framesInfo = frames.map((f, i) => `  [${i}] url=${f.url()}`).join('\n');
  const htmlPath = `${downloadDir}/debug-meetscript-${tab.toLowerCase()}-${ts}.html`;
  const mainHtml = await page.content().catch((e) => `(không lấy được HTML frame chính: ${e})`);
  const framesHtml = await Promise.all(
    frames.map(async (f, i) => {
      const html = await f.content().catch((e) => `(không lấy được HTML: ${e})`);
      return `\n\n===== FRAME ${i} (${f.url()}) =====\n${html}`;
    }),
  );
  fs.writeFileSync(htmlPath, `===== MAIN FRAME =====\n${mainHtml}${framesHtml.join('')}`);
  logger.info(`Tổng số frame trên trang: ${frames.length}\n${framesInfo}\nĐã lưu HTML đầy đủ (mọi frame): ${htmlPath}`);
  return htmlPath;
}

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
    // thấy dù tên đúng. 3 lần đổi cách đoán selector trước đều thất bại giống hệt nhau dù ảnh chụp
    // cho thấy nút hiển thị bình thường — nghi ngờ nút nằm trong 1 iframe (widget nhúng), nên giờ
    // duyệt qua TẤT CẢ frame của trang thay vì chỉ tìm ở frame chính.
    const tabBtn = await findTabButtonAnyFrame(page, tab, 15_000);
    if (!tabBtn) {
      await dumpDebugEvidence(page, downloadDir, tab);
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
