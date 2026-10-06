import fs from 'node:fs';
import type { BrowserContext, Page } from 'playwright';
import { logger } from './logger.js';

// Đọc thẳng HTML của trang (lưu lại từ 1 lần lỗi trước) mới biết được ID THẬT của 2 nút toggle —
// không phải <button role="button"> với text "TEAM"/"GOOGLE" như đoán, mà là 2 <div>/phần tử lấy
// qua document.getElementById('teamOption') / getElementById('googleOption'), gắn addEventListener
// 'click' riêng. Đây là lý do mọi cách đoán theo role=button/role=tab/text hiển thị trước đó đều
// thất bại giống hệt nhau — phần tử không có role phù hợp để getByRole/getByText nhận diện đúng.
const TAB_ELEMENT_IDS: Record<'TEAM' | 'GOOGLE', string> = {
  TEAM: 'teamOption',
  GOOGLE: 'googleOption',
};

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

    // Bấm theo đúng ID thật lấy được từ HTML trang (#teamOption / #googleOption) — xem giải thích
    // ở TAB_ELEMENT_IDS phía trên, không còn đoán theo role/text hiển thị nữa.
    const tabBtn = page.locator(`#${TAB_ELEMENT_IDS[tab]}`).first();
    const tabBtnVisible = await tabBtn
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    if (!tabBtnVisible) {
      await dumpDebugEvidence(page, downloadDir, tab);
      throw new Error(`Không tìm thấy phần tử tab "${tab}" (#${TAB_ELEMENT_IDS[tab]}) trên meetscript.io.`);
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
