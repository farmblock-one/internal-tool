import type { Locator, Page } from 'playwright';

/** Escape 1 giá trị để đặt an toàn trong dấu nháy đơn của lệnh bash (kiểu Chrome DevTools làm). */
function shellEscapeSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// LƯU Ý QUAN TRỌNG (đã sửa lại sau khi so sánh với cURL mẫu thật của GMAIL): trước đây tưởng Chrome
// DevTools "Copy as cURL" luôn xoá 1 danh sách cố định các header (cookie, origin, sec-fetch-*,
// sec-ch-ua*, accept-language, priority...) ở MỌI trang — kết luận này rút ra từ so sánh với cURL
// mẫu của TEAMS, nơi các header đó không xuất hiện. Nhưng hoá ra Teams đơn giản là KHÔNG GỬI mấy
// header đó (xác thực thuần qua bearer/x-skypetoken, không cần cookie) nên lúc đó có lọc hay không
// cũng không khác gì — không phải Chrome chủ động xoá. cURL mẫu thật của GMAIL thì CÓ đầy đủ
// cookie, origin, sec-fetch-*, sec-ch-ua*, accept-language, priority (cookie đặc biệt quan trọng
// vì cơ chế xác thực SAPISIDHASH của Google được tính từ giá trị cookie SAPISID). Vậy quy tắc đúng
// là: KHÔNG đoán header nào trình duyệt "ẩn", gửi lại NGUYÊN VĂN mọi header capture được — chỉ bỏ
// những gì chắc chắn làm cURL replay sai/thừa.
const HEADERS_INVALID_FOR_CURL_REPLAY = new Set([
  // curl tự tính lại content-length từ --data-raw; giữ giá trị capture được (của body gốc) có thể
  // sai lệch nếu máy chủ validate đúng độ dài.
  'content-length',
  // host suy ra thẳng từ --url, không cần/không nên khai tay.
  'host',
  // Không có cURL mẫu thật nào (cả Teams lẫn Gmail) có header này hay cờ --compressed — để curl tự
  // thương lượng encoding thay vì khai cứng 1 giá trị capture được.
  'accept-encoding',
]);

/**
 * Header giả (pseudo-header, HTTP/2) bắt đầu bằng ":" không hợp lệ trong cú pháp `curl -H`, và vài
 * header khác (xem HEADERS_INVALID_FOR_CURL_REPLAY) nên bỏ vì replay lại nguyên văn sẽ sai/thừa.
 */
function isHeaderToSkip(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith(':') || HEADERS_INVALID_FOR_CURL_REPLAY.has(lower);
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
    // cURL mẫu thật dùng cờ riêng `-b '<cookie>'` cho cookie, không phải `-H 'cookie: ...'` — dù
    // về MẶT KỸ THUẬT 2 cách đều gửi cùng 1 header Cookie, vẫn khớp đúng định dạng để chắc chắn
    // (phòng trường hợp bên nhận cURL tự parse text tìm cờ `-b` cụ thể thay vì đọc mọi `-H`).
    if (name.toLowerCase() === 'cookie') {
      lines.push(`  -b ${shellEscapeSingleQuoted(value)}`);
      continue;
    }
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
