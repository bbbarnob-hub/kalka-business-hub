/* ============================================================
   KALKA BUSINESS HUB — UI runtime (helpers, toasts, sheets, routing)
   ============================================================ */
'use strict';

const App = {
  user: null,
  route: 'dashboard',
  param: null,
  unread: 0,
  cache: {},
  busy: false,
};

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const money = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

function fmtDate(v, withTime) {
  if (!v) return '—';
  let s = String(v).replace(' ', 'T');
  if (!/Z|[+-]\d\d:\d\d$/.test(s)) s += 'Z';
  const d = new Date(s);
  if (isNaN(d)) return String(v);
  const o = { day: '2-digit', month: 'short', year: 'numeric' };
  if (withTime) { o.hour = '2-digit'; o.minute = '2-digit'; }
  return d.toLocaleDateString('en-IN', o);
}

function timeAgo(v) {
  if (!v) return '';
  let s = String(v).replace(' ', 'T');
  if (!/Z|[+-]\d\d:\d\d$/.test(s)) s += 'Z';
  const t = Math.floor((Date.now() - new Date(s).getTime()) / 1000);
  if (t < 60) return 'just now';
  if (t < 3600) return Math.floor(t / 60) + 'm ago';
  if (t < 86400) return Math.floor(t / 3600) + 'h ago';
  if (t < 604800) return Math.floor(t / 86400) + 'd ago';
  return fmtDate(v);
}

const initials = (n) => (n || '?').split(' ').filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');

const STATUS_CLASS = {
  'Draft': 'neutral', 'New': 'info', 'Assigned': 'info', 'Accepted': 'info',
  'Rejected': 'bad', 'Production Started': 'warn', 'In Production': 'warn',
  'Ready for Review': 'gold', 'Revision Requested': 'warn', 'Approved': 'ok',
  'Ready for Delivery': 'ok', 'Out for Delivery': 'gold', 'Delivered': 'ok',
  'Completed': 'ok', 'Cancelled': 'bad',
};
const pill = (st) => `<span class="pill ${STATUS_CLASS[st] || 'neutral'}">${esc(st)}</span>`;

/* ---------------------------------------------------------------- toast */
function toast(msg, kind = '') {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = `<span class="ti">${kind === 'ok' ? '✓' : kind === 'bad' ? '!' : '◆'}</span><span>${esc(msg)}</span>`;
  box.appendChild(el);
  setTimeout(() => { el.classList.add('out'); }, 3200);
  setTimeout(() => el.remove(), 3700);
}

/* ---------------------------------------------------------------- sheet (modal) */
function sheet({ title, body, footer, onMount, tall }) {
  const root = $('#sheet-root');
  root.innerHTML = `
    <div class="sheet-backdrop" data-backdrop>
      <div class="sheet ${tall ? 'tall' : ''}" role="dialog" aria-modal="true">
        <div class="sheet-grip"></div>
        <div class="sheet-head">
          <h3>${esc(title)}</h3>
          <button class="sheet-close" data-close aria-label="Close">✕</button>
        </div>
        <div class="sheet-body">${body}</div>
        ${footer ? `<div class="sheet-foot">${footer}</div>` : ''}
      </div>
    </div>`;
  const close = () => { root.innerHTML = ''; };
  $('[data-close]', root).onclick = close;
  $('[data-backdrop]', root).onclick = (e) => { if (e.target.hasAttribute('data-backdrop')) close(); };
  if (onMount) onMount($('.sheet', root), close);
  return { close };
}

function ask(title, message, okLabel = 'Confirm', danger = false) {
  return new Promise((resolve) => {
    sheet({
      title,
      body: `<p class="ask-msg">${esc(message)}</p>`,
      footer: `<button class="btn" data-no>Cancel</button>
               <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-yes>${esc(okLabel)}</button>`,
      onMount(el, close) {
        $('[data-no]', el).onclick = () => { close(); resolve(false); };
        $('[data-yes]', el).onclick = () => { close(); resolve(true); };
      },
    });
  });
}

/* ---------------------------------------------------------------- routing */
function go(route, param) {
  App.route = route;
  App.param = param || null;
  render();
  const main = $('#main');
  if (main) main.scrollTop = 0;
}

function setHeader(title, sub) {
  const t = $('#headerTitle'), s = $('#headerSub');
  if (t) t.textContent = title;
  if (s) s.textContent = sub || '';
}

/* ---------------------------------------------------------------- shell */
const ADMIN_NAV = [
  { k: 'dashboard', l: 'Dashboard', i: '◈' },
  { k: 'orders', l: 'Orders', i: '❏' },
  { k: 'customers', l: 'Customers', i: '☺' },
  { k: 'inventory', l: 'Inventory', i: '▤' },
  { k: 'finance', l: 'Finance', i: '₹' },
  { k: 'payments', l: 'Partner Payments', i: '⇄' },
  { k: 'projects', l: 'Projects', i: '◆' },
  { k: 'history', l: 'Project History', i: '🔒' },
  { k: 'chat', l: 'Chat', i: '✉' },
  { k: 'notifications', l: 'Notifications', i: '◔' },
  { k: 'reports', l: 'Reports', i: '▦' },
  { k: 'settings', l: 'Settings', i: '⚙' },
];
const PARTNER_NAV = [
  { k: 'dashboard', l: 'Dashboard', i: '◈' },
  { k: 'orders', l: 'Assigned Orders', i: '❏' },
  { k: 'production', l: 'Production', i: '⚒' },
  { k: 'inventory', l: 'Inventory', i: '▤' },
  { k: 'expenses', l: 'Expenses', i: '₹' },
  { k: 'chat', l: 'Chat', i: '✉' },
  { k: 'notifications', l: 'Notifications', i: '◔' },
  { k: 'profile', l: 'Profile', i: '☺' },
];

function render() {
  const root = $('#app');
  if (!App.user) { Views.login(root); return; }
  const nav = App.user.role === 'admin' ? ADMIN_NAV : PARTNER_NAV;
  const allowed = nav.map(n => n.k);
  const active = App.route === 'order' ? 'orders' : App.route;
  if (!allowed.includes(active) && App.route !== 'dashboard') {
    App.route = 'dashboard'; App.param = null;
  }
  root.innerHTML = `
    <div class="app">
      <header class="topbar">
        <div class="tb-brand">
          <div class="tb-logo">K</div>
          <div class="tb-title">
            <h1 id="headerTitle">Kalka Hub</h1>
            <p id="headerSub">${App.user.role === 'admin' ? 'Business Owner' : 'Production & Delivery'}</p>
          </div>
        </div>
        <div class="tb-actions">
          <button class="tb-btn" id="bellBtn" aria-label="Notifications">
            ◔<span class="tb-dot" id="bellDot"></span>
          </button>
        </div>
      </header>

      <main id="main" class="main"></main>

      <nav class="tabbar">
        ${nav.slice(0, 5).map(n => `
          <button class="tab ${active === n.k ? 'on' : ''}" data-go="${n.k}">
            <span class="tab-i">${n.i}</span><span class="tab-l">${n.l.split(' ')[0]}</span>
          </button>`).join('')}
        <button class="tab" id="moreBtn"><span class="tab-i">☰</span><span class="tab-l">More</span></button>
      </nav>
    </div>`;

  $$('[data-go]').forEach(b => b.onclick = () => go(b.dataset.go));
  $('#bellBtn').onclick = () => go('notifications');
  $('#moreBtn').onclick = () => openDrawer();

  const view = Views[App.route] || Views.dashboard;
  view($('#main'), App.param);
  refreshBadge();
}

function openDrawer() {
  const nav = App.user.role === 'admin' ? ADMIN_NAV : PARTNER_NAV;
  const active = App.route === 'order' ? 'orders' : App.route;
  const root = $('#sheet-root');
  root.innerHTML = `
    <div class="drawer-backdrop" data-backdrop>
      <div class="drawer">
        <div class="drawer-head">
          <div class="avatar lg">${initials(App.user.fullName)}</div>
          <div>
            <strong>${esc(App.user.fullName)}</strong>
            <small>${esc(App.user.email)}</small>
          </div>
        </div>
        <div class="drawer-nav">
          ${nav.map(n => `<button class="drawer-item ${active === n.k ? 'on' : ''}" data-d="${n.k}">
            <span class="di">${n.i}</span><span>${n.l}</span></button>`).join('')}
        </div>
        <button class="btn btn-block" id="drawerLogout">Sign out</button>
        <div class="drawer-foot">KALKA BUSINESS HUB v1.0 · two authorized accounts only</div>
      </div>
    </div>`;
  const close = () => { root.innerHTML = ''; };
  $('[data-backdrop]', root).onclick = (e) => { if (e.target.hasAttribute('data-backdrop')) close(); };
  $$('[data-d]', root).forEach(b => b.onclick = () => { close(); go(b.dataset.d); });
  $('#drawerLogout', root).onclick = async () => {
    close();
    if (await ask('Sign out', 'Sign out of KALKA BUSINESS HUB?', 'Sign out')) Views.logout();
  };
}

async function refreshBadge() {
  try {
    const d = await API.get('/api/notifications');
    App.unread = d.unread;
    const dot = $('#bellDot');
    if (dot) dot.style.display = d.unread ? 'block' : 'none';
  } catch (e) {}
}

/* ---------------------------------------------------------------- form helpers */
function fieldVal(id) {
  const el = document.getElementById(id);
  return el ? el.value.trim() : '';
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

async function pickImage(capture) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*,application/pdf';
    if (capture) input.capture = 'environment';
    input.onchange = () => resolve(input.files[0] || null);
    input.click();
  });
}

function emptyState(glyph, title, text) {
  return `<div class="empty"><div class="glyph">${glyph}</div><h4>${esc(title)}</h4><p>${esc(text || '')}</p></div>`;
}

function loading() {
  return `<div class="center-load"><div class="spinner"></div></div>`;
}
