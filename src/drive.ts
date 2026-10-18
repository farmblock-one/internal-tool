import fs from 'node:fs';
import path from 'node:path';
import { google } from 'googleapis';
import { config } from './config.js';
import { logger } from './logger.js';

/**
 * Upload file lên Google Drive bằng service account.
 *
 * Setup (1 lần):
 *   1. Tạo project trên https://console.cloud.google.com/, bật "Google Drive API".
 *   2. Tạo Service Account -> tải file JSON key -> lưu vào GOOGLE_SERVICE_ACCOUNT_KEY (.env).
 *   3. QUAN TRỌNG: Service Account KHÔNG có dung lượng lưu trữ riêng (Google chặn hẳn, báo lỗi
 *      403 storageQuotaExceeded nếu dùng folder Drive thường/My Drive) — folder đích BẮT BUỘC
 *      phải nằm trong 1 Shared Drive (Drive dùng chung), vì Shared Drive dùng dung lượng chung
 *      của tổ chức chứ không phải của riêng Service Account.
 *      Tạo/mở 1 Shared Drive -> thêm email Service Account (dạng xxx@xxx.iam.gserviceaccount.com,
 *      xem trong file JSON key) làm thành viên với quyền tối thiểu "Content manager".
 *   4. Copy ID của folder (trong Shared Drive đó) từ URL (drive.google.com/drive/folders/<ID>)
 *      vào GDRIVE_SAFE_TO_SEND_FOLDER_ID (.env).
 */
export async function uploadToDrive(filePath: string, folderId: string): Promise<string> {
  const auth = new google.auth.GoogleAuth({
    keyFile: config.googleServiceAccountKey,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });
  const drive = google.drive({ version: 'v3', auth });

  const res = await drive.files.create({
    requestBody: {
      name: path.basename(filePath),
      parents: [folderId],
    },
    media: {
      // File cuối luôn là .xlsx (xem buildOutputXlsxPath) — trước đây để nhầm 'text/csv' do hàm
      // này viết từ sớm, lúc đó còn tách ra file CSV riêng; giờ phải đúng mimetype Excel.
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      body: fs.createReadStream(filePath),
    },
    // Bắt buộc phải có để API cho phép thao tác trên file/folder nằm trong Shared Drive — thiếu
    // cờ này thì dù folder đã đúng là Shared Drive, request vẫn bị từ chối.
    supportsAllDrives: true,
    fields: 'id, webViewLink',
  });

  logger.info(`Đã upload lên Google Drive: ${res.data.webViewLink}`);
  return res.data.id as string;
}

/**
 * Upload file Excel CUỐI CÙNG (đã ghép đủ kết quả Risky, cột RESULT đã là "Safe to Send"/"Do not
 * Send") lên đúng folder Drive đã cấu hình — gọi ngay sau khi ghép xong (xem `maybeMergeJob` trong
 * telegram-watcher.ts và merge-risky.ts). Tự bỏ qua (không làm gì, không throw) nếu chưa cấu hình
 * GDRIVE_SAFE_TO_SEND_FOLDER_ID — tính năng này KHÔNG bắt buộc để phần còn lại hoạt động.
 */
export async function uploadFinalXlsxToDrive(filePath: string): Promise<void> {
  if (!config.gdriveSafeToSendFolderId) {
    logger.info('Chưa cấu hình GDRIVE_SAFE_TO_SEND_FOLDER_ID — bỏ qua bước upload file Excel cuối lên Google Drive.');
    return;
  }
  await uploadToDrive(filePath, config.gdriveSafeToSendFolderId);
}
