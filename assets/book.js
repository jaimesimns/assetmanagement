import {
  makeClient, configured, $, $$, esc, escLines, fmtDateTime, fmtRange, fmtDate, toLocalInput,
  fromLocalInput, overlaps, humanDuration, badge, assetTag, errMsg, toast, notConfiguredHTML,
  safeStorage, STATUS,
} from './common.js';

const sb = makeClient(false);
const store = safeStorage();
const DAY = 864e5;

const state = {
  settings: null,
  items: [],          // catalogue
  avail: [],          // busy windows
  availFrom: null,
  availTo: null,
  start: null,
  end: null,
  basket: new Set(),
  q: '',
  cat: 'all',
  onlyFree: false,
  sending: false,
};

const ICON_BOX = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5 12 12l9-4.5M12 12v9"/></svg>`;

// ------------------------------------------------------------------ boot
init();

async function init() {
  if (!configured) {
    $('#boot').outerHTML = notConfiguredHTML();
    return;
  }
  try {
    const [s, c] = await Promise.all([sb.rpc('get_public_settings'), sb.rpc('get_catalogue')]);
    if (s.error) throw s.error;
    if (c.error) throw c.error;
    state.settings = s.data;
    state.items = c.data || [];
  } catch (e) {
    $('#boot').innerHTML = `<div class="notice notice--error">Couldn't load the equipment list. ${esc(errMsg(e))}</div>`;
    return;
  }

  const org = state.settings.org_name || 'Equipment loans';
  $('#brand').textContent = org;
  document.title = `Book equipment · ${org}`;

  setDefaultWindow();
  await loadAvailability();
  $('#boot').remove();

  wireBooking();
  wireRequestDialog();
  wireCheck();
  window.addEventListener('hashchange', route);
  route();
}

function route() {
  const h = location.hash;
  const show = id => ['view-book', 'view-done', 'view-check'].forEach(v => $('#' + v).classList.toggle('hidden', v !== id));
  if (h.startsWith('#check')) {
    show('view-check');
    const ref = decodeURIComponent(h.split('/')[1] || '');
    if (ref) $('#check-ref').value = ref;
    renderRecent();
    $('#nav-check').classList.add('hidden');
  } else if (h === '#sent' && state.lastDone) {
    show('view-done');
    $('#nav-check').classList.remove('hidden');
  } else {
    show('view-book');
    $('#nav-check').classList.remove('hidden');
    renderAll();
  }
  window.scrollTo(0, 0);
}

// ------------------------------------------------------------------ dates
function setDefaultWindow() {
  const s = state.settings;
  const earliest = new Date(Date.now() + (s.min_notice_hours || 0) * 36e5);
  const start = new Date(earliest);
  start.setMinutes(0, 0, 0);
  // next 10:00 at or after the earliest allowed moment
  if (start < earliest) start.setHours(start.getHours() + 1);
  if (start.getHours() > 10) start.setDate(start.getDate() + 1);
  start.setHours(10, 0, 0, 0);
  if (start < earliest) start.setDate(start.getDate() + 1);
  const end = new Date(start);
  end.setDate(end.getDate() + Math.min(2, s.max_days || 2));
  end.setHours(16, 0, 0, 0);
  state.start = start; state.end = end;
  $('#start').value = toLocalInput(start);
  $('#end').value = toLocalInput(end);
  $('#start').min = toLocalInput(earliest);
}

function windowProblem() {
  const s = state.settings, a = state.start, b = state.end;
  if (!a || !b || isNaN(a) || isNaN(b)) return 'Choose a pick-up and return time.';
  if (b <= a) return 'The return time needs to be after the pick-up time.';
  if (a < new Date(Date.now() + s.min_notice_hours * 36e5 - 6e4))
    return `Pick-up needs to be at least ${s.min_notice_hours} hours from now.`;
  if (b - a > s.max_days * DAY) return `Loans can last up to ${s.max_days} days.`;
  return null;
}

function rulesText() {
  const s = state.settings;
  const parts = [];
  if (s.min_notice_hours) parts.push(`at least ${s.min_notice_hours} hours' notice`);
  parts.push(`up to ${s.max_days} days`);
  return `Bookings need ${parts.join(' and can last ')}.`;
}

async function loadAvailability() {
  const from = new Date(Date.now() - DAY);
  const to = new Date(Math.max(Date.now() + 120 * DAY, (state.end?.getTime() || 0) + 30 * DAY));
  const { data, error } = await sb.rpc('get_availability', { p_from: from.toISOString(), p_to: to.toISOString() });
  if (error) { toast(errMsg(error), 'error'); return; }
  state.avail = data || [];
  state.availFrom = from; state.availTo = to;
}

// ------------------------------------------------------------------ availability per item
function itemState(item) {
  if (item.status === 'maintenance') return { key: 'maint', label: 'In maintenance', can: false };
  const problem = windowProblem();
  const rows = state.avail.filter(a => a.equipment_id === item.id);
  if (problem) return { key: 'invalid', label: 'Pick valid dates first', can: false, quiet: true };
  const booked = rows.find(a => a.kind === 'booked' && overlaps(state.start, state.end, a.starts_at, a.ends_at));
  if (booked) return { key: 'booked', label: `Booked ${fmtRange(booked.starts_at, booked.ends_at)}`, can: false };
  if (rows.some(a => a.kind === 'overdue'))
    return { key: 'overdue', label: 'Out at the moment and overdue, so it may not be back in time', can: true };
  if (rows.some(a => a.kind === 'requested' && overlaps(state.start, state.end, a.starts_at, a.ends_at)))
    return { key: 'requested', label: 'Free, but someone else has also asked for it', can: true };
  return { key: 'free', label: 'Free for these dates', can: true };
}

// ------------------------------------------------------------------ booking view
function wireBooking() {
  const onDates = async () => {
    state.start = fromLocalInput($('#start').value);
    state.end = fromLocalInput($('#end').value);
    if (state.end && state.availTo && state.end > state.availTo) await loadAvailability();
    renderAll();
  };
  $('#start').addEventListener('change', () => {
    // keep the same loan length when the pick-up moves
    const prevLen = state.end && state.start ? state.end - state.start : 2 * DAY;
    const ns = fromLocalInput($('#start').value);
    if (ns && !isNaN(ns) && prevLen > 0) $('#end').value = toLocalInput(new Date(ns.getTime() + prevLen));
    onDates();
  });
  $('#end').addEventListener('change', onDates);
  $('#q').addEventListener('input', e => { state.q = e.target.value.trim().toLowerCase(); renderItems(); });
  $('#only-free').addEventListener('change', e => { state.onlyFree = e.target.checked; renderItems(); });

  $('#items').addEventListener('click', e => {
    const add = e.target.closest('[data-add]');
    const open = e.target.closest('[data-open]');
    if (add) toggleBasket(Number(add.dataset.add));
    else if (open) openItem(Number(open.dataset.open));
  });
  $('#basket-list').addEventListener('click', e => {
    const rm = e.target.closest('[data-rm]');
    if (rm) toggleBasket(Number(rm.dataset.rm));
  });
  $('#btn-review').addEventListener('click', openRequest);
  $('#btn-review-bar').addEventListener('click', openRequest);

  const cats = [...new Map(state.items.map(i => [i.category || 'Other', i.category_sort])).entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([n]) => n);
  $('#cats').innerHTML = ['all', ...cats].map(c =>
    `<button type="button" class="chip" data-cat="${esc(c)}" aria-pressed="${c === 'all'}">${c === 'all' ? 'Everything' : esc(c)}</button>`).join('');
  $('#cats').classList.toggle('hidden', cats.length < 2);
  $('#cats').addEventListener('click', e => {
    const b = e.target.closest('[data-cat]');
    if (!b) return;
    state.cat = b.dataset.cat;
    $$('#cats .chip').forEach(c => c.setAttribute('aria-pressed', String(c === b)));
    renderItems();
  });
}

function toggleBasket(id) {
  const max = state.settings.max_items;
  if (state.basket.has(id)) state.basket.delete(id);
  else {
    if (state.basket.size >= max) { toast(`You can request up to ${max} items at once.`, 'error'); return; }
    state.basket.add(id);
  }
  renderItems();
  renderBasket();
}

function renderAll() {
  const problem = windowProblem();
  const hint = $('#when-hint');
  hint.classList.toggle('is-error', !!problem);
  hint.textContent = problem || `${humanDuration(state.start, state.end)}. ${rulesText()}`;
  renderItems();
  renderBasket();
}

function renderItems() {
  const q = state.q;
  const visible = state.items.filter(i =>
    (state.cat === 'all' || (i.category || 'Other') === state.cat) &&
    (!q || [i.name, i.description, i.asset_tag, i.category].some(v => (v || '').toLowerCase().includes(q))));

  const groups = new Map();
  for (const i of visible) {
    const st = itemState(i);
    if (state.onlyFree && !st.can) continue;
    const g = i.category || 'Other';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push([i, st]);
  }

  if (!groups.size) {
    $('#items').innerHTML = `<div class="empty">${state.items.length
      ? 'Nothing matches. Try another search or category, or other dates.'
      : 'There is no equipment to book yet.'}</div>`;
    return;
  }

  $('#items').innerHTML = [...groups].map(([g, list]) => `
    <section class="cat-group">
      ${groups.size > 1 || state.cat === 'all' ? `<h2>${esc(g)}</h2>` : ''}
      <ul class="items">
        ${list.map(([i, st]) => {
          const sel = state.basket.has(i.id);
          return `<li class="item${sel ? ' is-selected' : ''}${st.can ? '' : ' is-blocked'}">
            ${i.image_url ? `<img class="thumb" src="${esc(i.image_url)}" alt="" loading="lazy">`
                          : `<span class="thumb thumb--empty">${ICON_BOX}</span>`}
            <div class="item-main">
              <div class="item-top">
                <button type="button" class="item-name" data-open="${i.id}">${esc(i.name)}</button>
                ${assetTag(i.asset_tag)}
              </div>
              ${i.description ? `<p class="item-desc">${esc(i.description)}</p>` : ''}
              ${st.quiet ? '' : `<div class="avail avail--${st.key}">${esc(st.label)}</div>`}
            </div>
            <div class="item-act">
              ${sel
                ? `<button type="button" class="btn btn--small btn--block" data-add="${i.id}" aria-label="Remove ${esc(i.name)}">Remove</button>`
                : `<button type="button" class="btn btn--small btn--block" data-add="${i.id}" ${st.can ? '' : 'disabled'} aria-label="Add ${esc(i.name)}">Add</button>`}
            </div>
          </li>`;
        }).join('')}
      </ul>
    </section>`).join('');
}

function basketProblems() {
  const out = {};
  for (const id of state.basket) {
    const it = state.items.find(i => i.id === id);
    if (!it) continue;
    const st = itemState(it);
    if (!st.can && st.key !== 'invalid') out[id] = st.label;
  }
  return out;
}

function renderBasket() {
  const n = state.basket.size;
  const problems = basketProblems();
  const ids = [...state.basket];
  const windowOk = !windowProblem();
  $('#basket-list').innerHTML = n
    ? `${windowOk ? `<div class="basket-when">${esc(fmtRange(state.start, state.end))}</div>` : ''}
       <ul class="basket-items">${ids.map(id => {
         const it = state.items.find(i => i.id === id);
         return `<li><span class="name">${esc(it?.name || 'Item')}${problems[id] ? `<span class="warn">${esc(problems[id])}</span>` : ''}</span>
           <button type="button" class="rm" data-rm="${id}" aria-label="Remove ${esc(it?.name)}">×</button></li>`;
       }).join('')}</ul>`
    : `<p class="basket-empty">Add the items you'd like to borrow. You can request several at once.</p>`;
  const blocked = !n || !windowOk || Object.keys(problems).length > 0;
  $('#btn-review').disabled = blocked;
  $('#btn-review-bar').disabled = blocked;
  $('#basket-bar').hidden = n === 0;
  $('#basket-bar-count').textContent = `${n} item${n === 1 ? '' : 's'}`;
}

// ------------------------------------------------------------------ item dialog
function openItem(id) {
  const it = state.items.find(i => i.id === id);
  if (!it) return;
  const st = itemState(it);
  const rows = state.avail.filter(a => a.equipment_id === id);
  $('#item-title').textContent = it.name;

  // 28-day strip from today
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Array.from({ length: 28 }, (_, k) => new Date(today.getTime() + k * DAY));
  const dayState = d => {
    const e = new Date(d.getTime() + DAY);
    if (rows.some(a => (a.kind === 'booked' && overlaps(d, e, a.starts_at, a.ends_at)) || (a.kind === 'overdue' && k0(d))))
      return 'booked';
    if (rows.some(a => a.kind === 'requested' && overlaps(d, e, a.starts_at, a.ends_at))) return 'requested';
    return 'free';
  };
  const k0 = d => d.getTime() === today.getTime();
  const inSel = d => state.start && state.end && overlaps(d, new Date(d.getTime() + DAY), state.start, state.end);
  const upcoming = rows.filter(a => a.kind !== 'requested' && (a.ends_at === null || new Date(a.ends_at) > new Date()))
    .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at)).slice(0, 6);

  $('#item-body').innerHTML = `
    ${it.image_url ? `<img class="item-hero" src="${esc(it.image_url)}" alt="">` : ''}
    <dl class="meta">
      ${it.asset_tag ? `<dt>Asset number</dt><dd>${assetTag(it.asset_tag)}</dd>` : ''}
      ${it.category ? `<dt>Category</dt><dd>${esc(it.category)}</dd>` : ''}
      ${it.location ? `<dt>Kept at</dt><dd>${esc(it.location)}</dd>` : ''}
    </dl>
    ${it.description ? `<p>${escLines(it.description)}</p>` : ''}
    ${st.quiet ? '' : `<div class="avail avail--${st.key}">${esc(st.label)}</div>`}
    <div class="strip-head"><h3>Next four weeks</h3><span class="small muted">${esc(fmtDate(days[0]))} – ${esc(fmtDate(days[27]))}</span></div>
    <div class="strip">${days.map(d => {
      const s = dayState(d);
      return `<span class="day day--${s}${inSel(d) ? ' day--sel' : ''}" title="${esc(fmtDate(d))}: ${s}">${d.getDate()}</span>`;
    }).join('')}</div>
    <div class="legend"><span><i style="background:var(--approved-bg)"></i>Free</span><span><i style="background:var(--overdue-bg)"></i>Booked</span><span><i style="background:var(--pending-bg)"></i>Requested by someone</span><span><i style="outline:2px solid var(--accent)"></i>Your dates</span></div>
    ${upcoming.length ? `<h3 style="margin-top:1.25rem">Already booked</h3><ul class="upcoming">${upcoming.map(a =>
      `<li>${a.kind === 'overdue' ? 'Out now, return overdue' : esc(fmtRange(a.starts_at, a.ends_at))}</li>`).join('')}</ul>` : ''}`;

  const add = $('#item-add');
  const sel = state.basket.has(id);
  add.textContent = sel ? 'Remove from request' : 'Add to request';
  add.disabled = !sel && !st.can;
  add.onclick = () => { toggleBasket(id); $('#dlg-item').close(); };
  $('#dlg-item').showModal();
}

// ------------------------------------------------------------------ request dialog
function wireRequestDialog() {
  $$('dialog [data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
  $$('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close(); }));

  const s = state.settings;
  $('#f-sid-label').textContent = s.student_id_label || 'Student number';
  $('#f-sid-label').classList.toggle('req', !!s.require_student_id);
  if (s.allowed_email_domains?.length)
    $('#f-email-hint').textContent = `Use your ${s.allowed_email_domains.join(' or ')} address.`;
  if (s.booking_notice) {
    $('#terms-box').classList.remove('hidden');
    $('#terms-text').innerHTML = escLines(s.booking_notice);
  }
  if (s.auto_approve) $('#btn-send').textContent = 'Book now';

  // remember details on this device for next time
  const saved = store && JSON.parse(store.getItem('kitroom.me') || 'null');
  if (saved) for (const k of ['name', 'email', 'sid', 'phone', 'course']) if (saved[k]) $('#f-' + k).value = saved[k];

  $('#req-items').addEventListener('click', e => {
    const rm = e.target.closest('[data-rm]');
    if (!rm) return;
    toggleBasket(Number(rm.dataset.rm));
    if (!state.basket.size) $('#dlg-request').close(); else fillRequest();
  });
  $('#req-form').addEventListener('submit', sendRequest);
}

function fillRequest() {
  $('#req-when').innerHTML = `${esc(fmtRange(state.start, state.end))}<span>${esc(humanDuration(state.start, state.end))}</span>`;
  $('#req-items').innerHTML = [...state.basket].map(id => {
    const it = state.items.find(i => i.id === id);
    return `<li>${assetTag(it?.asset_tag)}<span class="name">${esc(it?.name)}</span>
      <button type="button" class="rm" data-rm="${id}" aria-label="Remove ${esc(it?.name)}">×</button></li>`;
  }).join('');
}

function openRequest() {
  $('#req-error').innerHTML = '';
  fillRequest();
  $('#dlg-request').showModal();
  const first = $$('#req-form input').find(i => !i.value);
  (first || $('#f-purpose')).focus();
}

async function sendRequest(e) {
  e.preventDefault();
  if (state.sending) return;
  const s = state.settings;
  const v = id => $('#' + id).value.trim();
  const err = msg => { $('#req-error').innerHTML = `<div class="notice notice--error">${esc(msg)}</div>`; };

  if (v('f-name').length < 2) return err('Please enter your full name.'), $('#f-name').focus();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v('f-email'))) return err('Please enter a valid email address.'), $('#f-email').focus();
  if (s.require_student_id && !v('f-sid')) return err(`Please enter your ${s.student_id_label.toLowerCase()}.`), $('#f-sid').focus();
  if (s.booking_notice && !$('#f-terms').checked) return err('Please confirm you agree to the conditions.');

  state.sending = true;
  const btn = $('#btn-send');
  const label = btn.textContent;
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Sending…';

  const { data, error } = await sb.rpc('submit_booking', {
    p_name: v('f-name'), p_email: v('f-email'), p_student_id: v('f-sid'), p_phone: v('f-phone'),
    p_course: v('f-course'), p_purpose: v('f-purpose'),
    p_starts: state.start.toISOString(), p_ends: state.end.toISOString(),
    p_items: [...state.basket],
  });

  state.sending = false;
  btn.disabled = false; btn.textContent = label;

  if (error) {
    err(errMsg(error));
    loadAvailability().then(() => { renderAll(); fillRequest(); });
    return;
  }

  const email = v('f-email').toLowerCase();
  if (store) {
    store.setItem('kitroom.me', JSON.stringify({ name: v('f-name'), email, sid: v('f-sid'), phone: v('f-phone'), course: v('f-course') }));
    const recent = JSON.parse(store.getItem('kitroom.recent') || '[]').filter(r => r.ref !== data.ref);
    recent.unshift({ ref: data.ref, email, start: state.start, at: new Date() });
    store.setItem('kitroom.recent', JSON.stringify(recent.slice(0, 8)));
  }

  $('#dlg-request').close();
  showDone(data, email);
  state.basket.clear();
  $('#f-purpose').value = '';
  $('#f-terms').checked = false;
  loadAvailability();
}

function showDone(res, email) {
  const approved = res.status === 'approved';
  $('#done-title').textContent = approved ? 'Booked' : 'Request sent';
  $('#done-lead').textContent = approved
    ? `You're booked for ${fmtRange(state.start, state.end)}.`
    : `We'll review your request for ${fmtRange(state.start, state.end)}. Check back here to see when it's approved.`;
  state.lastDone = res;
  $('#done-ref').textContent = res.ref;
  $('#done-check').href = `#check/${encodeURIComponent(res.ref)}`;
  $('#done-check').onclick = () => {
    $('#check-ref').value = res.ref;
    $('#check-email').value = email;
    lookup(res.ref, email);
  };
  const s = state.settings;
  $('#done-pickup').innerHTML = (s.pickup_info ? `<div class="notice"><p><strong>Collecting your equipment</strong></p><p>${escLines(s.pickup_info)}</p></div>` : '')
    + (s.contact_email ? `<p class="muted">Questions? Email <a href="mailto:${esc(s.contact_email)}">${esc(s.contact_email)}</a>.</p>` : '');
  location.hash = '#sent';
  setTimeout(() => $('#view-done').focus(), 50);
}

// ------------------------------------------------------------------ check view
function wireCheck() {
  $('#check-form').addEventListener('submit', async e => {
    e.preventDefault();
    const ref = $('#check-ref').value.trim();
    const email = $('#check-email').value.trim();
    if (!ref || !email) {
      $('#check-result').innerHTML = `<div class="notice notice--error">Enter both the reference and your email address.</div>`;
      return;
    }
    await lookup(ref, email);
  });
  $('#recent').addEventListener('click', e => {
    const b = e.target.closest('[data-ref]');
    if (!b) return;
    $('#check-ref').value = b.dataset.ref;
    $('#check-email').value = b.dataset.email;
    lookup(b.dataset.ref, b.dataset.email);
  });
  $('#check-result').addEventListener('click', async e => {
    const c = e.target.closest('[data-cancel]');
    if (!c) return;
    if (!confirm('Cancel this booking? This frees the equipment for others.')) return;
    c.disabled = true;
    const { data, error } = await sb.rpc('cancel_my_booking', { p_ref: c.dataset.cancel, p_email: c.dataset.email });
    if (error) { toast(errMsg(error), 'error'); c.disabled = false; return; }
    toast('Booking cancelled');
    renderResult(data, c.dataset.email);
    loadAvailability();
  });
}

function renderRecent() {
  const recent = store ? JSON.parse(store.getItem('kitroom.recent') || '[]') : [];
  $('#recent').innerHTML = recent.length
    ? `<span class="small muted">Requests made on this device</span><div class="recent-list">${recent.map(r =>
        `<button type="button" class="btn btn--small" data-ref="${esc(r.ref)}" data-email="${esc(r.email)}">${esc(r.ref)}</button>`).join('')}</div>`
    : '';
}

async function lookup(ref, email) {
  $('#check-result').innerHTML = `<div class="empty"><span class="spinner"></span></div>`;
  const { data, error } = await sb.rpc('lookup_booking', { p_ref: ref, p_email: email });
  if (error) { $('#check-result').innerHTML = `<div class="notice notice--error">${esc(errMsg(error))}</div>`; return; }
  if (!data) {
    $('#check-result').innerHTML = `<div class="notice notice--error">No booking matches that reference and email. Check both for typos — the email must be the one you used when booking.</div>`;
    return;
  }
  renderResult(data, email);
}

function renderResult(b, email) {
  const k = b.is_overdue ? 'overdue' : b.status;
  const steps = ['Requested', 'Approved', 'Collected', 'Returned'];
  const reached = { pending: 1, approved: 2, checked_out: 3, overdue: 3, returned: 4 }[k] ?? 0;
  const closed = k === 'rejected' || k === 'cancelled';
  const message = {
    pending: 'Your request is waiting for approval.',
    approved: 'Approved. Collect your equipment at the pick-up time.',
    checked_out: `You have the equipment. Please return it by ${fmtDateTime(b.ends_at)}.`,
    overdue: `This was due back ${fmtDateTime(b.ends_at)}. Please return it as soon as possible.`,
    returned: 'Returned. Thanks!',
    rejected: 'This request was not approved.',
    cancelled: 'This booking was cancelled.',
  }[k];
  const s = state.settings;
  const canCancel = b.status === 'pending' || b.status === 'approved';

  $('#check-result').innerHTML = `
    <article class="result">
      <div class="result-head">
        <span class="tag">${esc(b.ref)}</span>
        ${badge(k, true)}
      </div>
      ${closed ? '' : `<ol class="progress">${steps.map((t, n) =>
        `<li class="${n < reached ? 'done' : n === reached ? 'now' : ''}">${t}</li>`).join('')}</ol>`}
      <p><strong>${esc(message)}</strong></p>
      ${b.admin_note ? `<div class="notice ${k === 'rejected' ? 'notice--warn' : ''}"><p>${escLines(b.admin_note)}</p></div>` : ''}
      <dl class="meta">
        <dt>Pick up</dt><dd>${esc(fmtDateTime(b.starts_at))}</dd>
        <dt>Return</dt><dd>${esc(fmtDateTime(b.ends_at))}</dd>
        <dt>Items</dt><dd>${b.items.map(i => esc(i.name)).join('<br>')}</dd>
      </dl>
      ${b.status === 'approved' && s.pickup_info ? `<div class="notice"><p>${escLines(s.pickup_info)}</p></div>` : ''}
      ${canCancel ? `<button type="button" class="btn btn--danger" data-cancel="${esc(b.ref)}" data-email="${esc(email)}">Cancel booking</button>` : ''}
      ${s.contact_email ? `<p class="small muted" style="margin-top:1rem">Need to change something? Email <a href="mailto:${esc(s.contact_email)}?subject=${encodeURIComponent('Booking ' + b.ref)}">${esc(s.contact_email)}</a>.</p>` : ''}
    </article>`;
}
