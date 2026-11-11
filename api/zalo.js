import { ZONE_NAME } from './_zalo.js';
import { readLatest, writeIfUnchanged } from './_blob.js';

/* Cửa cho bot Zalo: đọc danh sách và thêm / sửa / chuyển ô / xóa việc.
   Ghi đúng "luật" của app để không làm hỏng dữ liệu khi gộp với điện thoại / máy tính:
   - mỗi việc có mốc u (nội dung) và pu (vị trí); xóa = dấu xóa z=0 (giữ 30 ngày)
   - ghi có điều kiện bằng ETag, trùng thì đọc lại làm lại
   - tối đa 5 việc ở "Tự làm" (z=1); ô: 1 = Tự làm, 3 = Giám sát, 4 = Giao việc
   Cần biến môi trường ZALO_REPORT_KEY (giống LEAN_KEY trong CONFIG của Worker). */

const MAX1 = 5;
const MAX_BYTES = 512 * 1024;
const MAX_TASKS = 3000;
const TOMB_MS = 30 * 864e5;
const ZONE_ORDER = [1, 3, 4];
const ZONE_CODE = { 1: 'tu_lam', 3: 'giam_sat', 4: 'giao_viec' };

class Fail extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

/* "Tự làm" / "tu lam" / "tu_lam" / 1 → 1 ; giám sát → 3 ; giao việc → 4 ; không hiểu → null */
function zoneOf(v) {
  if (v === 1 || v === 3 || v === 4) return v;
  const s = String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (['1', 'tulam', 'tu', 'self', 'do'].includes(s)) return 1;
  if (['3', 'giamsat', 'gs', 'monitor'].includes(s)) return 3;
  if (['4', 'giaoviec', 'gv', 'delegate'].includes(s)) return 4;
  return null;
}

/* Hạn: "2026-11-15" → 23:59 hôm đó · "2026-11-15 14:30" / "2026-11-15T14:30" · "" → bỏ hạn */
function cleanTime(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return `${s}T23:59`;
  m = /^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})/.exec(s);
  if (m) return `${m[1]}T${m[2].padStart(2, '0')}:${m[3]}`;
  throw new Fail('bad_time', `Hạn "${s}" sai định dạng (cần YYYY-MM-DD hoặc YYYY-MM-DD HH:MM)`);
}

const num = (v, d) => (Number.isFinite(v) ? v : d);
function cleanTask(t) {
  if (!t || typeof t.id !== 'string' || !t.id || typeof t.title !== 'string') return null;
  return {
    ...t,                                  /* giữ nguyên trường lạ của app (nếu có) để bot không làm rơi dữ liệu */
    id: t.id.slice(0, 40), title: t.title.slice(0, 160),
    person: typeof t.person === 'string' ? t.person.slice(0, 40) : '',
    time: typeof t.time === 'string' ? t.time.slice(0, 32) : '',
    u: num(t.u, 1), z: [0, 1, 3, 4].includes(t.z) ? t.z : 3, o: num(t.o, 0), pu: num(t.pu, 1),
  };
}
function cleanData(d) {
  const tasks = {};
  if (d && d.tasks && typeof d.tasks === 'object') for (const k in d.tasks) { const t = cleanTask(d.tasks[k]); if (t) tasks[t.id] = t; }
  const p = Array.isArray(d && d.p) ? [...new Set(d.p.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, 40)))].slice(0, 40) : [];
  const extra = d && typeof d === 'object' && !Array.isArray(d) ? d : {};
  return { ...extra, v: extra.v ?? 2, tasks, p };
}

const byO = (a, b) => a.o - b.o || (a.id < b.id ? -1 : 1);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const lastO = (db, z) => Object.values(db.tasks).filter((t) => t.z === z).reduce((m, t) => Math.max(m, t.o), 0);

/* Giống normalize() của app: quá 5 việc ở Tự làm thì phần dư (xếp sau) sang Giám sát */
function normalize(db) {
  const l1 = Object.values(db.tasks).filter((t) => t.z === 1).sort(byO);
  if (l1.length <= MAX1) return;
  let tail = lastO(db, 3);
  l1.slice(MAX1).forEach((t) => { t.z = 3; t.pu += 1; t.o = ++tail; });
}
function compact(db) {
  const lim = Date.now() - TOMB_MS;
  for (const id in db.tasks) { const t = db.tasks[id]; if (t.z === 0 && t.pu < lim) delete db.tasks[id]; }
}
function rememberPerson(db, name) {
  const n = String(name || '').trim();
  if (!n) return;
  db.p = [n, ...db.p.filter((x) => x.toLowerCase() !== n.toLowerCase())].slice(0, 40);
}

/* ---------- Blob (xem _blob.js) ---------- */
/* Đọc → sửa trong bộ nhớ → ghi có điều kiện ETag. Trùng (máy khác vừa ghi) thì đọc lại và làm lại, tối đa 4 lần. */
async function mutate(fn) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const cur = await readLatest();
    const db = cleanData(cur.empty ? null : cur.data);
    const out = fn(db);                 // ném Fail nếu không làm được
    compact(db); normalize(db);
    if (Object.keys(db.tasks).length > MAX_TASKS) throw new Fail('too_many', 'Quá nhiều việc');
    const payload = JSON.stringify(db);
    if (Buffer.byteLength(payload) > MAX_BYTES) throw new Fail('too_big', 'Dữ liệu quá lớn', 413);
    const w = await writeIfUnchanged(payload, cur.empty ? null : cur.etag);
    if (w.ok) return { db, out, etag: w.etag };
    /* trùng (máy khác vừa ghi) → vòng lặp đọc lại và làm lại */
  }
  throw new Fail('conflict', 'Dữ liệu đang bị sửa liên tục, thử lại sau ít giây', 409);
}

/* ---------- Dạng trả về cho bot ---------- */
function listOf(db) {
  const out = [];
  let n = 0;
  for (const z of ZONE_ORDER) {
    Object.values(db.tasks).filter((t) => t.z === z).sort(byO).forEach((t) => {
      out.push({ n: ++n, id: t.id, title: t.title, person: t.person, time: t.time, zone: ZONE_CODE[z], zone_name: ZONE_NAME[z] });
    });
  }
  return out;
}
const countsOf = (db) => Object.fromEntries(ZONE_ORDER.map((z) => [ZONE_CODE[z], Object.values(db.tasks).filter((t) => t.z === z).length]));
const brief = (t) => ({ id: t.id, title: t.title, person: t.person, time: t.time, zone: ZONE_CODE[t.z], zone_name: ZONE_NAME[t.z] });

function getLive(db, id) {
  const t = db.tasks[String(id)];
  if (!t || t.z === 0) throw new Fail('not_found', 'Không tìm thấy việc này (có thể đã xóa hoặc đã đổi)', 404);
  return t;
}
const stamp = (prev) => Math.max(Date.now(), (prev || 0) + 1);

/* ---------- 4 thao tác ---------- */
const actions = {
  add(db, b) {
    const title = String(b.title || '').trim().replace(/\s+/g, ' ').slice(0, 160);
    if (!title) throw new Fail('no_title', 'Thiếu tên việc');
    let z = b.zone == null || b.zone === '' ? 1 : zoneOf(b.zone);
    if (z == null) throw new Fail('bad_zone', 'Ô phải là tu_lam, giam_sat hoặc giao_viec');
    const person = String(b.person || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    const time = cleanTime(b.time);
    let overflow = false;
    if (z === 1 && Object.values(db.tasks).filter((t) => t.z === 1).length >= MAX1) { z = 3; overflow = true; }
    const ts = Date.now();
    const t = { id: uid(), title, person, time, u: ts, z, o: lastO(db, z) + 1, pu: ts };
    db.tasks[t.id] = t;
    rememberPerson(db, person);
    return { task: t, overflow };
  },
  edit(db, b) {
    const t = getLive(db, b.id);
    let changed = false;
    if (b.title !== undefined) {
      const v = String(b.title).trim().replace(/\s+/g, ' ').slice(0, 160);
      if (!v) throw new Fail('no_title', 'Tên việc không được để trống');
      if (v !== t.title) { t.title = v; changed = true; }
    }
    if (b.person !== undefined) {
      const v = String(b.person).trim().replace(/\s+/g, ' ').slice(0, 40);
      if (v !== t.person) { t.person = v; changed = true; }
      rememberPerson(db, v);
    }
    if (b.time !== undefined) {
      const v = cleanTime(b.time);
      if (v !== t.time) { t.time = v; changed = true; }
    }
    if (b.title === undefined && b.person === undefined && b.time === undefined) throw new Fail('nothing', 'Không có gì để sửa (cần title, person hoặc time)');
    if (changed) t.u = stamp(t.u);
    return { task: t, changed };
  },
  move(db, b) {
    const t = getLive(db, b.id);
    const z = zoneOf(b.zone);
    if (z == null) throw new Fail('bad_zone', 'Ô phải là tu_lam, giam_sat hoặc giao_viec');
    if (t.z === z) return { task: t, unchanged: true };
    /* app cũng chặn kéo vào "Tự làm" khi đủ 5 → bot không tự đẩy việc khác ra */
    if (z === 1 && Object.values(db.tasks).filter((x) => x.z === 1).length >= MAX1) throw new Fail('full', `"Tự làm" đã đủ ${MAX1} việc`, 409);
    t.z = z; t.o = lastO(db, z) + 1; t.pu = stamp(t.pu);
    return { task: t };
  },
  delete(db, b) {
    const ids = [...new Set((Array.isArray(b.ids) ? b.ids : [b.id]).filter(Boolean).map(String))];
    if (!ids.length) throw new Fail('no_id', 'Thiếu id việc cần xóa');
    const gone = [];
    ids.forEach((id) => {
      const t = db.tasks[id];
      if (!t || t.z === 0) return;
      gone.push(brief(t));
      t.z = 0; t.pu = stamp(t.pu);        /* dấu xóa, giống app */
    });
    if (!gone.length) throw new Fail('not_found', 'Không tìm thấy việc nào để xóa (có thể đã xóa trước đó)', 404);
    return { deleted: gone };
  },
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const key = process.env.ZALO_REPORT_KEY;
  if (!key) return res.status(503).json({ ok: false, error: 'Chưa đặt biến ZALO_REPORT_KEY trên Vercel (hoặc chưa Redeploy)' });
  const sent = req.headers['x-key'] || (req.query && req.query.key);
  if (sent !== key) return res.status(401).json({ ok: false, error: 'Sai khóa' });

  try {
    if (req.method === 'GET') {
      const cur = await readLatest();
      const db = cleanData(cur.empty ? null : cur.data);
      return res.status(200).json({ ok: true, tasks: listOf(db), counts: countsOf(db), max_tu_lam: MAX1, p: db.p });
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ ok: false, error: 'Chỉ nhận GET / POST' }); }

    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    body = body || {};
    const fn = actions[String(body.action || '')];
    if (!fn) return res.status(400).json({ ok: false, error: 'action phải là add, edit, move hoặc delete' });

    const r = await mutate((db) => fn(db, body));
    /* Thay đổi do bot làm: không báo ngược về Zalo (bot tự trả lời bạn rồi). */
    const out = { ok: true, ...stripTask(r.out), tasks: listOf(r.db), counts: countsOf(r.db), max_tu_lam: MAX1, etag: r.etag };
    return res.status(200).json(out);
  } catch (e) {
    if (e instanceof Fail) return res.status(e.status).json({ ok: false, code: e.code, error: e.message });
    console.error(e);
    return res.status(500).json({ ok: false, error: 'Lỗi máy chủ' });
  }
}

function stripTask(o) {
  const r = { ...o };
  if (r.task) r.task = brief(r.task);
  return r;
}
