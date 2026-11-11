/* Dùng chung cho api/data.js và api/zalo.js (tên bắt đầu bằng "_" nên Vercel không coi là một API riêng).
   Việc ở đây: so sánh hai bản dữ liệu → viết tin → gửi vào cổng /notify của bot Zalo. */

const NOTIFY_URL_DEFAULT = 'https://zalochatbotchomne.william-archvn.workers.dev/notify';

export const ZONE_NAME = { 1: 'Tự làm', 3: 'Giám sát', 4: 'Giao việc' };
export const ZONE_ICON = { 1: '🎯', 3: '👀', 4: '🤝' };
const zoneLabel = (z) => `${ZONE_ICON[z] || ''} ${ZONE_NAME[z] || '?'}`.trim();

/* "2026-11-15T09:00" -> "15/11 09:00" (chuỗi giờ trong app là giờ địa phương, không đổi múi giờ) */
export function fmtDue(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(String(v || ''));
  if (!m) return '';
  const hasTime = m[4] && !(m[4] === '23' && m[5] === '59');   /* 23:59 = "chỉ có ngày" */
  return `${m[3]}/${m[2]}${hasTime ? ` ${m[4]}:${m[5]}` : ''}`;
}

const q = (s) => String(s || '').trim();
const live = (t) => t && t.z !== 0;

/* So bản cũ trên server với bản sắp ghi → danh sách dòng tin. Chỉ báo: thêm, sửa, chuyển ô, xóa (đổi thứ tự trong cùng ô thì không báo). */
export function diffTasks(oldTasks, newTasks) {
  const lines = [];
  const o = oldTasks || {}, n = newTasks || {};
  for (const id of Object.keys(n)) {
    const a = o[id], b = n[id];
    if (!live(b)) continue;
    if (!a || !live(a)) {
      const extra = [q(b.person), b.time ? `hạn ${fmtDue(b.time)}` : ''].filter(Boolean).join(' · ');
      const verb = a ? '↩️ Khôi phục vào' : '➕ Thêm vào';   /* a có mà đã xóa → bấm "Hoàn tác" */
      lines.push(`${verb} ${zoneLabel(b.z)}: ${q(b.title)}${extra ? ` (${extra})` : ''}`);
      continue;
    }
    const ch = [];
    if (a.title !== b.title) ch.push(`tên: “${q(a.title)}” → “${q(b.title)}”`);
    if (q(a.person) !== q(b.person)) ch.push(`người: ${q(a.person) || '(trống)'} → ${q(b.person) || '(trống)'}`);
    if (q(a.time) !== q(b.time)) ch.push(`hạn: ${fmtDue(a.time) || '(trống)'} → ${fmtDue(b.time) || '(trống)'}`);
    if (ch.length) lines.push(`✏️ ${q(b.title)} — ${ch.join('; ')}`);
    if (a.z !== b.z) lines.push(`↔️ ${q(b.title)}: ${zoneLabel(a.z)} → ${zoneLabel(b.z)}`);
  }
  for (const id of Object.keys(o)) {
    const a = o[id];
    if (!live(a)) continue;
    const b = n[id];
    if (!b || b.z === 0) lines.push(`🗑 Đã xóa: ${q(a.title)}`);
  }
  return lines;
}

/* Gửi tin vào Zalo. Không bao giờ ném lỗi (báo Zalo hỏng không được làm hỏng việc lưu dữ liệu). */
export async function notifyLines(lines) {
  const key = process.env.ZALO_NOTIFY_KEY;
  if (!key || !lines || !lines.length) return { skipped: true };
  const MAX = 8;
  const shown = lines.slice(0, MAX);
  if (lines.length > MAX) shown.push(`…và ${lines.length - MAX} thay đổi khác`);
  try {
    const r = await fetch(process.env.ZALO_NOTIFY_URL || NOTIFY_URL_DEFAULT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Key': key },
      body: JSON.stringify({ title: '🧩 Lean To Do', text: shown.join('\n'), src: 'Lean to do', cooldown: 0 }),
      signal: AbortSignal.timeout(4000),
    });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    console.error('notify lỗi', e && e.message);
    return { ok: false };
  }
}
