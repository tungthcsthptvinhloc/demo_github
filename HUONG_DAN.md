# Hướng dẫn sử dụng – Quản lý nhiệm vụ học sinh giỏi

Ứng dụng chạy online trên Vercel. Giáo viên và học sinh dùng điện thoại hoặc máy tính có Internet,
mở địa chỉ dạng `https://ten-du-an.vercel.app`, không cần cài đặt gì.

Cách đưa ứng dụng lên mạng lần đầu: xem [TRIEN_KHAI_VERCEL.md](TRIEN_KHAI_VERCEL.md).

## 1. Tạo tài khoản giáo viên (một lần)

Lần đầu mở địa chỉ ứng dụng, trang **Thiết lập lần đầu** hiện ra. Nhập:

- **Mã khởi tạo**: giá trị `SETUP_CODE` thầy/cô đã đặt trên Vercel.
- Tên đội tuyển, họ tên, tên đăng nhập và mật khẩu của giáo viên.

Sau khi đã có tài khoản giáo viên, trang này không mở được nữa.

## 2. Tạo tài khoản học sinh

Vào **Học sinh**:

- **+ Thêm học sinh**: nhập từng em.
- **Nhập danh sách từ Excel**: trong Excel, bôi đen hai cột *Họ và tên* và *Lớp* (có thể kèm cột STT), bấm Ctrl+C, dán vào ô rồi bấm *Tạo tài khoản*.

Ứng dụng tự tạo tên đăng nhập (ví dụ *Nguyễn Văn An* → `annv`) và mật khẩu 6 chữ số.
**Mật khẩu chỉ hiển thị một lần**: hãy bấm **In** hoặc **Sao chép (dán vào Excel)** để phát cho học sinh, kèm địa chỉ ứng dụng.
Khi đăng nhập lần đầu, học sinh phải đổi sang mật khẩu riêng.

Các thao tác khác với từng em:

- **Đặt lại MK**: khi học sinh quên mật khẩu, ứng dụng tạo mật khẩu mới.
- **Khóa**: tạm ngừng tài khoản, vẫn giữ toàn bộ bài nộp.
- **Xóa**: xóa vĩnh viễn học sinh cùng bài nộp.

## 3. Giao nhiệm vụ

**Nhiệm vụ → + Giao nhiệm vụ mới**:

- **Tên nhiệm vụ** và **nội dung/yêu cầu**. Công thức toán viết theo LaTeX: `$x^2+\sqrt{y}$` (cùng dòng) hoặc `$$\int_0^1 f(x)\,dx$$` (dòng riêng). Ô *xem trước* bên dưới hiển thị kết quả.
- **Hạn nộp** (không bắt buộc). Sau hạn, học sinh vẫn nộp được nhưng bài bị đánh dấu **Nộp muộn**.
- **Giao cho**: *Cả đội* (gồm cả học sinh thêm sau này) hoặc *Chọn học sinh*.
- **File đề / tài liệu**: PDF, Word, ảnh... tối đa 10 file, mỗi file không quá 10 MB.

## 4. Theo dõi trạng thái

| Trạng thái | Ý nghĩa |
|---|---|
| **Chưa xem** | Học sinh chưa mở nhiệm vụ |
| **Đã xem – chưa làm** | Đã mở xem đề (ghi lại tự động, kèm thời điểm và số lần xem) nhưng chưa nộp |
| **Đã nộp** | Đã nộp bài, chờ giáo viên chấm |
| **Đã chấm** | Giáo viên đã chấm điểm/nhận xét |
| **Cần làm lại** | Giáo viên trả bài, học sinh phải nộp lại |
| *Quá hạn* | Hết hạn mà chưa nộp |
| *Nộp muộn* | Nộp sau hạn |

- **Nhiệm vụ**: thanh tiến độ của từng nhiệm vụ. Bấm vào một nhiệm vụ để xem danh sách học sinh và lọc theo trạng thái.
- **Tổng hợp**: bảng *học sinh × nhiệm vụ*, bấm vào một ô để mở bài của em đó.
- **⬇ Xuất Excel**: tải file Excel gồm hai trang: *Tổng hợp* (bảng màu) và *Chi tiết* (thời điểm xem, nộp, điểm, nhận xét).

## 5. Chấm bài

Bấm vào tên học sinh có bài nộp:

- Xem bài làm (chữ, ảnh, file). Nếu học sinh nộp nhiều lần, các lần trước nằm trong mục *Xem các lần nộp trước*.
- Nhập **Điểm** (có thể để trống) và **Nhận xét**, rồi bấm **✓ Lưu chấm điểm**. Sau khi chấm, học sinh không nộp lại được nữa.
- Hoặc bấm **↺ Yêu cầu làm lại** (bắt buộc ghi nhận xét): học sinh thấy nhận xét và phải nộp bài mới.
- Nút **Bài chờ chấm tiếp theo** chuyển nhanh sang em kế tiếp đang chờ chấm.

## 6. Phía học sinh

- Trang chính chia thành ba nhóm: **Cần làm**, **Đã nộp – chờ chấm** và **Đã chấm**.
- Mở nhiệm vụ để xem đề và tải file đề.
- **Nộp bài**: gõ bài làm và/hoặc bấm **📷 Chụp / chọn ảnh** để chụp bài làm trên giấy. Ảnh được tự động nén cho nhẹ rồi tải thẳng lên kho lưu trữ.
- Học sinh nộp lại được khi giáo viên chưa chấm.

## 7. Dữ liệu và quyền riêng tư

- Tài khoản, nhiệm vụ, trạng thái, điểm: lưu trên **Neon Postgres**.
- Ảnh và file: lưu trên **Vercel Blob**. Mỗi file có đường dẫn ngẫu nhiên, rất khó đoán; ứng dụng chỉ cho người có quyền (giáo viên, học sinh được giao, chủ bài nộp) thấy đường dẫn đó.
- Nên **xuất Excel định kỳ** để lưu giữ kết quả.

## 8. Khắc phục sự cố

| Hiện tượng | Cách xử lý |
|---|---|
| Học sinh quên mật khẩu | **Học sinh → Đặt lại MK**. |
| Báo "Đăng nhập sai quá nhiều lần" | Chờ 10 phút, hoặc giáo viên đặt lại mật khẩu cho em đó. |
| Không tải được ảnh/file | Kiểm tra mạng; mỗi file tối đa 10 MB. Nếu mọi file đều lỗi, kiểm tra kho Blob trên Vercel đã gắn vào dự án và đã *Redeploy* (xem TRIEN_KHAI_VERCEL.md). |
| Trang báo "Lỗi máy chủ" | Vào Vercel → dự án → **Logs** để xem lỗi; thường do chưa gắn Neon hoặc chưa Redeploy sau khi gắn. |

## 9. Dành cho người sửa mã

- `lib/app.js`: toàn bộ API (Express). `lib/db.js`: lớp CSDL. `lib/storage.js`: lưu file.
- `public/`: giao diện (HTML/CSS/JS thuần, không cần build).
- Chạy thử trên máy: `npm install` rồi `npm run dev` → `http://localhost:3000`. Khi không có `DATABASE_URL` / `BLOB_READ_WRITE_TOKEN`, ứng dụng dùng Postgres nhúng (PGlite) và lưu file trong thư mục `.devdata`.
- Nâng cấp thư viện `@vercel/blob`: chạy `npm run build:blob` để đóng gói lại `public/vendor/vercel-blob-client.js`.
