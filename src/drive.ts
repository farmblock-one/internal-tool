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
 *   3. Mở folder Drive đích trên trình duyệt -> Share -> thêm email của service account
 *      (dạng xxx@xxx.iam.gserviceaccount.com, xem trong file JSON key) với quyền Editor.
 *   4. Copy ID của folder từ URL (drive.google.com/drive/folders/<ID>) vào
 *      GDRIVE_SAFE_TO_SEND_FOLDER_ID (.env).
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
      mimeType: 'text/csv',
      body: fs.createReadStream(filePath),
    },
    fields: 'id, webViewLink',
  });

  logger.info(`Đã upload lên Google Drive: ${res.data.webViewLink}`);
  return res.data.id as string;
}
