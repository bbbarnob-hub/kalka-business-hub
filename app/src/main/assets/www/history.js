/* ============================================================
   KALKA BUSINESS HUB — Project History (fingerprint sealed)
   The server refuses this data unless a grant minted after a native
   biometric unlock is presented. Nothing is rendered before that.
   ============================================================ */
'use strict';

const FP_ICON = `<svg viewBox="0 0 64 64" aria-hidden="true">
  <path d="M32 8c-9 0-16 7-16 16v8"/>
  <path d="M32 8c9 0 16 7 16 16v10c0 6-1 10-2 14"/>
  <path d="M32 16c-5 0-8 3.5-8 8v10c0 8-1 14-3 20"/>
  <path d="M32 16c5 0 8 3.5 8 8v12c0 9-1 15-3 21"/>
  <path d="M32 24c-2 0-3 1.6-3 4v12c0 8-1 13-2 17"/>
  <path d="M32 24c2 0 3 1.6 3 4v14c0 8-1 13-2 17"/>
  <path d="M14 38v-2M50 34v8"/>
</svg>`;

Views.history = async function (root, id) {
  setHeader('Project History', 'Sealed business archive');
  if (App.user.role !== 'admin') { go('dashboard'); return; }
  if (!API.grantValid()) { API.clearGrant(); renderLock(root); return; }
  if (id) return historyDetail(root, id);

  const q = App.cache.hq || '';
  const status = App.cache.hstatus || 'all';
  root.innerHTML = `
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px">
      <span class="pill ok">Unlocked</span>
      <button class="btn btn-sm" id="relock" style="margin-left:auto">Lock now</button>
    </div>
    <div class="searchbar"><input id="hq" placeholder="Search customer, order, project" value="${esc(q)}"></div>
    <div class="chips">
      ${[['all', 'All'], ['Completed', 'Completed'], ['Cancelled', 'Cancelled']]
        .map(([k, l]) => `<button class="chip ${status === k ? 'on' : ''}" data-hs="${k}">${l}</button>`).join('')}
    </div>
    <div id="histList">${loading()}</div>`;

  $('#relock').onclick = () => { API.clearGrant(); toast('Locked'); Views.history(root); };
  $$('[data-hs]', root).forEach(b => b.onclick = () => { App.cache.hstatus = b.dataset.hs; Views.history(root); });
  let t;
  $('#hq').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { App.cache.hq = e.target.value; loadHist(); }, 350); };

  async function loadHist() {
    try {
      const d = await API.get(`/api/history?q=${encodeURIComponent(App.cache.hq || '')}` +
                              `&status=${encodeURIComponent(App.cache.hstatus || 'all')}`);
      $('#histList').innerHTML = d.history.length ? `<div class="list">${d.history.map(h => `
        <button class="list-item" data-h="${h.id}">
          <div class="li-main">
            <div class="li-t">${esc(h.projectCode)} · ${esc(h.customerName)}</div>
            <div class="li-s">${esc(h.orderNumber)} · ${fmtDate(h.archivedAt)} · ${money(h.finalAmount)}</div>
          </div>
          <div class="li-r">${pill(h.finalStatus)}</div>
        </button>`).join('')}</div>`
        : emptyState('🔒', 'No archived projects', 'Completed and cancelled orders are archived here automatically.');
      $$('[data-h]').forEach(b => b.onclick = () => go('history', b.dataset.h));
    } catch (e) {
      if (e.code === 'history_locked') { API.clearGrant(); renderLock(root); return; }
      toast(e.message, 'bad');
    }
  }
  await loadHist();
};

function renderLock(root) {
  const enabled = App.security && App.security.biometricEnabled;
  const can = Native.canAuthenticate();
  root.innerHTML = `
    <div class="lock" style="position:static;border-radius:22px;min-height:70vh">
      <div class="lock-in">
        <div class="fp" id="fp">${FP_ICON}</div>
        <h2>Private project history</h2>
        <p>Authenticate to access your private business records.</p>
        <div class="actions">
          <button class="btn btn-gold btn-block" id="unlock" ${enabled && can ? '' : 'disabled'}>
            ${enabled && can ? 'Authenticate with fingerprint' : enabled ? 'No fingerprint sensor available' : 'Fingerprint protection is off'}
          </button>
          ${!enabled ? '<button class="btn btn-block" id="setup">Set up fingerprint protection</button>' : ''}
        </div>
        <div class="note">
          Records stay locked on the server until the device confirms your fingerprint.
          Access lasts ${(App.security && App.security.unlockMinutes) || 10} minutes, then locks again.
          ${can ? '' : '<br>This device reports no enrolled biometric — set a fingerprint in Android settings first.'}
        </div>
      </div>
    </div>`;

  const u = $('#unlock');
  if (u) u.onclick = async () => {
    const fp = $('#fp');
    fp.classList.add('scan');
    u.disabled = true; u.textContent = 'Waiting for fingerprint…';
    const r = await Native.authenticate('PRIVATE PROJECT HISTORY',
                                        'Authenticate to access your private business records.');
    fp.classList.remove('scan');
    if (!r.ok) {
      u.disabled = false;
      u.textContent = 'Authenticate with fingerprint';
      toast(r.reason === 'cancelled' ? 'Authentication cancelled' : 'Fingerprint not recognised', 'bad');
      return;
    }
    try {
      const d = await API.post('/api/security/unlock', { nativeVerified: true });
      API.setGrant(d.grant, d.expiresInMinutes);
      scheduleRelock(d.expiresInMinutes);
      toast('Access granted', 'ok');
      go('history');
    } catch (e) {
      toast(e.message, 'bad');
      u.disabled = false; u.textContent = 'Authenticate with fingerprint';
    }
  };
  const s = $('#setup');
  if (s) s.onclick = () => enableBiometric();
}

function scheduleRelock(minutes) {
  clearTimeout(App.relockTimer);
  App.relockTimer = setTimeout(() => {
    API.clearGrant();
    if (App.route === 'history') { toast('Protected session expired', 'bad'); go('history'); }
  }, Math.max(30, minutes * 60) * 1000 - 2000);
}

async function enableBiometric() {
  if (!Native.canAuthenticate()) {
    toast('This device has no enrolled fingerprint or face unlock', 'bad');
    return;
  }
  const r = await Native.authenticate('ADD FINGERPRINT',
                                      'Confirm with your device biometrics to protect Project History.');
  if (!r.ok) { toast('Not enabled — authentication was not completed', 'bad'); return; }
  try {
    await API.post('/api/security/enable', { nativeVerified: true });
    App.security = await (await API.get('/api/security'));
    App.security.biometricEnabled = true;
    toast('Fingerprint protection enabled', 'ok');
    if (App.route === 'history') go('history');
    else if (App.route === 'settings') Views.settings($('#main'));
  } catch (e) { toast(e.message, 'bad'); }
}

async function historyDetail(root, id) {
  root.innerHTML = loading();
  try {
    const h = await API.get('/api/history/' + id);
    const c = h.customer || {}, o = h.order || {}, f = h.finance || {}, dl = h.delivery || {};
    setHeader(h.projectCode, h.orderNumber);
    root.innerHTML = `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">
        ${pill(h.finalStatus)}
        <span style="font-size:12px;color:var(--muted)">${fmtDate(h.archivedAt)}</span>
        <button class="btn btn-sm" id="lock2" style="margin-left:auto">Lock</button>
      </div>

      <div class="card">
        <div class="card-head"><h3>Customer</h3></div>
        <div class="card-pad">
          <div class="stat"><span class="k">Name</span><span class="v">${esc(c.full_name || '—')}</span></div>
          <div class="stat"><span class="k">Phone</span><span class="v">${esc(c.phone || '—')}</span></div>
          <div class="stat"><span class="k">Email</span><span class="v">${esc(c.email || '—')}</span></div>
          <div class="stat"><span class="k">City</span><span class="v">${esc(c.city || '—')}</span></div>
          <div class="stat"><span class="k">Address</span><span class="v" style="max-width:62%">${esc(c.address || '—')}</span></div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>Order & design</h3></div>
        <div class="card-pad">
          <div class="stat"><span class="k">Design</span><span class="v">${esc(o.design_name || '—')}</span></div>
          <div class="stat"><span class="k">Code</span><span class="v">${esc(o.design_code || '—')}</span></div>
          <div class="stat"><span class="k">Colour</span><span class="v">${esc(o.fabric_colour || '—')}</span></div>
          <div class="stat"><span class="k">Size</span><span class="v">${esc(o.size || '—')}</span></div>
          <div class="stat"><span class="k">Created</span><span class="v">${fmtDate(o.created_at)}</span></div>
          ${h.cancellationReason ? `<div class="stat"><span class="k" style="color:var(--bad)">Cancellation</span>
            <span class="v" style="max-width:62%">${esc(h.cancellationReason)}</span></div>` : ''}
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>Financial record</h3></div>
        <div class="card-pad">
          <div class="stat"><span class="k">Final amount</span><span class="v">${money(h.finalAmount)}</span></div>
          <div class="stat"><span class="k">Income</span><span class="v">${money(f.income)}</span></div>
          <div class="stat"><span class="k">Expenses</span><span class="v">${money(f.expense)}</span></div>
          <div class="stat"><span class="k">Profit</span><span class="v" style="color:var(--ok)">${money(f.profit)}</span></div>
          ${(f.transactions || []).map(t => `<div class="stat"><span class="k">${esc(t.category)} · ${fmtDate(t.txn_date)}</span>
            <span class="v">${money(t.amount)}</span></div>`).join('')}
        </div>
      </div>

      ${h.photos.length ? `<div class="card">
        <div class="card-head"><h3>Photos (${h.photos.length})</h3></div>
        <div class="card-pad"><div class="gallery" id="hg">
          ${h.photos.map(p => `<figure data-hp="${p.id}"><img data-src="/api/history/${h.id}/photo/${p.id}" alt="">
            <figcaption>${esc(p.kind)}</figcaption></figure>`).join('')}
        </div></div>
      </div>` : ''}

      <div class="card">
        <div class="card-head"><h3>Timeline</h3></div>
        <div class="card-pad">
          ${h.timeline.length ? `<div class="timeline">${h.timeline.map(t => `
            <div class="tl done"><div class="t">${esc(t.to_status)}</div>
              <div class="m">${esc(t.role)} · ${fmtDate(t.created_at, true)}</div>
              ${t.note ? `<div class="n">${esc(t.note)}</div>` : ''}</div>`).join('')}</div>`
            : '<p style="font-size:13px;color:var(--muted)">No timeline</p>'}
        </div>
      </div>

      ${h.revisions.length ? `<div class="card">
        <div class="card-head"><h3>Revisions</h3></div>
        <div class="card-pad">${h.revisions.map(r => `<div style="padding:8px 0;border-bottom:1px dashed var(--line)">
          <strong style="font-size:13px">Revision ${r.revision_no}</strong>
          <div style="font-size:13px">${esc(r.notes)}</div></div>`).join('')}</div>
      </div>` : ''}

      <div class="card">
        <div class="card-head"><h3>Delivery</h3></div>
        <div class="card-pad">
          <div class="stat"><span class="k">Courier</span><span class="v">${esc(dl.courier || '—')}</span></div>
          <div class="stat"><span class="k">Tracking</span><span class="v">${esc(dl.tracking_no || '—')}</span></div>
          <div class="stat"><span class="k">Delivered</span><span class="v">${fmtDate(dl.delivered_at)}</span></div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>Activity</h3></div>
        <div class="card-pad" style="max-height:300px;overflow:auto">
          ${h.activity.length ? `<div class="timeline">${h.activity.map(a => `
            <div class="tl"><div class="t" style="font-size:12.5px">${esc(prettyAction(a.action))}</div>
              <div class="m">${esc(a.user_role)} · ${fmtDate(a.created_at, true)}</div></div>`).join('')}</div>`
            : '<p style="font-size:13px;color:var(--muted)">No activity</p>'}
        </div>
      </div>`;

    $('#lock2').onclick = () => { API.clearGrant(); go('history'); };
    $$('[data-hp]', root).forEach(async (fig) => {
      const img = fig.querySelector('img');
      try { img.src = await protectedUrl(img.dataset.src); } catch (e) {}
      fig.onclick = () => {
        if (img.src) sheet({ title: 'Archived photo', body: `<img src="${img.src}" style="width:100%;border-radius:12px">` });
      };
    });
  } catch (e) {
    if (e.code === 'history_locked') { API.clearGrant(); renderLock(root); return; }
    root.innerHTML = emptyState('!', 'Could not open record', e.message);
  }
}

/* ---------------------------------------------------------------- settings panel */
async function renderBioPanel() {
  const panel = $('#bioPanel');
  if (!panel) return;
  const st = await API.get('/api/security');
  App.security = st;
  const can = Native.canAuthenticate();
  panel.innerHTML = `
    <div style="display:flex;gap:12px;align-items:flex-start">
      <div class="fp" style="width:56px;height:56px;margin:0;flex:0 0 56px;border-width:1px">
        <svg viewBox="0 0 64 64" style="width:28px;height:28px">${FP_ICON.replace(/<\/?svg[^>]*>/g, '')}</svg>
      </div>
      <div style="flex:1">
        <strong style="font-size:14px">${st.biometricEnabled ? 'Protection enabled' : 'Protection off'}</strong>
        <p style="font-size:12.5px;color:var(--muted);margin-top:3px;line-height:1.55">
          ${st.biometricEnabled
            ? 'Project History requires a fingerprint every time it is opened.'
            : 'Enable to seal Project History behind your fingerprint.'}
        </p>
        <div style="font-size:11.5px;color:var(--dim);margin-top:6px">
          Device: ${can ? 'biometric hardware available' : 'no enrolled biometric on this device'}
        </div>
      </div>
    </div>
    <div style="display:grid;gap:8px;margin-top:14px">
      ${st.biometricEnabled
        ? `<button class="btn btn-block" id="reReg">Re-confirm fingerprint</button>
           <button class="btn btn-block btn-danger" id="disBio">Disable protection</button>`
        : `<button class="btn btn-block btn-gold" id="enBio" ${can ? '' : 'disabled'}>
             ${can ? 'Add fingerprint' : 'No biometric available'}</button>`}
    </div>
    <div class="field" style="margin-top:14px">
      <label>Unlock duration (minutes)</label>
      <input id="bioMin" type="number" min="1" max="120" value="${st.unlockMinutes}">
      <div class="hint">How long one authenticated session stays open.</div>
    </div>
    <p class="hint" style="margin-top:8px;line-height:1.6">
      Fingerprints never leave your phone — Android keeps them. The app only learns
      that the device owner authenticated.
    </p>`;

  const en = $('#enBio');
  if (en) en.onclick = () => enableBiometric();
  const re = $('#reReg');
  if (re) re.onclick = () => enableBiometric();
  const dis = $('#disBio');
  if (dis) dis.onclick = async () => {
    const r = await Native.authenticate('DISABLE PROTECTION', 'Confirm to turn off fingerprint protection.');
    if (!r.ok) { toast('Cancelled', 'bad'); return; }
    try { await API.post('/api/security/disable', { nativeVerified: true });
      toast('Protection disabled', 'ok'); Views.settings($('#main')); } catch (e) { toast(e.message, 'bad'); }
  };
  $('#bioMin').onchange = async (e) => {
    try { await API.post('/api/security/unlock-minutes', { minutes: Number(e.target.value) });
      toast('Updated', 'ok'); } catch (err) { toast(err.message, 'bad'); }
  };
}
