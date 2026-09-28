import type { BrowserContext, Request } from 'playwright';
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
 * Mở Teams, search 1 email bất kỳ để trigger request tới "searchUsers", bắt lại request đó
 * (URL + method + toàn bộ header, gồm cả cookie/authorization) rồi dựng thành 1 lệnh cURL —
 * dùng để dán vào form upload của meetscript.io (form đó cần đúng session Teams còn hiệu lực).
 */
export async function fetchTeamsSearchCurl(context: BrowserContext, probeEmail = 'test@example.com'): Promise<string> {
  const page = await context.newPage();
  try {
    const requestPromise: Promise<Request> = page.waitForRequest(SEARCH_USERS_URL_PATTERN, { timeout: 30_000 });

    await page.goto('https://teams.live.com/v2/', { waitUntil: 'domcontentloaded' });

    const searchBox = page.getByPlaceholder(/search/i).first();
    await searchBox.waitFor({ state: 'visible', timeout: 30_000 });
    await searchBox.click();
    await searchBox.fill(probeEmail);

    const request = await requestPromise;
    const headers = await request.allHeaders();
    const curl = buildCurlCommand(request.url(), request.method(), headers);
    logger.info(`Đã bắt được request "searchUsers" từ Teams (${request.method()} ${request.url().slice(0, 80)}...).`);
    return curl;
  } finally {
    await page.close().catch(() => {});
  }
}
