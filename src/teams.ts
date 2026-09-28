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

/** Dựng lại 1 request Playwright thành lệnh cURL (bash) — tương đương "Copy as cURL (bash)" của Chrome DevTools. */
function buildCurlCommand(url: string, method: string, headers: Record<string, string>): string {
  const lines = [`curl ${shellEscapeSingleQuoted(url)}`];
  if (method.toUpperCase() !== 'GET') {
    lines.push(`  -X ${shellEscapeSingleQuoted(method.toUpperCase())}`);
  }
  for (const [name, value] of Object.entries(headers)) {
    if (isHeaderToSkip(name)) continue;
    lines.push(`  -H ${shellEscapeSingleQuoted(`${name}: ${value}`)}`);
  }
  lines.push('  --compressed');
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
  probeEmail = 'test@example.com',
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

    // Chưa chắc đúng selector ô tìm kiếm thật của Teams (chỉ đoán từ ảnh chụp màn hình kết quả
    // tìm kiếm, chưa thấy màn hình TRƯỚC khi search) — thử vài cách nhận diện phổ biến, mỗi cách
    // có chờ (poll) thật sự chứ không check tức thì.
    const searchBox = await findVisibleLocator(
      [
        page.getByPlaceholder(/search/i).first(),
        page.getByRole('searchbox').first(),
        page.locator('[aria-label*="search" i]').first(),
        page.locator('input[type="search"]').first(),
        page.locator('input[type="text"]').first(),
      ],
      10_000,
    );
    if (!searchBox) {
      throw new Error('Không tìm thấy ô tìm kiếm trên Teams (đã thử placeholder/role/aria-label/input).');
    }
    await searchBox.click();
    await searchBox.fill(probeEmail);

    const request = await requestPromise;
    const headers = await request.allHeaders();
    const curl = buildCurlCommand(request.url(), request.method(), headers);
    logger.info(`Đã bắt được request "searchUsers" từ Teams (${request.method()} ${request.url().slice(0, 80)}...).`);
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
