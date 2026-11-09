/* ============================================================
   KALKA BUSINESS HUB — core views
   ============================================================ */
'use strict';

const Views = {};

/* ---------------------------------------------------------------- login */
Views.login = async function (root) {
  let boot = { open: true, adminTaken: false, partnerTaken: false, businessName: 'Rithika Kalka Studio' };
  try { boot = await API.get('/api/bootstrap'); } catch (e) {}

  let picked = boot.adminTaken && !boot.partnerTaken ? 'partner'
             : boot.partnerTaken && !boot.adminTaken ? 'admin' : 'admin';
  const noneFree = boot.adminTaken && boot.partnerTaken;

  root.innerHTML = `
    <div class="login">
      <div class="login-logo" aria-label="Hritika's Kolka Studio"></div>
      <h2>Tradition in<br>every stitch.</h2>
      <p class="tag">Hritika's Kolka Studio · private business hub<br>Orders, production, money and permanent project records.</p>

      <div class="login-card">
        <h3>${noneFree ? 'Sign in' : 'Set up your account'}</h3>
        <p class="sub" id="loginSub">${noneFree
          ? 'Both accounts are registered. Choose your role and sign in with your own email.'
          : 'The first two people to sign up become Admin and Partner.'}</p>

        <div class="role-pick" id="rolePick">
          <button class="role-card ${picked === 'admin' ? 'on' : ''}" data-role="admin">
            <span class="role-ico">◆</span>
            <span class="role-name">Admin</span>
            <span class="role-sub">${boot.adminTaken ? 'Registered · sign in' : 'Owner · orders, money, history'}</span>
          </button>
          <button class="role-card ${picked === 'partner' ? 'on' : ''}" data-role="partner">
            <span class="role-ico">⚒</span>
            <span class="role-name">Partner</span>
            <span class="role-sub">${boot.partnerTaken ? 'Registered · sign in' : 'Production · stock, delivery'}</span>
          </button>
        </div>

        <div class="err" id="loginErr"></div>
        <div class="field">
          <label>Email</label>
          <input type="email" id="lEmail" inputmode="email" autocomplete="username" placeholder="you@example.com">
        </div>
        <div class="field">
          <label>Password</label>
          <input type="password" id="lPass" autocomplete="current-password" placeholder="At least 8 characters">
        </div>
        <div class="field" id="nameField" style="${noneFree ? 'display:none' : ''}">
          <label>Your name</label>
          <input id="lName" placeholder="e.g. Rithika">
        </div>
        <button class="btn btn-primary btn-block" id="lBtn">${noneFree ? 'Sign in' : 'Continue'}</button>
        <div class="login-foot">${noneFree
          ? 'No public registration. This app is closed to new accounts.'
          : 'Only two accounts can ever be created. Choose your role carefully — it cannot be changed.'}</div>
      </div>
    </div>`;

  $$('[data-role]', root).forEach(b => b.onclick = () => {
    picked = b.dataset.role;
    $$('[data-role]', root).forEach(x => x.classList.toggle('on', x.dataset.role === picked));
    $('#loginErr').style.display = 'none';
  });

  const submit = async () => {
    const btn = $('#lBtn'), err = $('#loginErr');
    err.style.display = 'none';
    const email = $('#lEmail').value.trim(), pass = $('#lPass').value;
    const name = $('#lName') ? $('#lName').value.trim() : '';
    if (!email || !pass) { err.textContent = 'Enter your email and password'; err.style.display = 'block'; return; }
    btn.disabled = true; btn.textContent = 'Please wait…';
    try {
      const d = await API.post('/api/login', { email, password: pass, role: picked, name });
      API.setToken(d.token);
      App.user = d.user;
      toast(d.claimed ? `${d.roleLabel} account created — welcome, ${d.user.fullName}` : 'Welcome back, ' + d.user.fullName, 'ok');
      App.route = 'dashboard';
      render();
    } catch (e) {
      err.textContent = e.message;
      err.style.display = 'block';
      btn.disabled = false; btn.textContent = noneFree ? 'Sign in' : 'Continue';
    }
  };
  $('#lBtn').onclick = submit;
  $('#lPass').onkeydown = (e) => { if (e.key === 'Enter') submit(); };
  $('#lEmail').onkeydown = (e) => { if (e.key === 'Enter') $('#lPass').focus(); };
};

Views.logout = async function () {
  try { await API.post('/api/logout'); } catch (e) {}
  API.clear();
  API.clearGrant();
  App.user = null;
  render();
};

/* ---------------------------------------------------------------- dashboard */
Views.dashboard = async function (root) {
  setHeader('Dashboard', 'Live business overview');
  root.innerHTML = loading();
  try {
    const d = await API.get('/api/dashboard');
    root.innerHTML = d.role === 'admin' ? adminDash(d) : partnerDash(d);
    $$('[data-dashgo]', root).forEach(b => b.onclick = () => go(b.dataset.dashgo, b.dataset.id));
  } catch (e) {
    root.innerHTML = emptyState('!', 'Could not load dashboard', e.message);
  }
};

function adminDash(d) {
  const o = d.orders || {};
  const fin = d.finance || {};
  const max = Math.max(1, ...(d.monthly || []).flatMap(m => [m.income, m.expense]));
  return `
    <div class="kpis">
      <div class="kpi"><div class="lbl">Total orders</div><div class="val">${d.totalOrders}</div>
        <div class="ft">${o['New'] || 0} new · ${o['Assigned'] || 0} assigned</div></div>
      <div class="kpi acc"><div class="lbl">In production</div>
        <div class="val">${(o['Production Started'] || 0) + (o['In Production'] || 0)}</div>
        <div class="ft">${o['Ready for Review'] || 0} awaiting review</div></div>
      <div class="kpi gold"><div class="lbl">Revenue</div><div class="val">${money(fin.income)}</div>
        <div class="ft">Expenses ${money(fin.expense)}</div></div>
      <div class="kpi"><div class="lbl">Est. profit</div><div class="val">${money(fin.profit)}</div>
        <div class="ft">${fin.pending ? money(fin.pending) + ' pending' : 'All approved'}</div></div>
    </div>

    <div class="kpis" style="margin-top:10px">
      <div class="kpi"><div class="lbl">Customers</div><div class="val">${d.totalCustomers}</div></div>
      <div class="kpi"><div class="lbl">Stock</div><div class="val">${Math.round(d.stock || 0)}</div>
        <div class="ft">${(d.lowStock || []).length} low</div></div>
      <div class="kpi"><div class="lbl">Pending pay</div><div class="val" style="font-size:19px">${money(d.pendingCustomer)}</div>
        <div class="ft">from customers</div></div>
      <div class="kpi"><div class="lbl">Expenses</div><div class="val" style="font-size:19px">${money(d.pendingExpenses.amount)}</div>
        <div class="ft">${d.pendingExpenses.count} to approve</div></div>
    </div>

    <div class="card" style="margin-top:12px">
      <div class="card-head"><h3>Revenue</h3><span class="sp"></span>
        <span class="pill info">In</span><span class="pill gold">Out</span></div>
      <div class="card-pad">
        <div class="bars">
          ${(d.monthly || []).map(m => `
            <div class="bcol">
              <div class="bpair">
                <div class="bar i" style="height:${Math.max(2, m.income / max * 100)}%"></div>
                <div class="bar e" style="height:${Math.max(2, m.expense / max * 100)}%"></div>
              </div>
              <div class="bl">${m.month.slice(5)}/${m.month.slice(2, 4)}</div>
            </div>`).join('')}
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Order status</h3></div>
      <div class="card-pad" style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
        ${donut(d.statusChart || [], d.totalOrders)}
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Recent orders</h3><span class="sp"></span>
        <button class="btn btn-sm btn-ghost" data-dashgo="orders">All</button></div>
      ${(d.recent || []).length ? d.recent.map(r => `
        <button class="list-item" data-dashgo="order" data-id="${r.id}">
          <div class="li-main">
            <div class="li-t">${esc(r.order_number)} · ${esc(r.full_name)}</div>
            <div class="li-s">${timeAgo(r.updated_at)}</div>
          </div>
          <div class="li-r">${pill(r.status)}</div>
        </button>`).join('') : emptyState('❏', 'No orders yet', 'Tap + on the Orders screen to create one.')}
    </div>

    ${(d.deadlines || []).length ? `<div class="card">
      <div class="card-head"><h3>Delivery deadlines</h3></div>
      ${d.deadlines.map(x => `<button class="list-item" data-dashgo="order" data-id="${x.id}">
        <div class="li-main"><div class="li-t">${esc(x.full_name)}</div>
          <div class="li-s">${esc(x.order_number)}</div></div>
        <div class="li-r" style="font-size:12.5px;font-weight:600">${fmtDate(x.expected_delivery)}</div>
      </button>`).join('')}
    </div>` : ''}

    ${(d.lowStock || []).length ? `<div class="card">
      <div class="card-head"><h3>Low stock</h3><span class="sp"></span>
        <button class="btn btn-sm btn-ghost" data-dashgo="inventory">Manage</button></div>
      ${d.lowStock.map(i => `<div class="list-item">
        <div class="li-main"><div class="li-t">${esc(i.item_name)}</div></div>
        <div class="li-r"><span class="pill bad">${i.quantity} ${esc(i.unit)}</span></div>
      </div>`).join('')}
    </div>` : ''}

    ${(d.activity || []).length ? `<div class="card">
      <div class="card-head"><h3>Recent activity</h3></div>
      <div class="card-pad"><div class="timeline">
        ${d.activity.map(a => `<div class="tl done">
          <div class="t">${esc(prettyAction(a.action))}</div>
          <div class="m">${esc(a.user_role)} · ${timeAgo(a.created_at)}</div>
        </div>`).join('')}
      </div></div>
    </div>` : ''}`;
}

function partnerDash(d) {
  return `
    <div class="kpis">
      <div class="kpi acc"><div class="lbl">New assigned</div><div class="val">${d.assigned}</div>
        <div class="ft">Awaiting acceptance</div></div>
      <div class="kpi"><div class="lbl">In production</div><div class="val">${d.inProduction}</div>
        <div class="ft">${d.readyForReview} for review</div></div>
      <div class="kpi gold"><div class="lbl">Ready to ship</div><div class="val">${d.readyForDelivery}</div>
        <div class="ft">${d.completed} completed</div></div>
      <div class="kpi"><div class="lbl">Stock</div><div class="val">${Math.round(d.stock || 0)}</div>
        <div class="ft">${(d.lowStock || []).length} low</div></div>
    </div>

    <div class="card" style="margin-top:12px">
      <div class="card-head"><h3>Your orders</h3><span class="sp"></span>
        <button class="btn btn-sm btn-ghost" data-dashgo="orders">All</button></div>
      ${(d.recent || []).length ? d.recent.map(r => `
        <button class="list-item" data-dashgo="order" data-id="${r.id}">
          <div class="li-main"><div class="li-t">${esc(r.order_number)} · ${esc(r.full_name)}</div>
            <div class="li-s">Delivery ${fmtDate(r.expected_delivery)}</div></div>
          <div class="li-r">${pill(r.status)}</div>
        </button>`).join('') : emptyState('❏', 'Nothing assigned', 'New work appears here automatically.')}
    </div>

    <div class="card">
      <div class="card-head"><h3>Quick actions</h3></div>
      <div class="card-pad" style="display:grid;gap:8px">
        <button class="btn btn-block" data-dashgo="orders">View new orders</button>
        <button class="btn btn-block" data-dashgo="production">Update production</button>
        <button class="btn btn-block" data-dashgo="inventory">Update stock</button>
        <button class="btn btn-block" data-dashgo="expenses">Submit expense</button>
        <button class="btn btn-block" data-dashgo="chat">Contact admin</button>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Pending expenses</h3></div>
      <div class="card-pad">
        <div class="stat"><span class="k">Submitted</span><span class="v">${d.pendingExpenses.count}</span></div>
        <div class="stat"><span class="k">Amount</span><span class="v">${money(d.pendingExpenses.amount)}</span></div>
      </div>
    </div>`;
}

const DONUT = ['#6a5590', '#8f7ab5', '#c39a52', '#e0c48d', '#37805f', '#a84157', '#a9701a', '#7b7186'];
function donut(data, total) {
  if (!data.length) return `<div class="empty" style="flex:1"><p>No orders yet</p></div>`;
  const sum = data.reduce((a, b) => a + b.count, 0) || 1;
  let acc = 0;
  const segs = data.map((x, i) => {
    const a = acc / sum * 100; acc += x.count; const b = acc / sum * 100;
    return `${DONUT[i % DONUT.length]} ${a}% ${b}%`;
  }).join(', ');
  return `
    <div class="donut" style="background:conic-gradient(${segs})">
      <div class="donut-txt"><div>
        <div style="font-family:Fraunces,serif;font-size:20px">${total}</div>
        <div style="font-size:9.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em">orders</div>
      </div></div>
    </div>
    <div class="legend">
      ${data.map((x, i) => `<div class="li"><span class="sw" style="background:${DONUT[i % DONUT.length]}"></span>
        <span>${esc(x.status)}</span><span class="v">${x.count}</span></div>`).join('')}
    </div>`;
}

function prettyAction(a) {
  const m = {
    'order.created': 'Order created', 'order.assign': 'Order sent to partner',
    'order.status.Accepted': 'Partner accepted an order', 'order.status.In Production': 'Production started',
    'order.status.Ready for Review': 'Photos sent for review', 'order.status.Completed': 'Order completed',
    'order.status.Cancelled': 'Order cancelled', 'finance.expense.created': 'Expense submitted',
    'finance.expense.approved': 'Expense approved', 'finance.income.created': 'Income recorded',
    'auth.login': 'Signed in', 'inventory.in': 'Stock received', 'inventory.out': 'Stock issued',
    'security.biometric.enabled': 'Fingerprint protection enabled',
    'security.biometric.verified': 'Project history unlocked',
    'photo.progress': 'Production photo uploaded', 'photo.completion': 'Completion photos uploaded',
  };
  return m[a] || a.replace(/[._]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/* ---------------------------------------------------------------- orders */
Views.orders = async function (root) {
  const isAdmin = App.user.role === 'admin';
  setHeader(isAdmin ? 'Orders' : 'Assigned orders', isAdmin ? 'Every order, website to delivery' : 'Your production queue');
  const st = App.cache.orderFilter || 'all';
  root.innerHTML = `
    <div class="searchbar">
      <input id="oSearch" placeholder="Search order, customer, design" value="${esc(App.cache.orderQuery || '')}">
      ${isAdmin ? '<button class="btn btn-primary" id="newOrder">+</button>' : ''}
    </div>
    <div class="chips">
      ${['all', 'active', 'New', 'Assigned', 'Accepted', 'In Production', 'Ready for Review',
         'Ready for Delivery', 'Completed', 'Cancelled']
        .map(k => `<button class="chip ${st === k ? 'on' : ''}" data-st="${k}">
          ${k === 'all' ? 'All' : k === 'active' ? 'Active' : k}</button>`).join('')}
    </div>
    <div id="orderList">${loading()}</div>`;

  if (isAdmin) $('#newOrder').onclick = () => orderEditor();
  $$('[data-st]', root).forEach(b => b.onclick = () => { App.cache.orderFilter = b.dataset.st; Views.orders(root); });
  let t;
  $('#oSearch').oninput = (e) => {
    clearTimeout(t);
    t = setTimeout(() => { App.cache.orderQuery = e.target.value; loadOrders(); }, 350);
  };

  async function loadOrders() {
    const d = await API.get(`/api/orders?status=${encodeURIComponent(App.cache.orderFilter || 'all')}` +
                            `&q=${encodeURIComponent(App.cache.orderQuery || '')}`);
    const box = $('#orderList');
    box.innerHTML = d.orders.length ? `<div class="list">${d.orders.map(o => `
      <button class="list-item" data-open="${o.id}">
        <div class="li-main">
          <div class="li-t">${esc(o.orderNumber)} · ${esc(o.customerName)}</div>
          <div class="li-s">${esc(o.designName || 'Panjabi')}${o.designCode ? ' · ' + esc(o.designCode) : ''} ·
            ${isAdmin ? money(o.orderPrice) : fmtDate(o.expectedDelivery)}</div>
        </div>
        <div class="li-r">${pill(o.status)}</div>
      </button>`).join('')}</div>`
      : emptyState('❏', 'No orders here', isAdmin ? 'Create one with the + button.' : 'Nothing in this state.');
    $$('[data-open]', box).forEach(b => b.onclick = () => go('order', b.dataset.open));
  }
  await loadOrders();
};

/* ---------------------------------------------------------------- order editor */
async function orderEditor() {
  let customers = [];
  try { customers = (await API.get('/api/customers')).customers; } catch (e) {}
  sheet({
    title: 'New order', tall: true,
    body: `
      <div class="sec-title">Customer</div>
      <div class="field"><label>Existing customer</label>
        <select id="custSel"><option value="">— New customer —</option>
          ${customers.map(c => `<option value="${c.id}">${esc(c.full_name)} · ${esc(c.phone)}</option>`).join('')}
        </select></div>
      <div class="row2">
        <div class="field"><label>Name *</label><input id="cName"></div>
        <div class="field"><label>Phone *</label><input id="cPhone" inputmode="tel"></div>
      </div>
      <div class="row2">
        <div class="field"><label>City</label><input id="cCity"></div>
        <div class="field"><label>Email</label><input id="cEmail" inputmode="email"></div>
      </div>
      <div class="field"><label>Address</label><input id="cAddress"></div>

      <div class="sec-title">Design</div>
      <div class="row2">
        <div class="field"><label>Design name</label><input id="oDesign" placeholder="Phulkari Panjabi"></div>
        <div class="field"><label>Code</label><input id="oCode" placeholder="PHK-22"></div>
      </div>
      <div class="row2">
        <div class="field"><label>Fabric colour</label><input id="oColour"></div>
        <div class="field"><label>Size</label><input id="oSize" placeholder="40"></div>
      </div>
      <div class="field"><label>Quantity</label><input id="oQty" type="number" min="1" value="1" inputmode="numeric"></div>
      <div class="field"><label>Custom instructions</label><textarea id="oInstr" placeholder="Gold border, kolka at chest…"></textarea></div>
      <div class="field"><label>Special requirements</label><textarea id="oSpecial"></textarea></div>

      <div class="sec-title">Commercials</div>
      <div class="row2">
        <div class="field"><label>Order price ₹</label><input id="oPrice" type="number" inputmode="decimal" value="0"></div>
        <div class="field"><label>Advance ₹</label><input id="oAdvance" type="number" inputmode="decimal" value="0"></div>
      </div>
      <div class="field"><label>Expected delivery</label><input id="oDelivery" type="date"></div>
      <div class="field"><label>Notes</label><textarea id="oNotes"></textarea></div>`,
    footer: `<button class="btn" data-draft>Draft</button>
             <button class="btn btn-primary" data-save>Create order</button>`,
    onMount(el, close) {
      $('#custSel', el).onchange = async (e) => {
        if (!e.target.value) return;
        const d = await API.get('/api/customers/' + e.target.value);
        $('#cName', el).value = d.customer.full_name;
        $('#cPhone', el).value = d.customer.phone;
        $('#cCity', el).value = d.customer.city || '';
        $('#cEmail', el).value = d.customer.email || '';
        $('#cAddress', el).value = d.customer.address || '';
      };
      const send = async (draft) => {
        const payload = {
          customerId: $('#custSel', el).value || undefined,
          customerName: $('#cName', el).value.trim(),
          customerPhone: $('#cPhone', el).value.trim(),
          customerCity: $('#cCity', el).value.trim(),
          customerEmail: $('#cEmail', el).value.trim(),
          customerAddress: $('#cAddress', el).value.trim(),
          designName: $('#oDesign', el).value.trim(),
          designCode: $('#oCode', el).value.trim(),
          fabricColour: $('#oColour', el).value.trim(),
          size: $('#oSize', el).value.trim(),
          customInstructions: $('#oInstr', el).value.trim(),
          specialRequirements: $('#oSpecial', el).value.trim(),
          orderPrice: Number($('#oPrice', el).value || 0),
          advancePaid: Number($('#oAdvance', el).value || 0),
          expectedDelivery: $('#oDelivery', el).value || null,
          additionalNotes: $('#oNotes', el).value.trim(),
          draft,
          items: [{ itemName: $('#oDesign', el).value.trim() || 'Panjabi',
                    quantity: Number($('#oQty', el).value || 1),
                    unitPrice: Number($('#oPrice', el).value || 0) }],
        };
        if (!payload.customerName || !payload.customerPhone) {
          toast('Customer name and phone are required', 'bad'); return;
        }
        try {
          const d = await API.post('/api/orders', payload);
          toast((draft ? 'Draft saved · ' : 'Order created · ') + d.orderNumber, 'ok');
          close();
          go('order', d.id);
        } catch (e) { toast(e.message, 'bad'); }
      };
      $('[data-draft]', el).onclick = () => send(true);
      $('[data-save]', el).onclick = () => send(false);
    },
  });
}

/* ---------------------------------------------------------------- order detail */
Views.order = async function (root, id) {
  setHeader('Order', 'Loading…');
  root.innerHTML = loading();
  const o = await API.get('/api/orders/' + id);
  const isAdmin = App.user.role === 'admin';
  setHeader(o.orderNumber, o.designName || 'Order details');
  const canAssign = isAdmin && ['Draft', 'New', 'Rejected'].includes(o.status);

  root.innerHTML = `
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
      ${pill(o.status)}
      <span style="font-size:12px;color:var(--muted)">${fmtDate(o.createdAt)}</span>
      <span style="margin-left:auto;display:flex;gap:6px">
        ${canAssign ? '<button class="btn btn-sm btn-gold" id="assignBtn">Send to partner</button>' : ''}
        <button class="btn btn-sm" id="chatBtn">Chat</button>
      </span>
    </div>

    ${(o.allowedTransitions || []).length ? `<div class="card card-pad" style="margin-bottom:12px">
      <div class="sec-title" style="margin-top:0">Available actions</div>
      <div style="display:grid;gap:8px">
        ${o.allowedTransitions.map(t => `<button class="btn btn-block ${t === 'Cancelled' ? 'btn-danger' : ''}"
          data-tr="${esc(t)}">${esc(t)}</button>`).join('')}
      </div></div>` : ''}

    <div class="card">
      <div class="card-head"><h3>Details</h3></div>
      <div class="card-pad">
        <div class="stat"><span class="k">Customer</span><span class="v">${esc(o.customerName)}</span></div>
        <div class="stat"><span class="k">Phone</span><span class="v">${esc(o.customerPhone)}</span></div>
        ${o.customerAddress ? `<div class="stat"><span class="k">Address</span><span class="v" style="max-width:62%">${esc(o.customerAddress)}</span></div>` : ''}
        <div class="stat"><span class="k">Design</span><span class="v">${esc(o.designName || '—')}</span></div>
        <div class="stat"><span class="k">Code</span><span class="v">${esc(o.designCode || '—')}</span></div>
        <div class="stat"><span class="k">Colour</span><span class="v">${esc(o.fabricColour || '—')}</span></div>
        <div class="stat"><span class="k">Size / Qty</span><span class="v">${esc(o.size || '—')} · ${o.quantity}</span></div>
        ${isAdmin ? `
          <div class="stat"><span class="k">Price</span><span class="v">${money(o.orderPrice)}</span></div>
          <div class="stat"><span class="k">Advance</span><span class="v">${money(o.advancePaid)}</span></div>
          <div class="stat"><span class="k">Remaining</span><span class="v" style="color:${o.remaining > 0 ? 'var(--bad)' : 'var(--ok)'}">${money(o.remaining)}</span></div>` : ''}
        <div class="stat"><span class="k">Delivery</span><span class="v">${fmtDate(o.expectedDelivery)}</span></div>
      </div>
    </div>

    ${o.customInstructions || o.specialRequirements || o.additionalNotes || o.cancellationReason ? `
      <div class="card">
        <div class="card-head"><h3>Notes</h3></div>
        <div class="card-pad" style="display:grid;gap:10px">
          ${o.customInstructions ? `<div><strong style="font-size:12px">Instructions</strong><p style="font-size:13.8px;margin-top:3px">${esc(o.customInstructions)}</p></div>` : ''}
          ${o.specialRequirements ? `<div><strong style="font-size:12px">Special</strong><p style="font-size:13.8px;margin-top:3px">${esc(o.specialRequirements)}</p></div>` : ''}
          ${o.additionalNotes ? `<div><strong style="font-size:12px">Notes</strong><p style="font-size:13.8px;margin-top:3px">${esc(o.additionalNotes)}</p></div>` : ''}
          ${o.cancellationReason ? `<div><strong style="font-size:12px;color:var(--bad)">Cancellation reason</strong><p style="font-size:13.8px;margin-top:3px">${esc(o.cancellationReason)}</p></div>` : ''}
        </div>
      </div>` : ''}

    <div class="card">
      <div class="card-head"><h3>Photos</h3><span class="sp"></span>
        <button class="btn btn-sm" id="photoBtn">Upload</button></div>
      <div class="card-pad" id="photoBox">
        ${o.photos.length ? `<div class="gallery">${o.photos.map(p => `
          <figure data-photo="${p.id}"><img data-src="/api/photos/${p.id}" alt="">
          <figcaption>${esc(p.kind)}${p.is_superseded ? ' · old' : ''}</figcaption></figure>`).join('')}</div>`
          : `<div class="empty" style="padding:20px"><p>No photos yet</p></div>`}
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Timeline</h3></div>
      <div class="card-pad">
        ${o.timeline.length ? `<div class="timeline">${o.timeline.map((t, i) => `
          <div class="tl ${i === o.timeline.length - 1 ? 'done' : ''}">
            <div class="t">${esc(t.to_status)}</div>
            <div class="m">${esc(t.role)} · ${fmtDate(t.created_at, true)}</div>
            ${t.note ? `<div class="n">${esc(t.note)}</div>` : ''}
          </div>`).join('')}</div>` : '<p style="color:var(--muted);font-size:13px">No history</p>'}
      </div>
    </div>

    ${o.revisions.length ? `<div class="card">
      <div class="card-head"><h3>Revisions</h3></div>
      <div class="card-pad">${o.revisions.map(r => `<div style="padding:8px 0;border-bottom:1px dashed var(--line)">
        <strong style="font-size:13px">Revision ${r.revision_no}</strong>
        <div style="font-size:13px;margin-top:2px">${esc(r.notes)}</div>
        <div style="font-size:11px;color:var(--dim);margin-top:2px">${fmtDate(r.created_at, true)}</div>
      </div>`).join('')}</div>
    </div>` : ''}`;

  // protected images
  $$('[data-photo]', root).forEach(async (fig) => {
    const img = fig.querySelector('img');
    try { img.src = await protectedUrl(img.dataset.src); } catch (e) {}
    fig.onclick = () => {
      if (!img.src) return;
      sheet({ title: 'Photo', body: `<img src="${img.src}" style="width:100%;border-radius:14px">` });
    };
  });

  const assignBtn = $('#assignBtn');
  if (assignBtn) assignBtn.onclick = async () => {
    if (!(await ask('Send to partner', 'Assign this order to the production partner?', 'Assign'))) return;
    try { await API.post(`/api/orders/${o.id}/assign`, {}); toast('Order sent to partner', 'ok'); Views.order(root, id); }
    catch (e) { toast(e.message, 'bad'); }
  };
  $('#chatBtn').onclick = async () => {
    try { const d = await API.post('/api/chat/order', { orderId: o.id }); go('chat', d.id); }
    catch (e) { toast(e.message, 'bad'); }
  };
  $('#photoBtn').onclick = async () => {
    const file = await pickImage(true);
    if (!file) return;
    toast('Uploading…');
    try {
      const dataUrl = await readFileAsDataUrl(file);
      await API.post(`/api/orders/${o.id}/photos`, {
        kind: isAdmin ? 'reference' : 'progress', dataUrl });
      toast('Photo uploaded', 'ok');
      Views.order(root, id);
    } catch (e) { toast(e.message, 'bad'); }
  };

  $$('[data-tr]', root).forEach(b => b.onclick = async () => {
    const target = b.dataset.tr;
    if (target === 'Revision Requested') return revisionSheet(o, root, id);
    if (target === 'Cancelled') return cancelSheet(o, root, id);
    if (target === 'Rejected') return rejectSheet(o, root, id);
    if (!(await ask('Change status', `Move this order to "${target}"?`, 'Confirm'))) return;
    try {
      await API.post(`/api/orders/${o.id}/status`, { status: target });
      toast('Moved to ' + target, 'ok');
      Views.order(root, id);
    } catch (e) { toast(e.message, 'bad'); }
  });
};

function revisionSheet(o, root, id) {
  sheet({
    title: 'Request corrections',
    body: `<div class="field"><label>What needs fixing? *</label>
      <textarea id="rv" placeholder="Border stitching uneven near the hem"></textarea></div>`,
    footer: `<button class="btn" data-c>Cancel</button><button class="btn btn-primary" data-s>Send request</button>`,
    onMount(el, close) {
      $('[data-c]', el).onclick = close;
      $('[data-s]', el).onclick = async () => {
        const notes = $('#rv', el).value.trim();
        if (!notes) { toast('Describe the corrections', 'bad'); return; }
        try { await API.post(`/api/orders/${o.id}/revision`, { notes }); toast('Revision sent', 'ok'); close(); Views.order(root, id); }
        catch (e) { toast(e.message, 'bad'); }
      };
    },
  });
}

function cancelSheet(o, root, id) {
  sheet({
    title: 'Cancel order',
    body: `<p style="font-size:13.5px;color:var(--muted);margin-bottom:12px">A reason is required. The order is archived permanently in Project History.</p>
      <div class="field"><label>Reason *</label><textarea id="cr"></textarea></div>`,
    footer: `<button class="btn" data-c>Keep order</button><button class="btn btn-danger" data-s>Cancel order</button>`,
    onMount(el, close) {
      $('[data-c]', el).onclick = close;
      $('[data-s]', el).onclick = async () => {
        const reason = $('#cr', el).value.trim();
        if (!reason) { toast('A reason is required', 'bad'); return; }
        try { await API.post(`/api/orders/${o.id}/status`, { status: 'Cancelled', reason }); toast('Order cancelled', 'ok'); close(); Views.order(root, id); }
        catch (e) { toast(e.message, 'bad'); }
      };
    },
  });
}

function rejectSheet(o, root, id) {
  sheet({
    title: 'Reject order',
    body: `<div class="field"><label>Reason *</label><textarea id="rj" placeholder="Fabric unavailable this week"></textarea></div>`,
    footer: `<button class="btn" data-c>Cancel</button><button class="btn btn-danger" data-s>Reject</button>`,
    onMount(el, close) {
      $('[data-c]', el).onclick = close;
      $('[data-s]', el).onclick = async () => {
        const note = $('#rj', el).value.trim();
        if (!note) { toast('A reason is required', 'bad'); return; }
        try { await API.post(`/api/orders/${o.id}/status`, { status: 'Rejected', note }); toast('Order rejected', 'ok'); close(); Views.order(root, id); }
        catch (e) { toast(e.message, 'bad'); }
      };
    },
  });
}
