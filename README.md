# Lean To Do – đồng bộ nhiều thiết bị

Giao diện và chức năng giữ nguyên như bản gốc. Dữ liệu nay nằm trên **Vercel Blob (Private)**, mọi thiết bị mở cùng một link sẽ thấy và sửa chung một danh sách.

## Cấu trúc repo

```
index.html      giao diện (như cũ, đã thêm lớp đồng bộ)
api/data.js     Vercel Function: đọc/ghi file JSON trong Private Blob
package.json    khai báo @vercel/blob
.gitignore
```

## Triển khai (làm đúng thứ tự)

1. **Đưa code lên GitHub**: tạo repo mới, đẩy cả 4 file trên lên nhánh `main` (giữ `api/data.js` nằm trong thư mục `api`).
2. **Import vào Vercel**: Vercel → *Add New… → Project* → chọn repo. Framework Preset để **Other**, không cần Build Command. Bấm *Deploy*.
3. **Tạo Blob store**: trong project → tab **Storage** → *Create Database* → **Blob** → chọn chế độ truy cập **Private** → *Connect to Project* (chọn đủ Production/Preview/Development).
   Vercel tự thêm biến `BLOB_READ_WRITE_TOKEN`.
4. **Deploy lại** để biến môi trường có hiệu lực: *Deployments* → bản mới nhất → *Redeploy*.
5. Mở link `https://<tên-project>.vercel.app` trên điện thoại và máy tính để thử.

> Store phải là **Private**. Nếu lỡ tạo Public, hãy tạo store Private mới và nối lại vào project.

## Dữ liệu cũ trên máy

Lần đầu mở bản mới, app tự chuyển dữ liệu cũ (`leantodo.v1` trong localStorage **của đúng tên miền đó**) sang định dạng mới và đẩy lên server nếu server còn trống. Lưu ý localStorage gắn theo tên miền: dữ liệu bạn đang có ở file mở trực tiếp / domain khác sẽ không tự sang domain Vercel. Muốn mang sang, hãy mở bản mới trên cùng tên miền với bản cũ, hoặc nhập lại tay.

## Cách đồng bộ hoạt động

- **localStorage** là bản lưu tạm: mở app là có dữ liệu ngay, mất mạng vẫn dùng bình thường; khi có mạng lại tự đẩy lên.
- Đồng bộ **khi mở app, khi quay lại tab/ứng dụng** (cách nhau tối thiểu 15 giây) và **sau mỗi thay đổi** (các thay đổi liên tiếp trong ~1,5 giây gộp thành 1 lần ghi). Không có polling nền.
- Mỗi việc có mốc thời gian riêng cho **nội dung** (tên, người, giờ) và cho **vị trí** (vùng, thứ tự). Hai máy sửa cùng lúc: mốc mới hơn thắng theo từng nhóm, nên đổi tên ở máy này và kéo sang vùng khác ở máy kia đều được giữ.
- Xóa việc để lại **dấu xóa** (tự dọn sau 30 ngày) để máy khác biết mà xóa theo.
- Ghi có điều kiện bằng **ETag (`ifMatch`)**: nếu máy khác vừa ghi, server trả bản mới nhất, app tự gộp rồi ghi lại.
- Quy tắc **tối đa 5 việc ở "Tự làm"** được áp lại sau mỗi lần gộp; việc dư chuyển sang "Giám sát".
- Server đọc với `useCache: false` nên không bị thấy bản cũ tới 60 giây.
- Khi đang kéo thả hoặc mở form sửa, dữ liệu từ máy khác được chờ tới khi xong mới áp vào, nên không bị giật giữa chừng.

## Ước tính lượt dùng (gói Hobby: 10.000 đọc / 2.000 ghi mỗi tháng)

Mỗi lần mở/quay lại app ≈ 1 lượt đọc; mỗi cụm thay đổi ≈ 1 lượt ghi. Dùng cá nhân (vài chục lần mở và vài chục lần ghi mỗi ngày) nằm trong hạn mức.

## Lưu ý

- **Không có mật khẩu**: ai biết link đều xem và sửa được. Đừng chia sẻ link công khai. Nếu sau này cần khóa, có thể thêm một mã truy cập kiểm tra trong `api/data.js`.
- Đồng bộ dựa vào đồng hồ của từng thiết bị. Nếu giờ hệ thống của một máy lệch nhiều (vài phút trở lên), thay đổi của máy đó có thể thua/thắng nhầm khi hai máy sửa cùng một việc cùng lúc. Hãy để giờ tự động.
- Dữ liệu trên server là file `leantodo/data.json` trong Blob store, có thể xem/tải về từ tab Storage để sao lưu.
