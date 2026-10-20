import {
  makeClient, configured, $, $$, esc, escLines, fmtDateTime, fmtDate, fmtTime, fmtRange, fmtDateYear,
  toLocalInput, fromLocalInput, overlaps, humanDuration, badge, statusKey, assetTag, errMsg, toast,
  notConfiguredHTML, sameDay, STATUS,
} from './common.js';

const sb = makeClient(true);
const DAY = 864e5;
const ACTIVE = ['pending', 'approved', 'checked_out'];

const A = {
  user: null,
  started: false,
  equipment: [],
  categories: [],
  settings: null,
  active: [],          // pending / approved / checked_out bookings (refreshed often)
  view: null,
  calFrom: startOfDay(new Date(Date.now() - 2 * DAY)),
  calDays: 14,
  calCat: 'all',
  bkTab: 'pending',
  bkQ: '',
  bkCache: [],
  eqQ: '',
  eqStatus: 'active',
  openBooking: null,
};

function startOfDay(d) { d = new Date(d); d.setHours(0, 0, 0, 0); return d; }
const publicUrl = () => new URL('../', location.href).href;

// ================================================================== auth
init();

async function init() {
  if (!configured) { $('#boot').outerHTML = notConfiguredHTML(); return; }

  $$('dialog [data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
  $$('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close(); }));
  $$('[data-signout]').forEach(b => b.addEventListener('click', async () => { await sb.auth.signOut(); location.hash = ''; location.reload(); }));

  $('#login-form').addEventListener('submit', login);
  $('#forgot').addEventListener('click', forgot);
  $('#reset-form').addEventListener('submit', saveNewPassword);

  // Arriving from a "reset password" email?
  A.recovering = /type=recovery/.test(location.hash + location.search);

  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') { A.recovering = true; showAuth('reset'); return; }
    if (event === 'SIGNED_OUT') { A.started = false; showAuth('login'); }
  });

  const { data } = await sb.auth.getSession();
  $('#boot').remove();
  if (A.recovering) showAuth('reset');
  else if (data.session) start(data.session.user);
  else showAuth('login');
}

function showAuth(which) {
  $('#shell').classList.add('hidden');
  $('#auth').classList.remove('hidden');
  $('#login-form').classList.toggle('hidden', which !== 'login');
  $('#reset-form').classList.toggle('hidden', which !== 'reset');
  $('#not-admin').classList.toggle('hidden', which !== 'not-admin');
}

async function login(e) {
  e.preventDefault();
  const email = $('#login-email').value.trim(), password = $('#login-pw').value;
  const msg = $('#auth-msg');
  if (!email || !password) { msg.innerHTML = `<div class="notice notice--error">Enter your email and password.</div>`; return; }
  const btn = $('#login-btn');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Signing in…';
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  btn.disabled = false; btn.textContent = 'Sign in';
  if (error) { msg.innerHTML = `<div class="notice notice--error">${esc(error.message === 'Invalid login credentials' ? 'That email and password don\'t match an account.' : errMsg(error))}</div>`; return; }
  msg.innerHTML = '';
  start(data.user);
}

async function forgot() {
  const email = $('#login-email').value.trim();
  const msg = $('#auth-msg');
  if (!email) { msg.innerHTML = `<div class="notice">Enter your email above first, then choose "Forgot your password?" again.</div>`; $('#login-email').focus(); return; }
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.href.split('#')[0] });
  msg.innerHTML = error
    ? `<div class="notice notice--error">${esc(errMsg(error))}</div>`
    : `<div class="notice notice--ok">If that address has an account, a reset link is on its way.</div>`;
}

async function saveNewPassword(e) {
  e.preventDefault();
  const pw = $('#new-pw').value;
  if (pw.length < 8) { $('#reset-msg').innerHTML = `<div class="notice notice--error">Use at least 8 characters.</div>`; return; }
  const { data, error } = await sb.auth.updateUser({ password: pw });
  if (error) { $('#reset-msg').innerHTML = `<div class="notice notice--error">${esc(errMsg(error))}</div>`; return; }
  toast('Password saved');
  A.recovering = false;
  setTimeout(() => location.replace(location.pathname), 600);
}

async function start(user) {
  if (A.started || A.recovering) return;
  A.started = true;
  A.user = user;
  const { data: isAdmin, error } = await sb.rpc('is_admin');
  if (error || !isAdmin) {
    A.started = false;
    $('#na-email').textContent = user.email;
    showAuth('not-admin');
    return;
  }
  $('#auth').classList.add('hidden');
  $('#shell').classList.remove('hidden');
  $('#me-email').textContent = user.email;
  $('#public-link').href = publicUrl();

  await Promise.all([loadRefs(), loadActive()]);
  $('#view').addEventListener('click', onViewClick);
  window.addEventListener('hashchange', route);
  route();

  // quiet refresh every minute while nothing is open
  setInterval(async () => {
    if (document.hidden || $$('dialog').some(d => d.open)) return;
    await loadActive();
    if (['today', 'calendar', 'bookings'].includes(A.view)) render(false);
  }, 60000);
}

// ================================================================== data
async function q(promise) {
  const { data, error } = await promise;
  if (error) { toast(errMsg(error), 'error'); throw error; }
  return data;
}

async function loadRefs() {
  const [eq, cats, st] = await Promise.all([
    q(sb.from('equipment').select('*').order('name')),
    q(sb.from('categories').select('*').order('sort_order').order('name')),
    q(sb.from('settings').select('*').eq('id', 1).single()),
  ]);
  A.equipment = eq; A.categories = cats; A.settings = st;
  $('#org-name').textContent = st.org_name || 'Equipment loans';
  document.title = `Admin · ${st.org_name || 'Equipment loans'}`;
}

async function loadActive() {
  A.active = await q(sb.from('booking_overview').select('*').in('status', ACTIVE).order('starts_at'));
  const n = A.active.filter(b => b.status === 'pending').length;
  const el = $('#nav-pending');
  el.textContent = n; el.classList.toggle('hidden', !n);
}

const catName = id => A.categories.find(c => c.id === id)?.name || '';
const itemsText = b => (b.items || []).map(i => i.name).join(', ');

// ================================================================== routing
function route() {
  const [, view = 'today', arg] = location.hash.match(/^#\/([^/?]+)\/?([^?]*)/) || [];
  if (view === 'booking' && arg) {
    if (!A.view) { A.view = 'today'; render(); }
    openBooking(Number(arg));
    return;
  }
  A.view = ['today', 'bookings', 'calendar', 'equipment', 'settings'].includes(view) ? view : 'today';
  $$('.side-nav a').forEach(a => a.dataset.nav === A.view ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'));
  render();
}

async function render(focus = true) {
  const v = $('#view');
  try {
    if (A.view === 'today') await renderToday(v);
    if (A.view === 'bookings') await renderBookings(v);
    if (A.view === 'calendar') await renderCalendar(v);
    if (A.view === 'equipment') await renderEquipment(v);
    if (A.view === 'settings') renderSettings(v);
  } catch (e) { console.error(e); }
  if (focus) v.focus({ preventScroll: true });
}

async function refreshAll() {
  await loadActive();
  await render(false);
}

// ================================================================== Today
function bookingRow(b, actions = '') {
  const late = b.status === 'approved' && new Date(b.starts_at) < new Date();
  return `<li data-bk="${b.id}">
    <div>
      <div class="who">${esc(b.borrower_name)} ${badge(b)}</div>
      <div class="what">${esc(itemsText(b))}</div>
      <div class="when">${esc(fmtRange(b.starts_at, b.ends_at))}${late ? ' <span class="late">not collected yet</span>' : ''}</div>
    </div>
    <div class="acts">${actions}</div>
  </li>`;
}

function lane(title, list, opts = {}) {
  return `<section class="lane${opts.wide ? ' lane--wide' : ''}">
    <h2>${esc(title)} <small>${list.length}</small></h2>
    <ul class="blist">${list.length ? list.map(b => bookingRow(b, opts.actions?.(b) || '')).join('')
      : `<li class="empty">${esc(opts.empty || 'Nothing here.')}</li>`}</ul>
  </section>`;
}

async function renderToday(v) {
  const now = new Date(), t0 = startOfDay(now), t1 = new Date(t0.getTime() + DAY), wk = new Date(t0.getTime() + 8 * DAY);
  const act = A.active;
  const pending = act.filter(b => b.status === 'pending');
  const overdue = act.filter(b => b.is_overdue);
  const out = act.filter(b => b.status === 'checked_out');
  const pickups = act.filter(b => b.status === 'approved' && new Date(b.starts_at) < t1);
  const returns = act.filter(b => b.status === 'checked_out' && !b.is_overdue && new Date(b.ends_at) < t1);
  const soon = act.filter(b => b.status === 'approved' && new Date(b.starts_at) >= t1 && new Date(b.starts_at) < wk);

  const counter = (n, label, href, cls = '') =>
    `<a class="counter ${cls}${n ? '' : ' is-zero'}" href="${href}"><strong>${n}</strong><span>${label}</span></a>`;

  v.innerHTML = `
    <div class="view-head">
      <h1>${esc(new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' }).format(now))}</h1>
      <button class="btn" data-new>New booking</button>
    </div>
    <div class="counters">
      ${counter(pending.length, 'Waiting for approval', '#/bookings?pending', 'counter--pending')}
      ${counter(pickups.length, 'To hand out today', '#/bookings?approved')}
      ${counter(returns.length, 'Due back today', '#/bookings?checked_out')}
      ${counter(out.length, 'Out now', '#/bookings?checked_out')}
      ${counter(overdue.length, 'Overdue', '#/bookings?overdue', 'counter--overdue')}
    </div>
    <div class="lanes">
      ${lane('Waiting for approval', pending, {
        wide: true, empty: 'No requests waiting. New ones from the student page appear here.',
        actions: b => `<button class="btn btn--small" data-act="reject" data-id="${b.id}">Reject</button>
                       <button class="btn btn--small btn--primary" data-act="approve" data-id="${b.id}">Approve</button>`,
      })}
      ${lane('To hand out today', pickups, {
        empty: 'No pick-ups today.',
        actions: b => `<button class="btn btn--small btn--primary" data-act="check_out" data-id="${b.id}">Hand out</button>`,
      })}
      ${lane('Due back today', returns, {
        empty: 'Nothing due back today.',
        actions: b => `<button class="btn btn--small btn--primary" data-act="return" data-id="${b.id}">Check in</button>`,
      })}
      ${overdue.length ? lane('Overdue', overdue, {
        wide: true,
        actions: b => `<a class="btn btn--small" href="${mailto(b)}" data-stop>Email</a>
                       <button class="btn btn--small btn--primary" data-act="return" data-id="${b.id}">Check in</button>`,
      }) : ''}
      ${lane('Coming up this week', soon, { wide: true, empty: 'Nothing booked for the coming week.' })}
    </div>`;
}

// One delegated click handler for everything inside the main view (attached once).
function onViewClick(e) {
  if (e.target.closest('[data-stop]')) return;
  if (e.target.closest('[data-new]')) { openEditor(null); return; }
  const act = e.target.closest('[data-act]');
  if (act) { doAction(Number(act.dataset.id), act.dataset.act); return; }
  const row = e.target.closest('[data-bk]');
  if (row) openBooking(Number(row.dataset.bk));
}

// ================================================================== Bookings list
const TABS = [
  ['pending', 'Waiting'], ['approved', 'Approved'], ['checked_out', 'Out'], ['overdue', 'Overdue'],
  ['history', 'History'], ['all', 'All'],
];

async function renderBookings(v) {
  const want = (location.hash.split('?')[1] || '').trim();
  if (want && TABS.some(t => t[0] === want)) A.bkTab = want;

  let list;
  if (['pending', 'approved', 'checked_out', 'overdue'].includes(A.bkTab)) {
    list = A.active.filter(b => A.bkTab === 'overdue' ? b.is_overdue : b.status === A.bkTab);
  } else {
    let query = sb.from('booking_overview').select('*').order('starts_at', { ascending: false }).limit(1000);
    if (A.bkTab === 'history') query = query.in('status', ['returned', 'rejected', 'cancelled']);
    list = await q(query);
  }
  A.bkCache = list;
  const counts = {
    pending: A.active.filter(b => b.status === 'pending').length,
    approved: A.active.filter(b => b.status === 'approved').length,
    checked_out: A.active.filter(b => b.status === 'checked_out').length,
    overdue: A.active.filter(b => b.is_overdue).length,
  };

  v.innerHTML = `
    <div class="view-head">
      <h1>Bookings</h1>
      <button class="btn" id="bk-export">Export CSV</button>
      <button class="btn btn--primary" data-new>New booking</button>
    </div>
    <nav class="tabs" aria-label="Filter bookings">
      ${TABS.map(([k, l]) => `<a href="#/bookings?${k}" aria-current="${A.bkTab === k}">${l}${counts[k] !== undefined ? `<span class="n">${counts[k]}</span>` : ''}</a>`).join('')}
    </nav>
    <div class="toolbar">
      <input type="search" id="bk-q" placeholder="Search name, email, reference or item" value="${esc(A.bkQ)}" aria-label="Search bookings">
    </div>
    <div id="bk-table"></div>`;

  $('#bk-q').addEventListener('input', e => { A.bkQ = e.target.value; drawBookingTable(); });
  $('#bk-export').addEventListener('click', exportCsv);
  drawBookingTable();
}

function filteredBookings() {
  const qq = A.bkQ.trim().toLowerCase();
  const list = A.bkCache;
  if (!qq) return list;
  return list.filter(b => [b.ref, b.borrower_name, b.borrower_email, b.borrower_id, b.course, itemsText(b),
    ...(b.items || []).map(i => i.asset_tag)].some(x => (x || '').toLowerCase().includes(qq)));
}

function drawBookingTable() {
  const list = filteredBookings();
  const ascending = ['pending', 'approved'].includes(A.bkTab);
  const sorted = ['checked_out', 'overdue'].includes(A.bkTab)
    ? [...list].sort((a, b) => new Date(a.ends_at) - new Date(b.ends_at))
    : ascending ? [...list].sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at)) : list;
  $('#bk-table').innerHTML = sorted.length ? `
    <div class="table-wrap"><table>
      <thead><tr><th>Ref</th><th>Borrower</th><th>Items</th><th>Pick up</th><th>Return</th><th>Status</th></tr></thead>
      <tbody>${sorted.map(b => `<tr data-bk="${b.id}">
        <td class="nowrap">${assetTag(b.ref)}</td>
        <td><strong>${esc(b.borrower_name)}</strong><span class="sub">${esc(b.borrower_email)}</span></td>
        <td class="items-cell">${esc(itemsText(b))}</td>
        <td class="nowrap">${esc(fmtDateTime(b.starts_at))}</td>
        <td class="nowrap">${esc(fmtDateTime(b.ends_at))}</td>
        <td>${badge(b)}</td>
      </tr>`).join('')}</tbody>
    </table></div>`
    : `<div class="empty">${A.bkQ ? 'No bookings match that search.' : 'No bookings in this list.'}</div>`;
}

function exportCsv() {
  const rows = filteredBookings();
  const cols = ['ref', 'status', 'borrower_name', 'borrower_email', 'borrower_id', 'borrower_phone', 'course', 'purpose',
    'starts_at', 'ends_at', 'items', 'checked_out_at', 'returned_at', 'admin_note', 'internal_note', 'return_note', 'created_at'];
  const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols.join(','), ...rows.map(b => cols.map(c => cell(c === 'items' ? itemsText(b)
    : c === 'status' ? statusKey(b) : b[c])).join(','))].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `bookings-${A.bkTab}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ================================================================== Booking detail
async function openBooking(id) {
  const [rows, events] = await Promise.all([
    q(sb.from('booking_overview').select('*').eq('id', id)),
    q(sb.from('booking_events').select('*').eq('booking_id', id).order('at', { ascending: false })),
  ]);
  const b = rows?.[0];
  if (!b) { toast('Booking not found.', 'error'); return; }
  A.openBooking = b;
  const dlg = $('#dlg-booking');
  $('#bk-title').innerHTML = `${assetTag(b.ref)} <span style="margin-left:.5rem">${esc(b.borrower_name)}</span>`;

  const eventLabel = a => ({
    requested: 'Requested', 'created by admin': 'Created by staff', pending: 'Back to pending', approved: 'Approved',
    rejected: 'Rejected', cancelled: 'Cancelled', checked_out: 'Handed out', returned: 'Checked in',
    'dates changed': 'Dates changed', 'items changed': 'Items changed',
  }[a] || a);

  $('#bk-body').innerHTML = `
    <div class="bk-grid">
      <div>
        <div class="bk-section"><div class="bk-when">
          <div><span>Pick up</span><strong>${esc(fmtDateTime(b.starts_at))}</strong>${b.checked_out_at ? `<span>Handed out ${esc(fmtDateTime(b.checked_out_at))}</span>` : ''}</div>
          <div><span>Return</span><strong class="${b.is_overdue ? 'late' : ''}">${esc(fmtDateTime(b.ends_at))}</strong>${b.returned_at ? `<span>Checked in ${esc(fmtDateTime(b.returned_at))}</span>` : `<span>${esc(humanDuration(b.starts_at, b.ends_at))}</span>`}</div>
        </div></div>
        <div class="bk-section">
          <h3>${b.items.length} item${b.items.length === 1 ? '' : 's'}</h3>
          <ul class="bk-items">${b.items.map(i => `<li>${assetTag(i.asset_tag)} <span>${esc(i.name)}</span>${i.location ? `<span class="loc">${esc(i.location)}</span>` : ''}</li>`).join('')}</ul>
        </div>
        ${b.purpose ? `<div class="bk-section"><h3>Purpose</h3><p>${escLines(b.purpose)}</p></div>` : ''}
        ${b.admin_note ? `<div class="bk-section"><h3>Message to borrower</h3><p>${escLines(b.admin_note)}</p></div>` : ''}
        ${b.return_note ? `<div class="bk-section"><h3>Condition on return</h3><p>${escLines(b.return_note)}</p></div>` : ''}
        <div class="bk-section note-box">
          <h3><label for="bk-internal" style="all:inherit">Staff note</label></h3>
          <textarea id="bk-internal" placeholder="Only admins see this">${esc(b.internal_note || '')}</textarea>
          <button class="btn btn--small" id="bk-save-note" style="margin-top:.4rem">Save note</button>
        </div>
      </div>
      <div>
        <div class="bk-section">${badge(b, true)}</div>
        <div class="bk-section">
          <h3>Borrower</h3>
          <dl class="meta" style="grid-template-columns:max-content 1fr;display:grid;gap:.2rem .75rem;margin:0">
            <dt class="muted">Email</dt><dd style="margin:0"><a href="mailto:${esc(b.borrower_email)}">${esc(b.borrower_email)}</a></dd>
            ${b.borrower_id ? `<dt class="muted">${esc(A.settings.student_id_label)}</dt><dd style="margin:0">${esc(b.borrower_id)}</dd>` : ''}
            ${b.borrower_phone ? `<dt class="muted">Phone</dt><dd style="margin:0"><a href="tel:${esc(b.borrower_phone)}">${esc(b.borrower_phone)}</a></dd>` : ''}
            ${b.course ? `<dt class="muted">Course</dt><dd style="margin:0">${esc(b.course)}</dd>` : ''}
          </dl>
        </div>
        <div class="bk-section">
          <h3>Activity</h3>
          <ul class="timeline">${events.map(ev => `<li>
            <div class="t-what">${esc(eventLabel(ev.action))}</div>
            <div class="t-meta">${esc(fmtDateTime(ev.at))} · ${esc(ev.actor_email || (ev.actor ? 'staff' : 'borrower'))}</div>
            ${ev.note ? `<div class="t-note">${esc(ev.note)}</div>` : ''}
          </li>`).join('')}</ul>
        </div>
      </div>
    </div>`;

  $('#bk-save-note').onclick = async () => {
    await q(sb.from('bookings').update({ internal_note: $('#bk-internal').value.trim() || null }).eq('id', b.id));
    toast('Note saved');
  };

  const btn = (act, label, cls = '') => `<button class="btn ${cls}" data-act="${act}">${label}</button>`;
  const actions = {
    pending: [btn('cancel', 'Cancel', 'btn--ghost'), btn('reject', 'Reject', 'btn--danger'), btn('check_out', 'Approve & hand out'), btn('approve', 'Approve', 'btn--primary')],
    approved: [btn('cancel', 'Cancel', 'btn--ghost'), btn('reject', 'Withdraw approval', 'btn--danger'), btn('check_out', 'Hand out', 'btn--primary')],
    checked_out: [btn('undo_checkout', 'Undo hand-out', 'btn--ghost'), btn('return', 'Check in', 'btn--primary')],
    returned: [btn('undo_return', 'Undo check-in', 'btn--ghost')],
    rejected: [btn('reopen', 'Reopen')],
    cancelled: [btn('reopen', 'Reopen')],
  }[b.status] || [];

  $('#bk-actions').innerHTML = `
    <a class="btn btn--ghost" href="${mailto(b)}">Email borrower</a>
    ${['returned', 'rejected', 'cancelled'].includes(b.status) ? '' : '<button class="btn btn--ghost" data-edit>Edit</button>'}
    <span class="grow"></span>
    ${actions.join('')}`;
  $('#bk-actions').onclick = e => {
    const a = e.target.closest('[data-act]');
    if (a) doAction(b.id, a.dataset.act);
    if (e.target.closest('[data-edit]')) { dlg.close(); openEditor(b); }
  };

  if (!dlg.open) dlg.showModal();
  dlg.onclose = () => {
    A.openBooking = null;
    if (location.hash.startsWith('#/booking/')) history.replaceState(null, '', `#/${A.view}`);
  };
}

// ================================================================== actions
const ACT_UI = {
  approve:  { title: 'Approve booking', ok: 'Approve', label: 'Message to the borrower (optional)', text: 'The borrower will see this message when they check their booking.' },
  reject:   { title: 'Reject booking', ok: 'Reject', label: 'Reason (shown to the borrower)', text: 'The items become free for others.', danger: true },
  cancel:   { title: 'Cancel booking', ok: 'Cancel booking', label: 'Reason (optional, shown to the borrower)', text: 'The items become free for others.', danger: true },
  return:   { title: 'Check in', ok: 'Check in', label: 'Condition on return (optional)', text: 'Anything missing or damaged? Note it here. Remember to set an item to "In maintenance" if it needs repair.' },
};

async function doAction(id, act, noteOverride) {
  let note = noteOverride ?? null;
  if (ACT_UI[act] && noteOverride === undefined) {
    const res = await askNote(ACT_UI[act]);
    if (res === null) return;
    note = res;
  }
  if (act === 'undo_checkout' && !confirm('Mark this as not handed out yet?')) return;
  if (act === 'undo_return' && !confirm('Mark this as still out with the borrower?')) return;

  const { data, error } = await sb.rpc('admin_booking_action', { p_id: id, p_action: act, p_note: note });
  if (error) { toast(errMsg(error), 'error'); return; }
  const done = { approve: 'Approved', reject: 'Rejected', cancel: 'Cancelled', check_out: 'Handed out', return: 'Checked in', reopen: 'Reopened', undo_checkout: 'Hand-out undone', undo_return: 'Check-in undone' }[act];
  toast(done);
  if (data?.warning) toast(data.warning, 'error');
  await refreshAll();
  if ($('#dlg-booking').open) openBooking(id);
  else if (['approve', 'reject', 'cancel'].includes(act)) {
    const rows = await q(sb.from('booking_overview').select('*').eq('id', id));
    if (rows?.[0]) toastLink(`Let ${rows[0].borrower_name.split(' ')[0]} know`, mailto(rows[0]));
  }
}

function toastLink(label, href) {
  toast('');
  const el = $('#toasts').lastElementChild;
  el.innerHTML = `<a href="${esc(href)}" style="color:#fff">${esc(label)}</a> by email`;
}

function askNote(cfg) {
  return new Promise(resolve => {
    const dlg = $('#dlg-act');
    $('#act-title').textContent = cfg.title;
    $('#act-text').textContent = cfg.text || '';
    $('#act-label').textContent = cfg.label;
    $('#act-note').value = '';
    const ok = $('#act-ok');
    ok.textContent = cfg.ok;
    ok.className = `btn ${cfg.danger ? 'btn--danger' : 'btn--primary'}`;
    let result = null;
    $('#act-form').onsubmit = e => { e.preventDefault(); result = $('#act-note').value.trim(); dlg.close(); };
    dlg.onclose = () => resolve(result);
    dlg.showModal();
    $('#act-note').focus();
  });
}

function mailto(b) {
  const org = A.settings?.org_name || 'Equipment loans';
  const link = `${publicUrl()}#check/${b.ref}`;
  const items = (b.items || []).map(i => `- ${i.name}${i.asset_tag ? ` (${i.asset_tag})` : ''}`).join('\n');
  const when = `Pick up: ${fmtDateTime(b.starts_at)}\nReturn: ${fmtDateTime(b.ends_at)}`;
  const k = statusKey(b);
  const first = b.borrower_name.split(' ')[0];
  const t = {
    pending:     [`Your booking request ${b.ref}`, `We've received your request and will get back to you soon.\n\n${when}\n\nItems:\n${items}`],
    approved:    [`Approved: booking ${b.ref}`, `Your booking has been approved.\n\n${when}\n\nItems:\n${items}${A.settings?.pickup_info ? `\n\n${A.settings.pickup_info}` : ''}${b.admin_note ? `\n\n${b.admin_note}` : ''}`],
    rejected:    [`Booking ${b.ref} not approved`, `Unfortunately we couldn't approve your booking for ${fmtRange(b.starts_at, b.ends_at)}.${b.admin_note ? `\n\n${b.admin_note}` : ''}\n\nYou're welcome to make a new request for other dates.`],
    cancelled:   [`Booking ${b.ref} cancelled`, `Your booking for ${fmtRange(b.starts_at, b.ends_at)} has been cancelled.${b.admin_note ? `\n\n${b.admin_note}` : ''}`],
    checked_out: [`Return reminder: booking ${b.ref}`, `A reminder that the following items are due back ${fmtDateTime(b.ends_at)}:\n\n${items}`],
    overdue:     [`Overdue: please return booking ${b.ref}`, `The following items were due back ${fmtDateTime(b.ends_at)}:\n\n${items}\n\nPlease return them as soon as possible, or reply to let us know when you can.`],
    returned:    [`Thanks for returning booking ${b.ref}`, `Thanks, everything for booking ${b.ref} has been checked in.${b.return_note ? `\n\nNote: ${b.return_note}` : ''}`],
  }[k];
  const body = `Hi ${first},\n\n${t[1]}\n\nCheck your booking: ${link}\n\n${org}`;
  return `mailto:${encodeURIComponent(b.borrower_email)}?subject=${encodeURIComponent(t[0])}&body=${encodeURIComponent(body)}`;
}

// ================================================================== Booking editor
async function openEditor(b) {
  const dlg = $('#dlg-edit');
  $('#ed-error').innerHTML = '';
  $('#ed-title').textContent = b ? `Edit booking ${b.ref}` : 'New booking';
  $('#ed-status-field').classList.toggle('hidden', !!b);
  const start = b ? new Date(b.starts_at) : (() => { const d = new Date(); d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0); return d; })();
  const end = b ? new Date(b.ends_at) : new Date(start.getTime() + 2 * DAY);
  $('#ed-start').value = toLocalInput(start);
  $('#ed-end').value = toLocalInput(end);
  $('#ed-status').value = 'approved';
  $('#ed-name').value = b?.borrower_name || '';
  $('#ed-email').value = b?.borrower_email || '';
  $('#ed-sid').value = b?.borrower_id || '';
  $('#ed-phone').value = b?.borrower_phone || '';
  $('#ed-course').value = b?.course || '';
  $('#ed-purpose').value = b?.purpose || '';
  $('#ed-internal').value = b?.internal_note || '';
  $('#ed-q').value = '';
  const chosen = new Set((b?.items || []).map(i => i.id));

  const pickable = A.equipment.filter(e => e.status !== 'retired' || chosen.has(e.id));
  async function drawPicker() {
    const s = fromLocalInput($('#ed-start').value), e = fromLocalInput($('#ed-end').value);
    let clashes = new Map();
    if (s && e && e > s) {
      const others = await q(sb.from('booking_overview').select('id,ref,status,starts_at,ends_at,items')
        .in('status', ['approved', 'checked_out', 'pending']).lt('starts_at', e.toISOString()).gt('ends_at', s.toISOString()));
      for (const o of others) {
        if (b && o.id === b.id) continue;
        for (const it of o.items) {
          const prev = clashes.get(it.id);
          if (!prev || (prev.status === 'pending' && o.status !== 'pending')) clashes.set(it.id, o);
        }
      }
    }
    const qq = $('#ed-q').value.trim().toLowerCase();
    $('#ed-items').innerHTML = pickable
      .filter(e => !qq || chosen.has(e.id) || [e.name, e.asset_tag, catName(e.category_id)].some(x => (x || '').toLowerCase().includes(qq)))
      .map(e => {
        const c = clashes.get(e.id);
        const flag = c ? (c.status === 'pending'
            ? `<span class="soft">requested in ${esc(c.ref)}</span>`
            : `<span class="clash">booked in ${esc(c.ref)}</span>`)
          : e.status !== 'available' ? `<span class="soft">${e.status === 'maintenance' ? 'in maintenance' : 'retired'}</span>` : '';
        return `<label><input type="checkbox" value="${e.id}" ${chosen.has(e.id) ? 'checked' : ''}> ${assetTag(e.asset_tag)} ${esc(e.name)} ${flag}</label>`;
      }).join('') || '<div class="empty">No items match.</div>';
  }
  $('#ed-items').onchange = e => { const id = Number(e.target.value); e.target.checked ? chosen.add(id) : chosen.delete(id); };
  $('#ed-q').oninput = drawPicker;
  $('#ed-start').onchange = () => {
    const ns = fromLocalInput($('#ed-start').value);
    const len = end - start;
    if (ns && !b) $('#ed-end').value = toLocalInput(new Date(ns.getTime() + len));
    drawPicker();
  };
  $('#ed-end').onchange = drawPicker;
  await drawPicker();

  $('#ed-form').onsubmit = async ev => {
    ev.preventDefault();
    const s = fromLocalInput($('#ed-start').value), e = fromLocalInput($('#ed-end').value);
    const fail = m => { $('#ed-error').innerHTML = `<div class="notice notice--error">${esc(m)}</div>`; dlg.querySelector('.dlg-body').scrollTop = 0; };
    if (!s || !e || e <= s) return fail('The return time must be after the pick-up time.');
    if (!chosen.size) return fail('Choose at least one item.');
    if (!$('#ed-name').value.trim() || !$('#ed-email').value.trim()) return fail('Name and email are required.');
    const { data, error } = await sb.rpc('admin_save_booking', {
      p_id: b?.id ?? null, p_name: $('#ed-name').value, p_email: $('#ed-email').value,
      p_student_id: $('#ed-sid').value, p_phone: $('#ed-phone').value, p_course: $('#ed-course').value,
      p_purpose: $('#ed-purpose').value, p_starts: s.toISOString(), p_ends: e.toISOString(),
      p_items: [...chosen], p_status: b ? null : $('#ed-status').value, p_internal_note: $('#ed-internal').value,
    });
    if (error) return fail(errMsg(error));
    dlg.close();
    toast(b ? 'Booking updated' : 'Booking created');
    await refreshAll();
    openBooking(data);
  };
  if (!dlg.open) dlg.showModal();
}

// ================================================================== Calendar
async function renderCalendar(v) {
  const from = A.calFrom, days = A.calDays;
  const to = new Date(from.getTime() + days * DAY);
  const span = to - from;
  const bookings = await q(sb.from('booking_overview').select('*')
    .in('status', ['pending', 'approved', 'checked_out', 'returned'])
    .lt('starts_at', to.toISOString()).gt('ends_at', from.toISOString()));
  // overdue bookings stay on the chart until returned
  for (const b of A.active) if (b.is_overdue && !bookings.some(x => x.id === b.id)) bookings.push(b);

  const cats = [{ id: null, name: 'Uncategorised', sort_order: 9999 }, ...A.categories];
  const eq = A.equipment.filter(e => e.status !== 'retired' && (A.calCat === 'all' || String(e.category_id) === A.calCat));

  const pct = t => Math.max(0, Math.min(100, (t - from) / span * 100));
  const now = Date.now();

  const barsFor = item => {
    const mine = bookings.filter(b => b.items.some(i => i.id === item.id))
      .map(b => ({
        b,
        s: new Date(b.starts_at).getTime(),
        e: b.is_overdue ? Math.max(now, new Date(b.ends_at).getTime())
          : b.status === 'returned' && b.returned_at ? Math.max(new Date(b.ends_at), new Date(b.returned_at))
          : new Date(b.ends_at).getTime(),
      }))
      .sort((x, y) => x.s - y.s);
    const lanes = [];
    for (const m of mine) {
      let l = lanes.findIndex(end => end <= m.s);
      if (l < 0) { l = lanes.length; lanes.push(0); }
      lanes[l] = m.e; m.lane = l;
    }
    const html = mine.map(({ b, s, e, lane }) => {
      const left = pct(s), right = pct(e);
      const k = statusKey(b);
      return `<button class="bar bar--${k}" data-bk="${b.id}" style="left:${left}%;width:max(1.2rem,${right - left}%);top:${.45 + lane * 1.85}rem"
        title="${esc(`${b.ref} · ${b.borrower_name} · ${fmtRange(b.starts_at, b.ends_at)} · ${STATUS[k].short}`)}">${esc(b.borrower_name)}</button>`;
    }).join('');
    return { html, height: Math.max(1, lanes.length) * 1.85 + .55 };
  };

  const head = Array.from({ length: days }, (_, k) => {
    const d = new Date(from.getTime() + k * DAY);
    return `<span class="${sameDay(d, new Date()) ? 'is-today' : ''}">${esc(new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(d))}<b>${d.getDate()}</b></span>`;
  }).join('');
  const weekends = Array.from({ length: days }, (_, k) => {
    const d = new Date(from.getTime() + k * DAY);
    return [0, 6].includes(d.getDay()) ? `<span class="wknd" style="left:${k / days * 100}%;width:${100 / days}%"></span>` : '';
  }).join('');
  const nowLine = now > from && now < to ? `<span class="now-line" style="left:${pct(now)}%"></span>` : '';

  const rows = cats.map(c => {
    const list = eq.filter(e => (e.category_id ?? null) === c.id);
    if (!list.length) return '';
    return `<div class="cal-row cal-group"><div class="cal-label">${esc(c.name)}</div><div class="cal-track"></div></div>` +
      list.map(e => {
        const { html, height } = barsFor(e);
        return `<div class="cal-row"><div class="cal-label"><span class="n">${esc(e.name)}</span>${assetTag(e.asset_tag)}</div>
          <div class="cal-track" style="min-height:${height}rem">${weekends}${nowLine}${html}</div></div>`;
      }).join('');
  }).join('');

  v.innerHTML = `
    <div class="view-head">
      <h1>Calendar</h1>
      <button class="btn btn--primary" data-new>New booking</button>
    </div>
    <div class="toolbar">
      <button class="btn" data-cal="-7" aria-label="Previous week">Previous</button>
      <button class="btn" data-cal="today">Today</button>
      <button class="btn" data-cal="7" aria-label="Next week">Next</button>
      <strong style="margin:0 .5rem">${esc(fmtDateYear(from))} – ${esc(fmtDateYear(new Date(to.getTime() - 1)))}</strong>
      <select id="cal-days" aria-label="Range">
        ${[7, 14, 28].map(n => `<option value="${n}" ${n === days ? 'selected' : ''}>${n} days</option>`).join('')}
      </select>
      <select id="cal-cat" aria-label="Category">
        <option value="all">All categories</option>
        ${A.categories.map(c => `<option value="${c.id}" ${String(c.id) === A.calCat ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
      </select>
    </div>
    <div class="cal" style="--days:${days}"><div class="cal-grid">
      <div class="cal-row cal-head"><div class="cal-label"></div><div class="cal-track">${head}</div></div>
      ${rows || '<div class="empty">No equipment yet.</div>'}
    </div></div>
    <div class="cal-legend">
      <span><i class="bar bar--pending"></i>Waiting for approval</span>
      <span><i class="bar bar--approved"></i>Approved</span>
      <span><i class="bar bar--checked_out"></i>Out</span>
      <span><i class="bar bar--overdue"></i>Overdue</span>
      <span><i class="bar bar--returned"></i>Returned</span>
    </div>`;

  v.querySelector('.toolbar').addEventListener('click', e => {
    const b = e.target.closest('[data-cal]');
    if (!b) return;
    A.calFrom = b.dataset.cal === 'today' ? startOfDay(new Date(Date.now() - 2 * DAY))
      : new Date(A.calFrom.getTime() + Number(b.dataset.cal) * DAY);
    renderCalendar(v);
  });
  $('#cal-days').onchange = e => { A.calDays = Number(e.target.value); renderCalendar(v); };
  $('#cal-cat').onchange = e => { A.calCat = e.target.value; renderCalendar(v); };
}

// ================================================================== Equipment
async function renderEquipment(v) {
  const nowOut = new Map();
  for (const b of A.active) {
    if (b.status !== 'checked_out') continue;
    for (const i of b.items) nowOut.set(i.id, b);
  }
  const nextUp = new Map();
  for (const b of A.active) {
    if (b.status !== 'approved') continue;
    for (const i of b.items) if (!nextUp.has(i.id)) nextUp.set(i.id, b);
  }

  v.innerHTML = `
    <div class="view-head">
      <h1>Equipment</h1>
      <button class="btn btn--primary" id="eq-add">Add item</button>
    </div>
    <div class="toolbar">
      <input type="search" id="eq-q" placeholder="Search name, asset number, location" value="${esc(A.eqQ)}" aria-label="Search equipment">
      <select id="eq-filter" aria-label="Show">
        <option value="active">In use (not retired)</option>
        <option value="maintenance">In maintenance</option>
        <option value="hidden">Hidden from students</option>
        <option value="retired">Retired</option>
        <option value="all">Everything</option>
      </select>
    </div>
    <div id="eq-table"></div>
    <section class="cats-panel">
      <h2 style="margin-bottom:.5rem">Categories</h2>
      <p class="muted small">Categories group items on the student page. Lower numbers come first.</p>
      <ul id="cat-list"></ul>
      <form class="row" id="cat-add" style="align-items:flex-end">
        <div class="field" style="margin:0"><label for="cat-new">New category</label><input type="text" id="cat-new"></div>
        <button class="btn" type="submit">Add category</button>
      </form>
    </section>`;
  $('#eq-filter').value = A.eqStatus;

  const draw = () => {
    const qq = A.eqQ.trim().toLowerCase();
    const list = A.equipment.filter(e => {
      const f = A.eqStatus;
      if (f === 'active' && e.status === 'retired') return false;
      if (f === 'maintenance' && e.status !== 'maintenance') return false;
      if (f === 'hidden' && (e.bookable || e.status === 'retired')) return false;
      if (f === 'retired' && e.status !== 'retired') return false;
      return !qq || [e.name, e.asset_tag, e.location, e.serial_number, catName(e.category_id)].some(x => (x || '').toLowerCase().includes(qq));
    });
    $('#eq-table').innerHTML = list.length ? `<div class="table-wrap"><table>
      <thead><tr><th></th><th>Item</th><th>Category</th><th>Kept at</th><th>Right now</th></tr></thead>
      <tbody>${list.map(e => {
        const out = nowOut.get(e.id), nx = nextUp.get(e.id);
        const now = e.status === 'retired' ? '<span class="st-retired">Retired</span>'
          : e.status === 'maintenance' ? '<span class="st-maint">In maintenance</span>'
          : out ? `${badge(out)} <span class="sub">${esc(out.borrower_name)}, back ${esc(fmtDate(out.ends_at))}</span>`
          : `In stock${nx ? `<span class="sub">Next out ${esc(fmtDate(nx.starts_at))}</span>` : ''}`;
        return `<tr data-eq="${e.id}">
          <td style="width:3.5rem">${e.image_url ? `<img class="eq-thumb" src="${esc(e.image_url)}" alt="">` : '<span class="eq-thumb" style="display:block"></span>'}</td>
          <td><strong>${esc(e.name)}</strong> ${assetTag(e.asset_tag)}${!e.bookable && e.status !== 'retired' ? '<span class="sub">Hidden from students</span>' : ''}</td>
          <td>${esc(catName(e.category_id))}</td>
          <td>${esc(e.location || '')}</td>
          <td>${now}</td>
        </tr>`;
      }).join('')}</tbody></table></div>`
      : `<div class="empty">${A.equipment.length ? 'No items match.' : 'No equipment yet. Add your first item to start taking bookings.'}</div>`;
  };
  draw();

  $('#eq-q').addEventListener('input', e => { A.eqQ = e.target.value; draw(); });
  $('#eq-filter').addEventListener('change', e => { A.eqStatus = e.target.value; draw(); });
  $('#eq-add').addEventListener('click', () => openEquipment(null));
  $('#eq-table').addEventListener('click', e => { const r = e.target.closest('[data-eq]'); if (r) openEquipment(Number(r.dataset.eq)); });

  drawCategories();
  $('#cat-add').addEventListener('submit', async e => {
    e.preventDefault();
    const name = $('#cat-new').value.trim();
    if (!name) return;
    const max = Math.max(0, ...A.categories.map(c => c.sort_order));
    await q(sb.from('categories').insert({ name, sort_order: max + 1 }));
    $('#cat-new').value = '';
    await loadRefs(); drawCategories(); toast('Category added');
  });
}

function drawCategories() {
  const ul = $('#cat-list');
  if (!ul) return;
  ul.innerHTML = A.categories.map(c => `<li data-cat="${c.id}">
      <input type="number" value="${c.sort_order}" aria-label="Order for ${esc(c.name)}">
      <input type="text" value="${esc(c.name)}" aria-label="Name">
      <span class="small muted">${A.equipment.filter(e => e.category_id === c.id).length} items</span>
      <button type="button" class="btn btn--small btn--ghost" data-del aria-label="Delete ${esc(c.name)}">Delete</button>
    </li>`).join('') || '<li class="muted">No categories yet.</li>';
  ul.onchange = async e => {
    const li = e.target.closest('[data-cat]');
    if (!li) return;
    const [ord, name] = li.querySelectorAll('input');
    if (!name.value.trim()) return;
    await q(sb.from('categories').update({ name: name.value.trim(), sort_order: Number(ord.value) || 0 }).eq('id', Number(li.dataset.cat)));
    await loadRefs(); toast('Category saved');
  };
  ul.onclick = async e => {
    if (!e.target.closest('[data-del]')) return;
    const id = Number(e.target.closest('[data-cat]').dataset.cat);
    if (!confirm('Delete this category? Its items become uncategorised.')) return;
    await q(sb.from('categories').delete().eq('id', id));
    await loadRefs(); drawCategories(); toast('Category deleted');
  };
}

async function openEquipment(id) {
  const e = id ? A.equipment.find(x => x.id === id) : null;
  const dlg = $('#dlg-eq');
  $('#eq-error').innerHTML = '';
  $('#eq-title').textContent = e ? 'Edit item' : 'Add item';
  $('#eq-cat').innerHTML = `<option value="">No category</option>` + A.categories.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  $('#eq-name').value = e?.name || '';
  $('#eq-tag').value = e?.asset_tag || '';
  $('#eq-cat').value = e?.category_id ?? '';
  $('#eq-loc').value = e?.location || '';
  $('#eq-desc').value = e?.description || '';
  $('#eq-status').value = e?.status || 'available';
  $('#eq-serial').value = e?.serial_number || '';
  $('#eq-bookable').checked = e ? e.bookable : true;
  $('#eq-img').value = e?.image_url || '';
  $('#eq-notes').value = e?.notes || '';
  $('#eq-delete').classList.toggle('hidden', !e);
  $('#eq-copy').classList.toggle('hidden', !e);
  const preview = () => { const u = $('#eq-img').value.trim(); $('#eq-img-preview').classList.toggle('hidden', !u); if (u) $('#eq-img-preview').src = u; };
  preview();
  $('#eq-img').oninput = preview;
  $('#eq-img-clear').onclick = () => { $('#eq-img').value = ''; preview(); };
  $('#eq-file').value = '';
  $('#eq-file').onchange = async () => {
    const f = $('#eq-file').files[0];
    if (!f) return;
    if (f.size > 5e6) { toast('Choose an image under 5 MB.', 'error'); return; }
    const path = `${Date.now()}-${f.name.toLowerCase().replace(/[^a-z0-9.]+/g, '-')}`;
    toast('Uploading…');
    const { error } = await sb.storage.from('equipment-images').upload(path, f, { contentType: f.type, upsert: false });
    if (error) { toast(`Upload failed: ${errMsg(error)}`, 'error'); return; }
    $('#eq-img').value = sb.storage.from('equipment-images').getPublicUrl(path).data.publicUrl;
    preview();
    toast('Photo uploaded. Save the item to keep it.');
  };

  // booking history
  $('#eq-history').innerHTML = '';
  if (e) {
    const links = await q(sb.from('booking_items').select('booking_id').eq('equipment_id', e.id));
    const mine = links.length ? await q(sb.from('booking_overview').select('id,ref,status,is_overdue,borrower_name,starts_at,ends_at')
      .in('id', links.map(l => l.booking_id)).order('starts_at', { ascending: false }).limit(8)) : [];
    $('#eq-history').innerHTML = mine.length ? `<h3 style="margin:1rem 0 .4rem">Recent bookings</h3>
      <ul class="blist">${mine.map(b => `<li data-bk="${b.id}"><div><div class="who">${esc(b.borrower_name)} ${badge(b)}</div>
        <div class="when">${esc(fmtRange(b.starts_at, b.ends_at))}</div></div><div class="acts">${assetTag(b.ref)}</div></li>`).join('')}</ul>` : '';
    $('#eq-history').onclick = ev => { const r = ev.target.closest('[data-bk]'); if (r) { dlg.close(); openBooking(Number(r.dataset.bk)); } };
  }

  const values = () => ({
    name: $('#eq-name').value.trim(),
    asset_tag: $('#eq-tag').value.trim() || null,
    category_id: $('#eq-cat').value ? Number($('#eq-cat').value) : null,
    location: $('#eq-loc').value.trim() || null,
    description: $('#eq-desc').value.trim() || null,
    status: $('#eq-status').value,
    serial_number: $('#eq-serial').value.trim() || null,
    bookable: $('#eq-bookable').checked,
    image_url: $('#eq-img').value.trim() || null,
    notes: $('#eq-notes').value.trim() || null,
  });
  const fail = m => { $('#eq-error').innerHTML = `<div class="notice notice--error">${esc(m)}</div>`; dlg.querySelector('.dlg-body').scrollTop = 0; };

  $('#eq-form').onsubmit = async ev => {
    ev.preventDefault();
    const val = values();
    if (!val.name) return fail('Give the item a name.');
    const { error } = e ? await sb.from('equipment').update(val).eq('id', e.id) : await sb.from('equipment').insert(val);
    if (error) return fail(errMsg(error));
    dlg.close(); toast(e ? 'Item saved' : 'Item added');
    await loadRefs(); render(false);
  };
  $('#eq-copy').onclick = async () => {
    const val = values();
    val.name = val.name.replace(/#(\d+)\s*$/, (_, n) => `#${Number(n) + 1}`);
    if (val.name === values().name) val.name += ' (copy)';
    val.asset_tag = null; val.serial_number = null;
    const { data, error } = await sb.from('equipment').insert(val).select().single();
    if (error) return fail(errMsg(error));
    toast('Copy created. Give it its own asset number.');
    await loadRefs(); render(false);
    openEquipment(data.id);
  };
  $('#eq-delete').onclick = async () => {
    if (!confirm(`Delete "${e.name}" permanently? If it has ever been booked, set it to Retired instead.`)) return;
    const { error } = await sb.from('equipment').delete().eq('id', e.id);
    if (error) return fail(error.code === '23503' ? 'This item has bookings on record, so it can\'t be deleted. Set its condition to Retired instead — it will disappear from the student page.' : errMsg(error));
    dlg.close(); toast('Item deleted');
    await loadRefs(); render(false);
  };
  if (!dlg.open) dlg.showModal();
}

// ================================================================== Settings
function renderSettings(v) {
  const s = A.settings;
  v.innerHTML = `
    <div class="view-head"><h1>Settings</h1></div>
    <form class="settings" id="set-form" novalidate>
      <fieldset class="card-ish">
        <legend>Student booking page</legend>
        <div class="field">
          <label for="s-link">Link to share with students</label>
          <div class="copy-row"><input type="url" id="s-link" readonly value="${esc(publicUrl())}"><button type="button" class="btn" id="s-copy">Copy</button></div>
        </div>
        <div class="field"><label for="s-org">Name shown at the top</label><input type="text" id="s-org" value="${esc(s.org_name)}"></div>
        <div class="field"><label for="s-contact">Contact email for questions</label><input type="email" id="s-contact" value="${esc(s.contact_email || '')}"></div>
        <div class="field"><label for="s-notice">Conditions of loan</label><textarea id="s-notice" rows="5" placeholder="Students must tick to agree before sending. Leave empty to skip.">${esc(s.booking_notice || '')}</textarea></div>
        <div class="field"><label for="s-pickup">Pick-up instructions</label><textarea id="s-pickup" rows="3" placeholder="Where and when to collect. Shown after booking and once approved.">${esc(s.pickup_info || '')}</textarea></div>
      </fieldset>

      <fieldset class="card-ish">
        <legend>Booking rules</legend>
        <div class="row">
          <div class="field"><label for="s-notice-h">Minimum notice (hours)</label><input type="number" min="0" id="s-notice-h" value="${s.min_notice_hours}"></div>
          <div class="field"><label for="s-max-days">Longest loan (days)</label><input type="number" min="1" id="s-max-days" value="${s.max_days}"></div>
        </div>
        <div class="row">
          <div class="field"><label for="s-max-items">Items per request</label><input type="number" min="1" id="s-max-items" value="${s.max_items}"></div>
          <div class="field"><label for="s-max-pending">Open requests per email</label><input type="number" min="1" id="s-max-pending" value="${s.max_pending_per_email}">
            <div class="hint">Stops one person flooding the queue.</div></div>
        </div>
        <div class="field"><label for="s-domains">Allowed email domains</label><input type="text" id="s-domains" value="${esc((s.allowed_email_domains || []).join(', '))}" placeholder="e.g. maastrichtuniversity.nl, student.maastrichtuniversity.nl">
          <div class="hint">Comma-separated. Subdomains are included. Leave empty to accept any address.</div></div>
        <div class="row">
          <div class="field"><label for="s-sid-label">Name of the ID field</label><input type="text" id="s-sid-label" value="${esc(s.student_id_label)}"></div>
          <div class="field" style="align-self:end"><label class="check"><input type="checkbox" id="s-sid-req" ${s.require_student_id ? 'checked' : ''}> Required</label></div>
        </div>
        <label class="check"><input type="checkbox" id="s-auto" ${s.auto_approve ? 'checked' : ''}> Approve requests automatically when the items are free</label>
      </fieldset>
      <button class="btn btn--primary" type="submit">Save settings</button>
    </form>

    <section class="settings" style="margin-top:2.5rem">
      <h2 style="margin-bottom:.5rem">Admins</h2>
      <div id="admin-list" class="muted">Loading…</div>
      <p class="small muted" style="margin-top:.75rem">To add someone: create their login in Supabase (Authentication → Users → Add user), then run the
      "Add another admin" SQL from the README with their email.</p>
    </section>`;

  $('#s-copy').onclick = () => { navigator.clipboard?.writeText(publicUrl()).then(() => toast('Link copied')); };
  sb.from('admins').select('email,created_at').order('created_at').then(({ data }) => {
    $('#admin-list').innerHTML = (data || []).map(a => `<div>${esc(a.email || '(no email recorded)')}</div>`).join('');
  });

  $('#set-form').onsubmit = async e => {
    e.preventDefault();
    const num = (id, min) => Math.max(min, parseInt($(id).value, 10) || min);
    const val = {
      org_name: $('#s-org').value.trim() || 'Equipment loans',
      contact_email: $('#s-contact').value.trim() || null,
      booking_notice: $('#s-notice').value.trim() || null,
      pickup_info: $('#s-pickup').value.trim() || null,
      min_notice_hours: num('#s-notice-h', 0),
      max_days: num('#s-max-days', 1),
      max_items: num('#s-max-items', 1),
      max_pending_per_email: num('#s-max-pending', 1),
      allowed_email_domains: $('#s-domains').value.split(/[,\s]+/).map(d => d.trim().replace(/^@/, '').toLowerCase()).filter(Boolean),
      student_id_label: $('#s-sid-label').value.trim() || 'Student number',
      require_student_id: $('#s-sid-req').checked,
      auto_approve: $('#s-auto').checked,
    };
    await q(sb.from('settings').update(val).eq('id', 1));
    await loadRefs();
    toast('Settings saved');
  };
}
