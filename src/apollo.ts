import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { logger } from './logger.js';

/**
 * Apollo là 1 SPA có nhiều request nền chạy liên tục (real-time update, tracking...),
 * nên `page.waitForLoadState('networkidle')` gần như không bao giờ thực sự "idle" và hay
 * bị timeout dù trang đã tải/thao tác xong bình thường. Dùng hàm này để "chờ cho có" mà
 * không làm crash cả luồng nếu nó timeout — chỉ coi như 1 khoảng nghỉ ngắn.
 */
async function softWaitNetworkIdle(page: Page, timeout = 8000): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout }).catch(() => {
    logger.warn('Mạng chưa "idle" hẳn sau khi chờ, tiếp tục luôn (thường không sao với Apollo).');
  });
}

/**
 * Nhiều nút trong Apollo chỉ có icon, không có chữ, nên "tên" mà Playwright đọc được
 * (accessible name, dùng để match getByRole) có thể không chứa từ mình đoán (vd "export").
 * Hàm này thử lần lượt nhiều cách nhận diện 1 nút, bấm vào cái đầu tiên tìm thấy.
 */
async function clickFirstVisible(
  candidates: ReturnType<Page['locator']>[],
  timeout = 4000,
): Promise<boolean> {
  for (const loc of candidates) {
    const target = loc.first();
    const visible = await target.isVisible({ timeout }).catch(() => false);
    if (visible) {
      await target.click();
      return true;
    }
  }
  return false;
}

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

/**
 * In ra log danh sách toàn bộ nút (button/role=button) đang có trên trang kèm text/aria-label/
 * title của chúng — để biết chính xác tên thật của 1 nút icon-only thay vì đoán qua ảnh.
 */
async function dumpToolbarButtons(page: Page): Promise<void> {
  try {
    const buttons = await page.evaluate(() => {
      // Tìm phần tử chứa chữ "N selected" (vd "Clear 1783 selected") để xác định đúng thanh
      // công cụ bulk-action, rồi chỉ liệt kê nút BÊN TRONG nó — tránh lẫn hàng chục nút khác
      // (dropdown cột, sidebar...) nằm rải rác toàn trang khiến danh sách quá dài để xem.
      const all = Array.from(document.querySelectorAll('body *'));
      const marker = all.find(
        (el) => /\d+\s+selected/i.test(el.textContent || '') && el.children.length <= 3,
      );
      let scope: Element = document.body;
      if (marker) {
        let el: Element = marker;
        for (let i = 0; i < 5 && el.parentElement; i++) el = el.parentElement;
        scope = el;
      }
      const els = Array.from(scope.querySelectorAll('button, [role="button"]'));
      return els.map((el, i) => ({
        index: i,
        text: (el.textContent ?? '').trim().slice(0, 40),
        ariaLabel: el.getAttribute('aria-label'),
        title: el.getAttribute('title'),
        testId: el.getAttribute('data-testid'),
        classes: (el.getAttribute('class') ?? '').slice(0, 100),
      }));
    });
    logger.error('DEBUG danh sách nút trong thanh bulk-action:', JSON.stringify(buttons, null, 2));
  } catch (evalErr) {
    logger.warn('Không lấy được danh sách nút debug:', evalErr);
  }
}

/** Chụp ảnh màn hình trang hiện tại để debug khi có bước nào đó fail, không throw nếu tự nó lỗi. */
async function dumpDebugScreenshot(page: Page, downloadDir: string, label: string): Promise<void> {
  try {
    const debugPath = path.join(downloadDir, `debug-${label}-${Date.now()}.png`);
    await page.screenshot({ path: debugPath, fullPage: true });
    logger.error(`Đã lưu ảnh chụp màn hình lúc lỗi: ${debugPath}`);
  } catch (screenshotErr) {
    logger.warn('Không chụp được ảnh debug:', screenshotErr);
  }
}

export async function exportListEmails(
  context: BrowserContext,
  listUrl: string,
  downloadDir: string,
): Promise<string> {
  const page = await context.newPage();
  try {
    return await exportListEmailsInner(page, listUrl, downloadDir);
  } catch (err) {
    await dumpDebugScreenshot(page, downloadDir, 'export');
    throw err;
  }
}

async function exportListEmailsInner(page: Page, listUrl: string, downloadDir: string): Promise<string> {
  logger.info(`Mở list Apollo: ${listUrl}`);
  await page.goto(listUrl, { waitUntil: 'domcontentloaded' });
  await softWaitNetworkIdle(page);

  // Chờ bảng danh sách contact thực sự xuất hiện. Không rõ Apollo dùng <table> thật hay
  // <div> giả lập, nên thử vài kiểu selector phổ biến; nếu không cái nào khớp trong 30s,
  // vẫn tiếp tục (không throw) để các bước sau + ảnh debug cho biết thực tế trang đang hiện gì.
  const tableCandidates = ['table', '[role="table"]', '[role="grid"]', '[data-testid*="table" i]'];
  let tableScope: ReturnType<Page['locator']> = page.locator('body');
  let tableFound = false;
  for (const selector of tableCandidates) {
    const loc = page.locator(selector).first();
    const visible = await loc
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (visible) {
      tableScope = loc;
      tableFound = true;
      logger.info(`Đã thấy bảng contact (selector: ${selector}).`);
      break;
    }
  }
  if (!tableFound) {
    logger.warn('Không tìm thấy bảng contact với các selector thử sẵn — tiếp tục luôn, sẽ có ảnh debug nếu bước sau fail.');
  }

  // 1. Xoá tất cả filter đang áp dụng lên list
  const clearAllBtn = page.getByRole('button', { name: /clear all/i }).first();
  if (await clearAllBtn.isVisible().catch(() => false)) {
    await clearAllBtn.click();
    await softWaitNetworkIdle(page);
    logger.info('Đã xoá filter.');
  } else {
    logger.warn('Không thấy nút "Clear all" — có thể list đang không có filter, hoặc selector cần chỉnh lại.');
  }

  // 2. Chọn tất cả contact trong list (không chỉ trang hiện tại)
  // Apollo dùng checkbox tự chế (không phải <input type="checkbox">), nên tìm theo "role"
  // (accessibility) thay vì đúng thẻ HTML — cách này khớp được cả 2 kiểu.
  // Checkbox chọn-tất-cả nằm ở đầu bảng (trước cột NAME), nên lấy checkbox đầu tiên trong bảng.
  const headerCheckbox = tableScope.getByRole('checkbox').first();
  await headerCheckbox.click({ timeout: 15_000 });

  // Click checkbox đầu bảng mở ra 1 dropdown hỏi chọn kiểu nào: "Select number of people" /
  // "Select this page N" / "Select all N" (radio option, không có chữ "contacts" đi kèm).
  const selectAllOption = page.getByText(/^select all$/i).first();
  if (await selectAllOption.isVisible({ timeout: 5000 }).catch(() => false)) {
    await selectAllOption.click();
    const applyBtn = page.getByRole('button', { name: /^apply$/i }).first();
    if (await applyBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await applyBtn.click();
    }
    logger.info('Đã chọn toàn bộ contact trong list.');
  } else {
    logger.warn('Không thấy dropdown "Select all" — có thể Apollo đã tự chọn hết, hoặc UI khác đi.');
  }

  // 3. Mở menu bulk action -> Export -> Export Emails
  // Nút Export trong thanh công cụ thường chỉ có icon, không có chữ, nên thử nhiều cách nhận diện.
  const openedExportMenu = await clickFirstVisible([
    page.getByRole('button', { name: /^export$/i }),
    page.getByRole('button', { name: /export/i }),
    page.locator('[aria-label*="export" i]'),
    page.locator('[title*="export" i]'),
    page.getByRole('button', { name: /^download$/i }),
    page.locator('[aria-label*="download" i]'),
  ]);
  if (!openedExportMenu) {
    await dumpToolbarButtons(page);
    throw new Error('Không tìm thấy nút Export trong thanh công cụ bulk action (đã thử theo tên, aria-label, title).');
  }

  const clickedExportEmails = await clickFirstVisible([
    page.getByText(/export emails?/i),
    page.getByRole('menuitem', { name: /export emails?/i }),
    page.getByRole('menuitem', { name: /email/i }),
  ]);
  if (!clickedExportEmails) {
    logger.warn('Không thấy menu item "Export Emails" — có thể Export đã chạy thẳng không qua menu con.');
  }

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

export async function importCsv(context: BrowserContext, filePath: string, downloadDir: string): Promise<void> {
  const page = await context.newPage();
  try {
    await importCsvInner(page, filePath);
  } catch (err) {
    await dumpDebugScreenshot(page, downloadDir, 'import');
    throw err;
  }
}

async function importCsvInner(page: Page, filePath: string): Promise<void> {
  await page.goto('https://app.apollo.io/#/import', { waitUntil: 'domcontentloaded' });
  await softWaitNetworkIdle(page);

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
