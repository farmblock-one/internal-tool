import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';
import { servePubliclyOnOwnServer } from './file-server.js';

// Xác nhận từ tài liệu chính thức (developers.debounce.com/api-reference):
// GET /v1/upload/?api=KEY&url=<https url tới file .csv/.txt do bạn tự host>
// GET /v1/status/?api=KEY&list_id=<id>
const BULK_UPLOAD_URL = 'https://bulk.debounce.io/v1/upload/';
const BULK_STATUS_URL = 'https://bulk.debounce.io/v1/status/';

interface DebounceUploadResponse {
  debounce: { list_id: string; list_name: string };
  success: string;
}

interface DebounceStatusResponse {
  debounce: { list_id: string; status: string; percentage: number; download_link: string };
  success: string;
}

export async function verifyListViaApi(csvFilePath: string, outputDir: string): Promise<string> {
  const apiKey = config.debounceApiKey;

  // Debounce KHÔNG nhận upload trực tiếp — yêu cầu 1 URL https trỏ tới file host trên "server
  // của chính bạn" (không chấp nhận Google Drive/Dropbox...). Mở thẳng 1 HTTPS server tạm trên
  // IP của chính VM này (xem README phần PUBLIC_HOST / FILE_SERVE_PORT).
  logger.info('Đang mở server tạm thời để host file CSV công khai cho Debounce tải về...');
  const publicFile = await servePubliclyOnOwnServer(csvFilePath);

  try {
    const uploadUrl = `${BULK_UPLOAD_URL}?api=${encodeURIComponent(apiKey)}&url=${encodeURIComponent(publicFile.url)}`;
    const uploadRes = await fetch(uploadUrl);
    if (!uploadRes.ok) {
      throw new Error(`Debounce upload thất bại: ${uploadRes.status} ${await uploadRes.text()}`);
    }
    const uploadJson = (await uploadRes.json()) as DebounceUploadResponse;
    const listId = uploadJson.debounce?.list_id;
    if (!listId) {
      throw new Error(`Debounce không trả về list_id, response thực tế: ${JSON.stringify(uploadJson)}`);
    }
    logger.info(`Đã upload lên Debounce, list_id=${listId}. Đang chờ xử lý...`);

    // Poll trạng thái tới khi xử lý xong (tối đa 30 phút)
    let downloadLink = '';
    let lastStatus = '';
    const deadline = Date.now() + 30 * 60_000;

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      const statusUrl = `${BULK_STATUS_URL}?api=${encodeURIComponent(apiKey)}&list_id=${encodeURIComponent(listId)}`;
      const statusRes = await fetch(statusUrl);
      const statusJson = (await statusRes.json()) as DebounceStatusResponse;
      lastStatus = statusJson.debounce?.status ?? '';
      const percentage = statusJson.debounce?.percentage ?? 0;
      logger.info(`Trạng thái Debounce: ${lastStatus} (${percentage}%)`);

      if (lastStatus.toLowerCase() === 'completed' && statusJson.debounce?.download_link) {
        downloadLink = statusJson.debounce.download_link;
        break;
      }
    }

    if (!downloadLink) {
      throw new Error(
        `Debounce xử lý quá 30 phút hoặc chưa có download_link (trạng thái cuối: "${lastStatus}") — kiểm tra thủ công tại app.debounce.io.`,
      );
    }

    // Tải file kết quả (đã có thêm cột RESULT)
    const resultRes = await fetch(downloadLink);
    const resultBuffer = Buffer.from(await resultRes.arrayBuffer());
    const outPath = path.join(outputDir, `debounce-result-${Date.now()}.csv`);
    fs.writeFileSync(outPath, resultBuffer);
    logger.info(`Đã tải kết quả Debounce về: ${outPath}`);
    return outPath;
  } finally {
    await publicFile.close();
    logger.info('Đã đóng server tạm thời.');
  }
}
