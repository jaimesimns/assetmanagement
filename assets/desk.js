// Desk hours: turn "Mon 10:00–12:00, Thu 10:00–12:00" into concrete pick-up / return slots.
// All wall-clock times are in the desk's time zone (Settings → time zone), whatever the
// visitor's own computer is set to.

const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WD_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const STEP_MIN = 15;

const partsFmt = new Map();
function tzParts(date, tz) {
  if (!partsFmt.has(tz)) partsFmt.set(tz, new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  }));
  const o = {};
  for (const p of partsFmt.get(tz).formatToParts(date)) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, min: +o.minute, wd: WD.indexOf(o.weekday) + 1 };
}

/** The real moment for a wall-clock time in `tz` (handles summer/winter time). */
export function zoned(y, m, d, h, min, tz) {
  const want = Date.UTC(y, m - 1, d, h, min);
  let t = want;
  for (let i = 0; i < 3; i++) {
    const p = tzParts(new Date(t), tz);
    const diff = want - Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
    if (!diff) break;
    t += diff;
  }
  return new Date(t);
}

const hm = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const pad = n => String(n).padStart(2, '0');

/** "Monday and Thursday, 10:00–12:00" style summary. */
export function hoursText(hours) {
  if (!hours?.length) return '';
  const byTime = new Map();
  for (const h of hours) {
    const k = `${h.opens}–${h.closes}`;
    if (!byTime.has(k)) byTime.set(k, []);
    byTime.get(k).push(h.weekday);
  }
  const list = arr => arr.length < 2 ? arr[0] : `${arr.slice(0, -1).join(', ')} and ${arr.at(-1)}`;
  return list([...byTime].map(([t, days]) => `${list([...new Set(days)].sort().map(d => WD_LONG[d - 1]))}, ${t}`));
}

/**
 * Open days from `from` onwards, each with every bookable moment (15-minute steps,
 * opening and closing time included). Closed dates are skipped.
 * Returns [{ key: 'YYYY-MM-DD', times: [Date, …] }, …]
 */
export function openDays(hours, closures, tz, from = new Date(), horizonDays = 200) {
  const closed = new Set((closures || []).map(c => c.day));
  const base = tzParts(from, tz);
  const out = [];
  for (let k = 0; k <= horizonDays; k++) {
    const day = new Date(Date.UTC(base.y, base.m - 1, base.d + k));
    const y = day.getUTCFullYear(), m = day.getUTCMonth() + 1, d = day.getUTCDate();
    const wd = (day.getUTCDay() + 6) % 7 + 1;
    const key = `${y}-${pad(m)}-${pad(d)}`;
    if (closed.has(key)) continue;
    const windows = hours.filter(h => h.weekday === wd);
    if (!windows.length) continue;
    const mins = new Set();
    for (const w of windows) for (let t = hm(w.opens); t <= hm(w.closes); t += STEP_MIN) mins.add(t);
    if (windows.some(w => (hm(w.closes) - hm(w.opens)) % STEP_MIN)) windows.forEach(w => mins.add(hm(w.closes)));
    const times = [...mins].sort((a, b) => a - b).map(t => zoned(y, m, d, Math.floor(t / 60), t % 60, tz));
    out.push({ key, times });
  }
  return out;
}

export function dayLabel(date, tz) {
  return new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(date);
}
export function timeLabel(date, tz) {
  return new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(date);
}
