import type { BrowserContext, Locator, Page, Request } from 'playwright';
import { logger } from './logger.js';

const SEARCH_USERS_URL_PATTERN = /searchUsers/i;

/** Escape 1 giá trị để đặt an toàn trong dấu nháy đơn của lệnh bash (kiểu Chrome DevTools làm). */
function shellEscapeSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Header giả (pseudo-header, HTTP/2) bắt đầu bằng ":" không hợp lệ trong cú pháp `curl -H`, và
 * "content-length"/"host" nên để curl tự tính/tự suy ra từ URL — copy nguyên các header này vào
 * sẽ sai hoặc thừa, giống hệt cách Chrome DevTools tự lọc khi "Copy as cURL".
 */
function isHeaderToSkip(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith(':') || lower === 'content-length' || lower === 'host';
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
function buildCurlCommand(url: string, method: string, headers: Record<string, string>, postData: string | null): string {
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
 * Teams là SPA nặng, tải xong DOM rồi vẫn còn dựng UI thêm 1 lúc — `isVisible()` chỉ kiểm tra
 * tức thì tại thời điểm gọi (KHÔNG tự chờ/poll như `waitFor`), nên gọi ngay sau khi trang vừa
 * "domcontentloaded" gần như luôn ra false dù phần tử sắp xuất hiện. Dùng `waitFor` (có polling
 * thật) cho từng candidate, trả về candidate đầu tiên xuất hiện trong `timeoutMs`.
 */
async function findVisibleLocator(candidates: Locator[], timeoutMs: number): Promise<Locator | null> {
  for (const candidate of candidates) {
    const found = await candidate
      .waitFor({ state: 'visible', timeout: timeoutMs })
      .then(() => true)
      .catch(() => false);
    if (found) return candidate;
  }
  return null;
}

/** Chờ "cho có" — Teams là SPA, mạng gần như không bao giờ thực sự "idle". */
async function softWaitNetworkIdle(page: Page, timeout = 8000): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout }).catch(() => {});
}

/**
 * Mở Teams, search 1 email bất kỳ để trigger request tới "searchUsers", bắt lại request đó
 * (URL + method + toàn bộ header, gồm cả cookie/authorization) rồi dựng thành 1 lệnh cURL —
 * dùng để dán vào form upload của meetscript.io (form đó cần đúng session Teams còn hiệu lực).
 */
export async function fetchTeamsSearchCurl(
  context: BrowserContext,
  downloadDir: string,
  probeEmail = 'thanh@nscsoftware.com',
): Promise<string> {
  const page = await context.newPage();
  try {
    const requestPromise: Promise<Request> = page.waitForRequest(SEARCH_USERS_URL_PATTERN, { timeout: 30_000 });
    // Gắn ngay 1 catch rỗng để Node không coi promise này là "unhandled rejection" nếu nó
    // timeout SỚM hơn lúc mình thật sự `await` nó ở dưới (vd khi ô search chưa tìm thấy và các
    // bước phía trên đang chờ riêng) — Node mặc định CRASH cả tiến trình khi gặp unhandled
    // rejection, nuốt luôn thông báo lỗi thật (đã xảy ra đúng vậy ở lần chạy trước).
    requestPromise.catch(() => {});

    await page.goto('https://teams.live.com/v2/', { waitUntil: 'domcontentloaded' });
    await softWaitNetworkIdle(page);

    // Đây là 1 ô input DUY NHẤT nhưng placeholder tự đổi chữ sau khi bấm vào — lúc đầu placeholder
    // chung chung (khớp /search/i), sau khi click mới đổi thành "Look for people, messages, files
    // and more". Playwright tìm lại phần tử theo ĐÚNG tiêu chí selector mỗi lần thao tác, nên nếu
    // fill() dùng lại locator cũ (theo placeholder ban đầu) thì sau khi placeholder đổi, nó không
    // còn khớp gì nữa và bị treo. Phải bấm mở bằng 1 lượt tìm, rồi TÌM LẠI theo placeholder mới
    // trước khi gõ chữ.
    const initialTrigger = await findVisibleLocator(
      [
        page.getByPlaceholder(/search/i).first(),
        page.getByRole('searchbox').first(),
        page.locator('[aria-label*="search" i]').first(),
        page.locator('input[type="search"]').first(),
      ],
      10_000,
    );
    if (!initialTrigger) {
      throw new Error('Không tìm thấy ô/nút search ban đầu trên Teams (đã thử placeholder/role/aria-label/input).');
    }
    await initialTrigger.click();

    const expandedSearchBox = await findVisibleLocator(
      [page.getByPlaceholder(/look for people/i).first(), page.getByPlaceholder(/search/i).first()],
      10_000,
    );
    if (!expandedSearchBox) {
      throw new Error('Bấm mở ô search xong nhưng không tìm lại được ô để gõ chữ (placeholder đổi khác dự kiến).');
    }
    await expandedSearchBox.fill(probeEmail);

    const request = await requestPromise;
    const headers = await request.allHeaders();
    const postData = request.postData();
    const curl = buildCurlCommand(request.url(), request.method(), headers, postData);
    logger.info(
      `Đã bắt được request "searchUsers" từ Teams (${request.method()} ${request.url().slice(0, 80)}..., ` +
        `body: ${postData ? `${postData.length} ký tự` : '(không có)'}).`,
    );
    return curl;
  } catch (err) {
    const debugPath = `${downloadDir}/debug-teams-${Date.now()}.png`;
    await page.screenshot({ path: debugPath, fullPage: true }).catch(() => {});
    logger.error(`Lỗi khi lấy cURL từ Teams — đã lưu ảnh debug: ${debugPath}`);
    throw err;
  } finally {
    await page.close().catch(() => {});
  }
}
