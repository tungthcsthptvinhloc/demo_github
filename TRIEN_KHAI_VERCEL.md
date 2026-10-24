# Đưa ứng dụng lên GitHub và Vercel

Ứng dụng gồm ba phần, đều dùng gói miễn phí:

| Phần | Vai trò |
|---|---|
| **GitHub** | Lưu mã nguồn |
| **Vercel** | Chạy ứng dụng, cấp địa chỉ `https://...vercel.app` |
| **Neon Postgres** + **Vercel Blob** (bật ngay trong Vercel) | Lưu dữ liệu và ảnh/file bài nộp |

---

## Phần A. Đưa mã lên GitHub (tải lên bằng trình duyệt)

1. Đăng nhập **github.com** → bấm **+** (góc trên phải) → **New repository**.
   - *Repository name*: `quan-ly-nhiem-vu-hsg`
   - Chọn **Private** (chỉ thầy/cô xem được mã).
   - **Không** tích *Add a README*, *.gitignore* hay *license*.
   - Bấm **Create repository**.
2. Ở trang kho vừa tạo, bấm liên kết **uploading an existing file**.
3. Mở thư mục **`_dua-len-github`** (nằm trong thư mục ứng dụng), bấm **Ctrl+A** để chọn **tất cả** file và thư mục bên trong,
   rồi **kéo thả** vào vùng *Drag files here* trên trình duyệt.
   - Phải kéo **nội dung bên trong** thư mục, không kéo chính thư mục `_dua-len-github`.
   - Đợi thanh tải lên chạy xong.
4. Ở ô *Commit changes* phía dưới, bấm **Commit changes**.
5. Kiểm tra trang kho có đủ: `api`, `lib`, `public`, `scripts`, `.gitignore`, `dev-server.js`, `package.json`, `package-lock.json`, `vercel.json`, `HUONG_DAN.md`, `TRIEN_KHAI_VERCEL.md`.

> Thư mục `node_modules` và `data` **không** được đưa lên (thư mục `data` chứa dữ liệu học sinh của bản chạy LAN).

---

## Phần B. Kết nối Vercel

### B1. Nhập dự án từ GitHub

1. Đăng nhập **vercel.com** → **Add New… → Project**.
2. Ở mục *Import Git Repository*, tìm `quan-ly-nhiem-vu-hsg` → **Import**.
   - Nếu không thấy kho: bấm **Adjust GitHub App Permissions** và cấp quyền cho kho này.
3. Ở trang cấu hình:
   - *Framework Preset*: để **Other** (đã khai báo sẵn trong `vercel.json`). Không sửa *Build and Output Settings*.
   - Mở **Environment Variables**, thêm một biến:
     - *Key*: `SETUP_CODE`
     - *Value*: một cụm bí mật tự đặt, ví dụ `hsg-toan-2026-xyz` (dùng một lần khi tạo tài khoản giáo viên; **không chia sẻ cho học sinh**).
4. Bấm **Deploy**. Lần chạy này chưa có cơ sở dữ liệu nên trang web chưa dùng được, đó là bình thường.

### B2. Tạo cơ sở dữ liệu Neon Postgres

1. Vào dự án → tab **Storage** → **Create Database** → chọn **Neon** (Serverless Postgres) → **Continue**.
2. Chọn gói miễn phí, *Region* chọn **Singapore** (gần Việt Nam nhất), đặt tên tùy ý → **Create**.
3. Ở bước kết nối, chọn dự án `quan-ly-nhiem-vu-hsg`, tích đủ các môi trường (*Production, Preview, Development*) → **Connect**.

Vercel tự thêm biến `DATABASE_URL` vào dự án.

### B3. Tạo kho file Vercel Blob

1. Vẫn ở tab **Storage** → **Create Database** (hoặc **Create**) → chọn **Blob** → **Continue**.
2. Đặt tên, ví dụ `bai-nop-hsg`. Nếu được hỏi kiểu truy cập (*Access*), chọn **Public**.
3. **Connect** vào dự án `quan-ly-nhiem-vu-hsg`, tích đủ các môi trường.

Vercel tự thêm biến `BLOB_READ_WRITE_TOKEN`.

### B4. Chọn vùng máy chủ gần Neon (khuyên làm)

Dự án → **Settings → Functions** → *Function Region* chọn **Singapore (sin1)** → **Save**.
Máy chủ ứng dụng và cơ sở dữ liệu ở cùng vùng nên trang chạy nhanh hơn.

### B5. Chạy lại để nhận cấu hình mới

Tab **Deployments** → bản trên cùng → nút **⋯** → **Redeploy** → **Redeploy**.
(Biến môi trường mới chỉ có hiệu lực với lần chạy mới.)

### B6. Tạo tài khoản giáo viên

1. Bấm **Visit** (hoặc mở `https://quan-ly-nhiem-vu-hsg.vercel.app`, tên có thể khác một chút).
2. Trang **Thiết lập lần đầu** hiện ra: nhập **Mã khởi tạo** (giá trị `SETUP_CODE` ở bước B1), tên đội tuyển, họ tên, tên đăng nhập, mật khẩu.
3. Vào **Cài đặt** để xem địa chỉ gửi cho học sinh.

Từ đây, cách sử dụng xem [HUONG_DAN.md](HUONG_DAN.md).

---

## Sửa mã về sau

Khi có file mã mới (ví dụ `public/app.js`):

1. Vào kho trên GitHub, mở đúng thư mục chứa file (ví dụ `public`).
2. **Add file → Upload files**, kéo file mới vào (trùng tên sẽ ghi đè) → **Commit changes**.
3. Vercel tự chạy lại sau khoảng một phút; xem tiến độ ở tab **Deployments**.

## Khi gặp lỗi

| Hiện tượng | Nguyên nhân thường gặp |
|---|---|
| Trang báo "Lỗi máy chủ" | Chưa gắn Neon (B2) hoặc chưa Redeploy (B5). Xem chi tiết ở tab **Logs** của dự án. |
| "Chưa đặt biến môi trường SETUP_CODE" | Thêm biến ở **Settings → Environment Variables** rồi Redeploy. |
| Không tải được ảnh/file | Chưa gắn Blob (B3), kho Blob không phải *Public*, hoặc chưa Redeploy. |
| Vercel báo lỗi khi Deploy | Kiểm tra đã tải lên đủ file ở bước A5, nhất là `package.json`, `package-lock.json`, `vercel.json` và thư mục `api`. |
