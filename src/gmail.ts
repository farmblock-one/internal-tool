import type { BrowserContext, Page, Request } from 'playwright';
import { logger } from './logger.js';
import { buildCurlCommand, findVisibleLocator, hardReload } from './curl-utils.js';

// Có cả request "Lookup" (OPTIONS, preflight) và request "Lookup" thật (thường là POST) — CHỈ bắt
// cái thật, bỏ qua OPTIONS, nếu không dễ bắt nhầm cái preflight (không có auth header đầy đủ).
function isRealLookupRequest(req: Request): boolean {
  return /lookup/i.test(req.url()) && req.method().toUpperCase() !== 'OPTIONS';
}

/** Chờ "cho có" — Gmail cũng là SPA nặng, mạng gần như không bao giờ thực sự "idle". */
async function softWaitNetworkIdle(page: Page, timeout = 8000): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout }).catch(() => {});
}

/**
 * Mở Gmail, search 1 email bất kỳ để trigger request "Lookup" (autocomplete gợi ý người nhận),
 * bắt lại request đó rồi dựng thành 1 lệnh cURL — dùng cho tab GOOGLE của form upload
 * meetscript.io (cùng khái niệm với fetchTeamsSearchCurl ở teams.ts, khác trang/endpoint).
 */
export async function fetchGmailLookupCurl(
  context: BrowserContext,
  downloadDir: string,
  // Dùng 1 email NGOÀI tổ chức (không phải @nscsoftware.com) — email cùng nội bộ dễ không trigger
  // đúng request "Lookup" (có thể do Gmail đã biết sẵn contact nội bộ, không cần tra cứu ngoài).
  probeEmail = 'anna.nguyen@payreq.com',
): Promise<string> {
  const page = await context.newPage();
  // Khai báo NGOÀI try để catch vẫn đọc được danh sách request đã thấy khi có lỗi/timeout.
  const staticAssetPattern = /\.(js|css|png|jpe?g|svg|gif|woff2?|ico)(\?|$)/i;
  const seenRequests: string[] = [];
  page.on('request', (req) => {
    if (!staticAssetPattern.test(req.url())) {
      seenRequests.push(`${req.method()} ${req.url()}`);
    }
  });
  try {
    await page.goto('https://mail.google.com/', { waitUntil: 'domcontentloaded' });
    // Reload cứng (bỏ qua cache, tương đương Ctrl+Shift+R) trước khi search — nghi ngờ bản JS/
    // token cũ trong cache khiến request bắt được trước đó không hợp lệ dù có vẻ đúng cấu trúc.
    await hardReload(page);
    await softWaitNetworkIdle(page);

    // Request Lookup thật đi tới domain RIÊNG (peoplestack-pa.clients6.google.com, khác hẳn
    // mail.google.com) và chỉ bắn ra SAU KHI phần kết quả tìm kiếm chính tải xong — ảnh debug lần
    // trước cho thấy trang còn đang "Loading..." lúc hết 30s, nên tăng thời gian chờ lên nhiều.
    const requestPromise: Promise<Request> = page.waitForRequest(isRealLookupRequest, { timeout: 90_000 });
    // Xem giải thích ở teams.ts: gắn catch rỗng ngay để Node không crash vì unhandled rejection
    // nếu promise này timeout trước khi mình thật sự await nó ở dưới.
    requestPromise.catch(() => {});

    const searchBox = await findVisibleLocator(
      [
        page.getByPlaceholder(/search mail/i).first(),
        page.getByRole('combobox', { name: /search mail/i }).first(),
        page.locator('input[name="q"]').first(),
        page.locator('input[aria-label*="search" i]').first(),
      ],
      15_000,
    );
    if (!searchBox) {
      throw new Error('Không tìm thấy ô tìm kiếm trên Gmail (đã thử placeholder/role/name=q/aria-label).');
    }
    await searchBox.click();
    // Gợi ý autocomplete người nhận của Gmail có thể chỉ lắng nghe sự kiện gõ phím thật, không
    // phản ứng với fill() (gán giá trị thẳng vào input) — gõ từng ký tự thật để chắc chắn trigger
    // đúng request lookup, giống hệt cách người dùng gõ tay.
    await searchBox.pressSequentially(probeEmail, { delay: 80 });
    // Request "Lookup" CHỈ bắn ra sau khi bấm Enter để thật sự tìm kiếm — gõ vào ô không đủ, dropdown
    // gợi ý lúc đó chỉ là lịch sử tìm kiếm thường, không phải lookup liên hệ (đã xác nhận thực tế).
    await searchBox.press('Enter');

    const request = await requestPromise;
    const headers = await request.allHeaders();
    const postData = request.postData();
    const curl = buildCurlCommand(request.url(), request.method(), headers, postData);
    logger.info(
      `Đã bắt được request "Lookup" từ Gmail (${request.method()} ${request.url().slice(0, 80)}..., ` +
        `body: ${postData ? `${postData.length} ký tự` : '(không có)'}).`,
    );
    return curl;
  } catch (err) {
    const debugPath = `${downloadDir}/debug-gmail-${Date.now()}.png`;
    await page.screenshot({ path: debugPath, fullPage: true }).catch(() => {});
    logger.error(`Lỗi khi lấy cURL từ Gmail — đã lưu ảnh debug: ${debugPath}`);
    if (seenRequests.length > 0) {
      logger.error(`Các request đã thấy được (không tính file tĩnh):\n${seenRequests.slice(-40).join('\n')}`);
    } else {
      logger.error('KHÔNG thấy request nào (ngoài file tĩnh) trong suốt thời gian chờ.');
    }
    throw err;
  } finally {
    await page.close().catch(() => {});
  }
}
