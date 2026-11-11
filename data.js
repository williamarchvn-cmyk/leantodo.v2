import { get, put, head, BlobPreconditionFailedError } from '@vercel/blob';

/* Toàn bộ dữ liệu nằm trong MỘT file JSON trong Private Blob. */
const PATH = 'leantodo/data.json';
const MAX_BYTES = 512 * 1024;
const MAX_TASKS = 3000;

/* Luôn đọc bản mới nhất (useCache:false) để không thấy bản cũ tới 60 giây. */
async function readLatest(ifNoneMatch) {
  const r = await get(PATH, {
    access: 'private',
    useCache: false,
    ...(ifNoneMatch ? { ifNoneMatch } : {}),
  });
  if (!r) return { empty: true };
  if (r.statusCode === 304) return { notModified: true, etag: r.blob.etag };
  const text = await new Response(r.stream).text();
  return { data: JSON.parse(text), etag: r.blob.etag };
}

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

      const opts = { access: 'private', contentType: 'application/json', addRandomSuffix: false };
      try {
        const out = etag
          ? await put(PATH, payload, { ...opts, allowOverwrite: true, ifMatch: etag })
          : await put(PATH, payload, { ...opts, allowOverwrite: false });
        const newEtag = out.etag || (await head(PATH)).etag;
        return res.status(200).json({ etag: newEtag });
      } catch (e) {
        const conflict =
          e instanceof BlobPreconditionFailedError ||
          /already exists|precondition/i.test(String(e && e.message));
        if (!conflict) throw e;
        /* Máy khác vừa ghi: trả bản mới nhất để client tự gộp rồi ghi lại. */
        const cur = await readLatest();
        return res.status(409).json({ data: cur.data || null, etag: cur.etag || null });
      }
    }

    res.setHeader('Allow', 'GET, PUT');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Lỗi máy chủ' });
  }
}
