import { diffTasks, notifyLines } from './_zalo.js';
import { readLatest, writeIfUnchanged } from './_blob.js';

/* Toàn bộ dữ liệu nằm trong MỘT file JSON trong Private Blob (xem _blob.js). */
const MAX_BYTES = 512 * 1024;
const MAX_TASKS = 3000;

function validate(data) {
  if (!data || typeof data !== 'object') return false;
  if (!data.tasks || typeof data.tasks !== 'object' || Array.isArray(data.tasks)) return false;
  if (!Array.isArray(data.p)) return false;
  if (Object.keys(data.tasks).length > MAX_TASKS) return false;
  return true;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    /* ---------- ĐỌC ---------- */
    if (req.method === 'GET') {
      const etag = typeof req.query.etag === 'string' ? req.query.etag : '';
      const r = await readLatest(etag);
      if (r.empty) return res.status(200).json({ data: null, etag: null });
      if (r.notModified) return res.status(200).json({ notModified: true, etag: r.etag });
      return res.status(200).json({ data: r.data, etag: r.etag });
    }

    /* ---------- GHI (có điều kiện theo ETag) ---------- */
    if (req.method === 'PUT') {
      let body = req.body;
      if (typeof body === 'string') body = JSON.parse(body);
      const { data, etag } = body || {};
      if (!validate(data)) return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });
      const payload = JSON.stringify(data);
      if (Buffer.byteLength(payload) > MAX_BYTES) return res.status(413).json({ error: 'Dữ liệu quá lớn' });

      /* Báo Zalo: lấy bản đang có trên server để so sánh (chỉ khi đã đặt ZALO_NOTIFY_KEY và đây không phải lần ghi đầu tiên) */
      let before = null;
      if (process.env.ZALO_NOTIFY_KEY && etag) {
        try { const cur = await readLatest(); before = cur.data && cur.data.tasks ? cur.data : null; } catch (_) { before = null; }
      }
      const w = await writeIfUnchanged(payload, etag || null);
      if (!w.ok) {
        /* Máy khác vừa ghi: trả bản mới nhất để client tự gộp rồi ghi lại. */
        const cur = await readLatest();
        return res.status(409).json({ data: cur.data || null, etag: cur.etag || null });
      }
      /* Ghi xong mới báo (không bao giờ làm hỏng việc lưu) */
      if (before) { try { await notifyLines(diffTasks(before.tasks, data.tasks)); } catch (_) {} }
      return res.status(200).json({ etag: w.etag });
    }

    res.setHeader('Allow', 'GET, PUT');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Lỗi máy chủ' });
  }
}
