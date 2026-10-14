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
  // Mật khẩu dùng chung cho web UI (npm run web) — VM có IP công khai nên LUÔN nên đặt, nếu để
  // trống thì web UI sẽ không yêu cầu đăng nhập (chỉ hợp lý nếu firewall đã tự giới hạn truy cập).
  webuiPassword: process.env.WEBUI_PASSWORD ?? '',
  webuiPort: Number(process.env.WEBUI_PORT ?? '8090'),
  // Mặc định CHỈ lắng nghe trên localhost — đứng sau 1 reverse proxy (Caddy) lo phần HTTPS thật +
  // là cổng public duy nhất, Node không cần (và không nên) lộ trực tiếp ra ngoài Internet nữa.
  webuiHost: process.env.WEBUI_HOST ?? '127.0.0.1',
};
