import path from 'node:path';
import type { BrowserContext, Locator, Page } from 'playwright';
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
 * Một số nút icon-only trong Apollo KHÔNG có aria-label/title — tên của nó chỉ xuất hiện dưới
 * dạng tooltip khi thực sự di chuột (hover) vào. Hàm này hover lần lượt qua các nút không có
 * chữ (icon-only) đang hiển thị, đọc tooltip vừa hiện ra, khớp với `tooltipPattern` thì bấm.
 */
async function clickButtonByTooltip(
  page: Page,
  scope: Locator,
  tooltipPattern: RegExp,
  maxCandidates = 20,
): Promise<boolean> {
  // Không đoán class/role của tooltip nữa (class của Apollo bị mã hoá ngẫu nhiên, không đoán
  // được) — thay vào đó, hover xong kiểm tra xem CHỮ đó có hiện ra GẦN vị trí nút vừa hover
  // không (tooltip luôn hiện sát cạnh nút) — tránh nhầm với menu/dropdown/dialog ở xa mà tình
  // cờ cũng chứa chữ khớp (đã từng bị nhầm sang menu "Add records to list").
  const textCandidates = page.getByText(tooltipPattern);
  const PROXIMITY_PX = 120;

  const all = scope.locator('button, [role="button"]');
  const count = Math.min(await all.count(), maxCandidates);
  for (let i = 0; i < count; i++) {
    const btn = all.nth(i);
    const visible = await btn.isVisible().catch(() => false);
    if (!visible) continue;
    const text = ((await btn.textContent().catch(() => '')) ?? '').trim();
    if (text) continue; // chỉ quan tâm nút icon-only (không có chữ hiển thị)

    await btn.hover().catch(() => {});
    await page.waitForTimeout(400);

    const btnBox = await btn.boundingBox().catch(() => null);
    let matchedNearby = false;
    if (btnBox) {
      const textCount = Math.min(await textCandidates.count(), 5);
      for (let j = 0; j < textCount; j++) {
        const textEl = textCandidates.nth(j);
        if (!(await textEl.isVisible().catch(() => false))) continue;
        const textBox = await textEl.boundingBox().catch(() => null);
        if (!textBox) continue;
        const dx = Math.abs(textBox.x + textBox.width / 2 - (btnBox.x + btnBox.width / 2));
        const dy = Math.abs(textBox.y + textBox.height / 2 - (btnBox.y + btnBox.height / 2));
        if (dx < PROXIMITY_PX && dy < PROXIMITY_PX) {
          matchedNearby = true;
          break;
        }
      }
    }
    await page.mouse.move(0, 0).catch(() => {}); // rời chuột để tooltip ẩn đi trước khi thử nút kế
    if (matchedNearby) {
      await btn.click();
      return true;
    }
  }
  return false;
}

/**
 * Tìm locator đầu tiên (trong vài ứng viên khớp `candidates`) thực sự đang hiển thị — tránh
 * việc lấy nhầm 1 phần tử trùng văn bản nhưng đang ẩn (vd trạng thái "0 selected" mặc định).
 */
async function findVisibleLocator(
  candidates: Locator,
  maxCheck = 10,
  page?: Page,
  retryMs = 8000,
): Promise<Locator | null> {
  const deadline = Date.now() + (page ? retryMs : 0);
  do {
    const count = Math.min(await candidates.count(), maxCheck);
    for (let i = 0; i < count; i++) {
      const el = candidates.nth(i);
      if (await el.isVisible().catch(() => false)) return el;
    }
    if (page) await page.waitForTimeout(500);
  } while (Date.now() < deadline);
  return null;
}

/**
 * Từ 1 điểm neo (vd chữ "Clear 1911 selected"), đi ngược lên các phần tử cha tới khi tìm được
 * 1 vùng chứa đủ nhiều nút (>=5) — đó chính là thanh công cụ bulk-action, KHÔNG phải đoán cứng
 * số cấp cha cố định (dễ đi lố ra ngoài toàn trang, lẫn nút ở nơi khác như chuông thông báo).
 */
async function findToolbarScope(marker: Locator): Promise<Locator> {
  let scope = marker;
  for (let level = 1; level <= 6; level++) {
    scope = scope.locator('xpath=..');
    const count = await scope.locator('button, [role="button"]').count();
    if (count >= 5) return scope;
  }
  return scope;
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
      // Không đặt tên riêng cho hàm lọc (vd "const isRendered = ...") vì công cụ build (esbuild)
      // đôi khi chèn helper "__name" vào mà helper đó không tồn tại khi chạy trong trình duyệt
      // qua page.evaluate — gây lỗi "ReferenceError: __name is not defined". Viết trực tiếp
      // (inline) trong .filter() để tránh vấn đề này.
      const all = Array.from(document.querySelectorAll('body *')).filter(
        (el) => (el as HTMLElement).offsetParent !== null,
      );
      const marker = all.find((el) => /\d+\s+selected/i.test(el.textContent || '') && el.children.length <= 3);
      let scope: Element = document.body;
      if (marker) {
        let el: Element = marker;
        for (let i = 0; i < 5 && el.parentElement; i++) el = el.parentElement;
        scope = el;
      }
      const els = Array.from(scope.querySelectorAll('button, [role="button"]')).filter(
        (el) => (el as HTMLElement).offsetParent !== null,
      );
      return {
        scopeFoundViaMarker: !!marker,
        buttons: els.slice(0, 40).map((el, i) => ({
          index: i,
          text: (el.textContent ?? '').trim().slice(0, 40),
          ariaLabel: el.getAttribute('aria-label'),
          title: el.getAttribute('title'),
          testId: el.getAttribute('data-testid'),
          classes: (el.getAttribute('class') ?? '').slice(0, 100),
        })),
      };
    });
    logger.error(
      `DEBUG danh sách nút (tìm được vùng thanh công cụ: ${buttons.scopeFoundViaMarker}):`,
      JSON.stringify(buttons.buttons, null, 2),
    );
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
    await page.waitForTimeout(1500); // chờ UI cập nhật thanh "Clear N selected"
    logger.info('Đã chọn toàn bộ contact trong list.');
  } else {
    logger.warn('Không thấy dropdown "Select all" — có thể Apollo đã tự chọn hết, hoặc UI khác đi.');
  }

  // 3. Bấm icon Export trong đúng thanh công cụ bulk-action (không phải nút chuông thông báo
  // hay icon nào khác trên trang — thu hẹp phạm vi tìm về đúng thanh công cụ trước).
  const clearSelectedCandidates = page.getByText(/clear\s+[\d,]+\s+selected/i);
  const clearSelectedMarker = await findVisibleLocator(clearSelectedCandidates, 10, page);
  const toolbarScope = clearSelectedMarker ? await findToolbarScope(clearSelectedMarker) : page.locator('body');
  if (!clearSelectedMarker) {
    logger.warn('Không thấy chữ "Clear N selected" — có thể chưa chọn được contact nào, hoặc UI khác đi.');
  }

  // Nút Export chỉ có icon, không có aria-label/title — tên "Export" chỉ hiện qua tooltip khi
  // hover, nên phải hover từng nút icon-only trong thanh công cụ để tìm đúng cái có tooltip "Export".
  let clickedExportIcon = await clickButtonByTooltip(page, toolbarScope, /^export$/i);
  if (!clickedExportIcon) {
    // Phòng khi tooltip không bắt được kịp, vẫn thử thêm các cách nhận diện tĩnh như cũ.
    clickedExportIcon = await clickFirstVisible([
      toolbarScope.getByRole('button', { name: /^export$/i }),
      toolbarScope.getByRole('button', { name: /export/i }),
      toolbarScope.locator('[aria-label*="export" i]'),
      toolbarScope.locator('[title*="export" i]'),
    ]);
  }
  if (!clickedExportIcon) {
    await dumpToolbarButtons(page);
    throw new Error('Không tìm thấy nút Export (đã thử hover đọc tooltip + tên/aria-label/title).');
  }
  logger.info('Đã bấm icon Export.');

  // 4. Icon Export mở ra dialog "Export to CSV" (không phải menu) — mặc định đã chọn sẵn
  // "Export all emails", chỉ cần bấm nút "Export records" để xác nhận.
  let exportRecordsBtn = page.getByRole('button', { name: /export records/i }).first();
  let exportRecordsVisible = await exportRecordsBtn.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false);

  if (!exportRecordsVisible) {
    // Lỡ bấm nhầm nút khác (vd dialog "Please review and confirm selections" của tính năng
    // add-to-list) thì huỷ nó đi rồi thử bấm lại icon Export 1 lần nữa.
    logger.warn('Không thấy dialog "Export to CSV" — có thể lỡ bấm nhầm nút khác, thử huỷ và bấm lại Export.');
    const cancelBtn = page.getByRole('button', { name: /^cancel$/i }).first();
    if (await cancelBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await cancelBtn.click();
      await page.waitForTimeout(1000);
    }
    const retryClicked = await clickButtonByTooltip(page, toolbarScope, /^export$/i);
    if (!retryClicked) {
      await dumpToolbarButtons(page);
      throw new Error('Bấm lại icon Export lần 2 vẫn thất bại.');
    }
    logger.info('Đã bấm lại icon Export (lần 2).');
    exportRecordsBtn = page.getByRole('button', { name: /export records/i }).first();
    await exportRecordsBtn.waitFor({ state: 'visible', timeout: 15_000 });
  }

  await exportRecordsBtn.click();
  logger.info('Đã gửi yêu cầu export.');

  // 5. Chờ Apollo xử lý xong (nút Download xuất hiện trong dialog "CSV Export") rồi tải file.
  // Chờ theo từng đợt ngắn (thay vì 1 lần chờ dài 5 phút liên tục) và "động đậy" nhẹ trang giữa
  // các đợt — tránh Chrome coi tab là "không hoạt động" trong thời gian dài rồi có hành vi lạ.
  logger.info('Đang chờ Apollo xử lý export, có thể mất vài phút với list lớn...');
  const downloadBtn = page.getByRole('button', { name: /^download$/i }).first();
  const exportDeadline = Date.now() + 5 * 60_000;
  let downloadBtnVisible = false;
  while (Date.now() < exportDeadline) {
    downloadBtnVisible = await downloadBtn
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    if (downloadBtnVisible) break;
    await page.mouse.move(10, 10).catch(() => {});
  }
  if (!downloadBtnVisible) {
    throw new Error('Chờ quá 5 phút mà không thấy nút Download — kiểm tra thủ công tại Apollo.');
  }

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
