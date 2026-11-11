/* Dùng chung cho api/data.js và api/zalo.js: đọc / ghi file dữ liệu trong Private Blob.
   Vì sao có file này: etag lấy bằng get() có thể có dạng yếu W/"…" (qua CDN), còn put(ifMatch) so sánh nghiêm ngặt
   → ghi bị từ chối (409) mãi mãi. Ở đây ta so sánh etag đã bỏ "W/" rồi mới ghi. */
import { get, put, head, BlobPreconditionFailedError } from '@vercel/blob';

export const PATH = 'leantodo/data.json';
export const norm = (e) => String(e || '').replace(/^W\//, '');
const isConflict = (e) => e instanceof BlobPreconditionFailedError || /already exists|precondition/i.test(String(e && e.message));
const OPTS = { access: 'private', contentType: 'application/json', addRandomSuffix: false };

/* Luôn đọc bản mới nhất (useCache:false) để không thấy bản cũ tới 60 giây. */
export async function readLatest(ifNoneMatch) {
  const r = await get(PATH, { access: 'private', useCache: false, ...(ifNoneMatch ? { ifNoneMatch } : {}) });
  if (!r) return { empty: true };
  if (r.statusCode === 304) return { notModified: true, etag: r.blob.etag };
  const text = await new Response(r.stream).text();
  return { data: JSON.parse(text), etag: r.blob.etag };
}

/* Ghi nếu server vẫn đang giữ đúng bản có etag = expected (null = file chưa tồn tại).
   Trả { ok:true, etag } hoặc { ok:false } (máy khác vừa ghi → người gọi đọc lại và gộp). */
export async function writeIfUnchanged(payload, expected) {
  const fresh = async (extra) => {
    const out = await put(PATH, payload, { ...OPTS, ...extra });
    return { ok: true, etag: out.etag || (await head(PATH)).etag };
  };
  if (!expected) {
    try { return await fresh({ allowOverwrite: false }); } catch (e) { if (isConflict(e)) return { ok: false }; throw e; }
  }
  let cur = null;
  try { cur = await head(PATH); } catch (_) { cur = null; }
  if (!cur || norm(cur.etag) !== norm(expected)) return { ok: false };      // bản trên server đã đổi
  try {
    return await fresh({ allowOverwrite: true, ifMatch: cur.etag });
  } catch (e) {
    if (!isConflict(e)) throw e;
    let again = null;
    try { again = await head(PATH); } catch (_) { again = null; }
    if (!again || norm(again.etag) !== norm(expected)) return { ok: false };  // thật sự có người ghi chen vào
    /* Bản không đổi mà vẫn bị từ chối = lỗi định dạng etag, không phải tranh chấp → ghi không điều kiện để không kẹt */
    console.warn('ifMatch bị từ chối dù etag khớp — ghi không điều kiện');
    return await fresh({ allowOverwrite: true });
  }
}
