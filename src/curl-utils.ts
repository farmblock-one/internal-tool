import type { Locator, Page } from 'playwright';

/** Escape 1 giá trị để đặt an toàn trong dấu nháy đơn của lệnh bash (kiểu Chrome DevTools làm). */
function shellEscapeSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Các header này do CHÍNH trình duyệt tự quản lý (cookie jar, CORS/fetch metadata, content
// negotiation) — Chrome DevTools "Copy as cURL" tự loại bỏ hết khi copy, không đưa vào text.
// Playwright's request.allHeaders() thì lấy NGUYÊN VĂN mọi header thật sự gửi trên dây mạng, nên
// nếu không lọc tay sẽ dư ra các header này — đã xác nhận qua so sánh với 1 cURL mẫu lấy tay thật
// (từ DevTools): bản mẫu không có bất kỳ header nào trong danh sách dưới, kể cả "cookie" (request
// này rõ ràng không cần cookie, xác thực hoàn toàn qua authorization/x-skypetoken).
const BROWSER_MANAGED_HEADERS = new Set([
  'cookie',
  'origin',
  'priority',
  'accept-encoding',
  'accept-language',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-fetch-user',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
]);

/**
 * Header giả (pseudo-header, HTTP/2) bắt đầu bằng ":" không hợp lệ trong cú pháp `curl -H`, và
 * "content-length"/"host" nên để curl tự tính/tự suy ra từ URL — copy nguyên các header này vào
 * sẽ sai hoặc thừa, giống hệt cách Chrome DevTools tự lọc khi "Copy as cURL".
 */
function isHeaderToSkip(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith(':') || lower === 'content-length' || lower === 'host' || BROWSER_MANAGED_HEADERS.has(lower);
}

/**
 * Dựng lại 1 request Playwright thành lệnh cURL (bash), theo ĐÚNG định dạng 1 cURL mẫu hợp lệ
 * được xác nhận thật (không phải kiểu "Copy as cURL" mặc định của Chrome):
 *   - Dùng cờ `--url '...'` thay vì URL nằm ngay sau `curl` — nếu bên nhận tự parse text tìm cờ
 *     `--url` thì kiểu cũ (URL không có cờ) sẽ không nhận ra được.
 *   - KHÔNG thêm `-X POST` khi có `--data-raw` (curl tự hiểu là POST) và KHÔNG có `--compressed`
 *     ở cuối — mẫu hợp lệ không có cả hai, thêm vào là thừa/khác định dạng.
 *   - Header có giá trị rỗng dùng cú pháp đặc biệt `-H 'tên;'` (dấu `;` thay `:`) — đúng cách
 *     Chrome/Firefox xuất khi header gốc rỗng, không phải `-H 'tên: '`.
 */
export function buildCurlCommand(url: string, method: string, headers: Record<string, string>, postData: string | null): string {
  const lines = [`curl --url ${shellEscapeSingleQuoted(url)}`];
  const methodUpper = method.toUpperCase();
  const isPostWithData = methodUpper === 'POST' && !!postData;
  if (methodUpper !== 'GET' && !isPostWithData) {
    lines.push(`  -X ${shellEscapeSingleQuoted(methodUpper)}`);
  }
  for (const [name, value] of Object.entries(headers)) {
    if (isHeaderToSkip(name)) continue;
    lines.push(`  -H ${shellEscapeSingleQuoted(value === '' ? `${name};` : `${name}: ${value}`)}`);
  }
  if (postData) {
    lines.push(`  --data-raw ${shellEscapeSingleQuoted(postData)}`);
  }
  return lines.join(' \\\n');
}

/**
 * SPA nặng (Teams/Gmail) tải xong DOM rồi vẫn còn dựng UI thêm 1 lúc — `isVisible()` chỉ kiểm
 * tra tức thì tại thời điểm gọi (KHÔNG tự chờ/poll như `waitFor`), nên gọi ngay sau khi trang vừa
 * "domcontentloaded" gần như luôn ra false dù phần tử sắp xuất hiện. Dùng `waitFor` (có polling
 * thật) cho từng candidate, trả về candidate đầu tiên xuất hiện trong `timeoutMs`.
 */
export async function findVisibleLocator(candidates: Locator[], timeoutMs: number): Promise<Locator | null> {
  for (const candidate of candidates) {
    const found = await candidate
      .waitFor({ state: 'visible', timeout: timeoutMs })
      .then(() => true)
      .catch(() => false);
    if (found) return candidate;
  }
  return null;
}

/**
 * Reload "cứng" (tương đương Ctrl+Shift+R — bỏ qua cache) trước khi search, theo đúng yêu cầu:
 * nghi ngờ trang dùng bản JS/token cũ trong cache khiến request bắt được không hợp lệ. Playwright
 * không có API public cho hard reload nên phải gọi thẳng lệnh CDP `Page.reload` với `ignoreCache`.
 */
export async function hardReload(page: Page): Promise<void> {
  const cdpSession = await page.context().newCDPSession(page);
  try {
    await cdpSession.send('Page.reload', { ignoreCache: true });
    await page.waitForLoadState('domcontentloaded');
  } finally {
    await cdpSession.detach().catch(() => {});
  }
}
