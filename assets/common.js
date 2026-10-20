import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

export const configured = !SUPABASE_URL.includes('YOUR-') && !SUPABASE_KEY.includes('YOUR-');

export function makeClient(persistSession) {
  if (!configured) return null;
  return createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession, autoRefreshToken: persistSession, detectSessionInUrl: persistSession },
  });
}

// ---------- tiny DOM helpers ----------
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Multi-line text → safe HTML with line breaks. */
export function escLines(v) { return esc(v).replace(/\n/g, '<br>'); }

// ---------- dates ----------
const LOCALE = undefined; // browser default; set e.g. 'en-GB' or 'nl-NL' to force
const dtf = new Intl.DateTimeFormat(LOCALE, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const df = new Intl.DateTimeFormat(LOCALE, { weekday: 'short', day: 'numeric', month: 'short' });
const tf = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit' });
const dfy = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' });

export const fmtDateTime = d => d ? dtf.format(new Date(d)) : '';
export const fmtDate = d => d ? df.format(new Date(d)) : '';
export const fmtTime = d => d ? tf.format(new Date(d)) : '';
export const fmtDateYear = d => d ? dfy.format(new Date(d)) : '';

export function sameDay(a, b) {
  a = new Date(a); b = new Date(b);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function fmtRange(a, b) {
  if (!a || !b) return '';
  return sameDay(a, b)
    ? `${fmtDate(a)}, ${fmtTime(a)}–${fmtTime(b)}`
    : `${fmtDateTime(a)} – ${fmtDateTime(b)}`;
}

/** Date → value for <input type="datetime-local"> in local time. */
export function toLocalInput(d) {
  d = new Date(d);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function fromLocalInput(v) { return v ? new Date(v) : null; }

export function overlaps(aStart, aEnd, bStart, bEnd) {
  return new Date(aStart) < new Date(bEnd ?? 8.64e15) && new Date(bStart) < new Date(aEnd);
}

export function humanDuration(a, b) {
  const h = Math.round((new Date(b) - new Date(a)) / 36e5);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'}`;
  const d = Math.round(h / 24 * 2) / 2;
  return `${d} day${d === 1 ? '' : 's'}`;
}

// ---------- statuses ----------
export const STATUS = {
  pending:     { label: 'Waiting for approval', short: 'Pending' },
  approved:    { label: 'Approved',             short: 'Approved' },
  rejected:    { label: 'Not approved',         short: 'Rejected' },
  cancelled:   { label: 'Cancelled',            short: 'Cancelled' },
  checked_out: { label: 'Collected',            short: 'Out' },
  returned:    { label: 'Returned',             short: 'Returned' },
  overdue:     { label: 'Overdue',              short: 'Overdue' },
};

export function statusKey(b) { return b.is_overdue ? 'overdue' : b.status; }

export function badge(b, long = false) {
  const k = typeof b === 'string' ? b : statusKey(b);
  const s = STATUS[k] || { label: k, short: k };
  return `<span class="badge badge--${k}">${esc(long ? s.label : s.short)}</span>`;
}

/** The punched asset tag shown on every item. */
export function assetTag(code) {
  return code ? `<span class="tag" aria-label="Asset number ${esc(code)}">${esc(code)}</span>` : '';
}

// ---------- errors & toasts ----------
export function errMsg(error) {
  if (!error) return '';
  if (error.code === '23P01') return 'That clashes with another approved booking for the same item.';
  if (error.code === '23505') return 'That value is already in use (asset numbers must be unique).';
  if (error.code === '23503') return 'This is still referenced elsewhere (e.g. an item that appears in bookings — retire it instead).';
  if (error.code === '42501') return 'You are not allowed to do that. Are you signed in as an admin?';
  if (/Failed to fetch|NetworkError/i.test(error.message || '')) return 'Could not reach the server. Check your connection and try again.';
  return error.message || String(error);
}

export function toast(msg, kind = 'ok') {
  let host = $('#toasts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toasts';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
  }
  // Modal dialogs sit in the browser's top layer; keep toasts above whichever is open.
  const top = [...document.querySelectorAll('dialog[open]')].pop() || document.body;
  if (host.parentElement !== top) top.append(host);
  const el = document.createElement('div');
  el.className = `toast toast--${kind}`;
  el.textContent = msg;
  host.append(el);
  while (host.children.length > 3) host.firstElementChild.remove();
  setTimeout(() => el.classList.add('toast--leaving'), kind === 'error' ? 6000 : 3500);
  setTimeout(() => el.remove(), kind === 'error' ? 6400 : 3900);
}

export function notConfiguredHTML() {
  return `<div class="setup-note">
    <h2>Almost there</h2>
    <p>This site isn't connected to a database yet. Open <code>assets/config.js</code> and paste your
    Supabase project URL and public key, then reload. The README walks through it step by step.</p>
  </div>`;
}

export function safeStorage() {
  try { const k = '__t'; localStorage.setItem(k, k); localStorage.removeItem(k); return localStorage; }
  catch { return null; }
}
