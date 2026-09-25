import 'dotenv/config';

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Thiếu biến môi trường ${name} trong file .env`);
  return value;
}

export const config = {
  chromeUserDataDir: process.env.CHROME_USER_DATA_DIR ?? './.chrome-profile',
  headless: process.env.HEADLESS === 'true',
  get debounceApiKey(): string {
    return required('DEBOUNCE_API_KEY', process.env.DEBOUNCE_API_KEY);
  },
  googleServiceAccountKey: process.env.GOOGLE_SERVICE_ACCOUNT_KEY ?? './service-account.json',
  get gdriveSafeToSendFolderId(): string {
    return required('GDRIVE_SAFE_TO_SEND_FOLDER_ID', process.env.GDRIVE_SAFE_TO_SEND_FOLDER_ID);
  },
  // IP/domain công khai của server này — dùng để tạo URL host tạm file CSV cho Debounce tải về.
  get publicHost(): string {
    return required('PUBLIC_HOST', process.env.PUBLIC_HOST);
  },
  fileServePort: Number(process.env.FILE_SERVE_PORT ?? '8443'),
};
