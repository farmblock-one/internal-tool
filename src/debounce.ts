import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';

/**
 * ⚠️ CẦN XÁC MINH LẠI TRƯỚC KHI DÙNG THẬT:
 * Môi trường sandbox hiện tại chặn truy cập ra debounce.io / debounce.com nên mình KHÔNG
 * fetch được tài liệu API chính xác 100%. Các endpoint dưới đây dựa trên thông tin công khai
 * (bulk.debounce.io, phản hồi có list_id) tìm được qua tìm kiếm — HÃY đối chiếu lại với tài
 * liệu chính thức tại https://developers.debounce.com/reference trước khi chạy thật, và sửa
 * 3 hằng số + field JSON bên dưới nếu khác.
 *
 * Nếu API không khớp, phương án B là tự động hoá qua giao diện web app.debounce.io bằng
 * Playwright (upload file, chờ xử lý, bấm download) — nói mình biết nếu cần chuyển sang cách đó.
 */
const BULK_UPLOAD_URL = 'https://bulk.debounce.io/v1/';
const BULK_STATUS_URL = 'https://bulk.debounce.io/v1/';

interface UploadResponse {
  list_id: string;
}

interface StatusResponse {
  status: string;
  download_url?: string;
}

export async function verifyListViaApi(csvFilePath: string, outputDir: string): Promise<string> {
  const apiKey = config.debounceApiKey;

  // 1. Upload file lên Debounce để bắt đầu job verify
  const fileBuffer = fs.readFileSync(csvFilePath);
  const form = new FormData();
  form.append('api', apiKey);
  form.append('file', new Blob([fileBuffer]), path.basename(csvFilePath));

  const uploadRes = await fetch(BULK_UPLOAD_URL, { method: 'POST', body: form });
  if (!uploadRes.ok) {
    throw new Error(`Debounce upload thất bại: ${uploadRes.status} ${await uploadRes.text()}`);
  }
  const uploadJson = (await uploadRes.json()) as UploadResponse;
  const listId = uploadJson.list_id;
  if (!listId) {
    throw new Error(`Debounce không trả về list_id, response thực tế: ${JSON.stringify(uploadJson)}`);
  }
  logger.info(`Đã upload lên Debounce, list_id=${listId}. Đang chờ xử lý...`);

  // 2. Poll trạng thái tới khi xử lý xong (tối đa 30 phút)
  let status = '';
  let resultUrl = '';
  const deadline = Date.now() + 30 * 60_000;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    const statusRes = await fetch(`${BULK_STATUS_URL}?api=${apiKey}&list_id=${listId}`);
    const statusJson = (await statusRes.json()) as StatusResponse;
    status = statusJson.status ?? '';
    logger.info(`Trạng thái Debounce: ${status}`);
    if (status.toLowerCase() === 'complete') {
      resultUrl = statusJson.download_url ?? '';
      break;
    }
  }

  if (status.toLowerCase() !== 'complete') {
    throw new Error('Debounce xử lý quá 30 phút hoặc trạng thái không rõ — kiểm tra thủ công tại app.debounce.io.');
  }
  if (!resultUrl) {
    throw new Error('Debounce báo "complete" nhưng không có download_url — kiểm tra lại field response thực tế và sửa code.');
  }

  // 3. Tải file kết quả (đã có thêm cột RESULT)
  const resultRes = await fetch(resultUrl);
  const resultBuffer = Buffer.from(await resultRes.arrayBuffer());
  const outPath = path.join(outputDir, `debounce-result-${Date.now()}.csv`);
  fs.writeFileSync(outPath, resultBuffer);
  logger.info(`Đã tải kết quả Debounce về: ${outPath}`);
  return outPath;
}
