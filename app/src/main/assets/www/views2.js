/* ============================================================
   KALKA BUSINESS HUB — module views (part 2)
   ============================================================ */
'use strict';

/* ---------------------------------------------------------------- customers */
Views.customers = async function (root) {
  setHeader('Customers', 'Clients and their order history');
  root.innerHTML = `
    <div class="searchbar">
      <input id="cSearch" placeholder="Search name or phone">
      <button class="btn btn-primary" id="addCust">+</button>
    </div>
    <div id="custList">${loading()}</div>`;
  $('#addCust').onclick = () => customerSheet();
  let t;
  $('#cSearch').oninput = (e) => { clearTimeout(t); t = setTimeout(() => load(e.target.value), 300); };

  async function load(q) {
    const d = await API.get('/api/customers?q=' + encodeURIComponent(q || ''));
    $('#custList').innerHTML = d.customers.length ? `<div class="list">${d.customers.map(c => `
      <button class="list-item" data-cust="${c.id}">
        <div class="avatar">${initials(c.full_name)}</div>
        <div class="li-main">
          <div class="li-t">${esc(c.full_name)}</div>
          <div class="li-s">${esc(c.phone)}${c.city ? ' · ' + esc(c.city) : ''}</div>
        </div>
        <div class="li-r"><span class="pill neutral">${c.orderCount} order${c.orderCount === 1 ? '' : 's'}</span></div>
      </button>`).join('')}</div>`
      : emptyState('☺', 'No customers yet', 'They are added automatically with each order.');
    $$('[data-cust]').forEach(b => b.onclick = () => customerSheet(b.dataset.cust));
  }
  await load('');
};

async function customerSheet(id) {
  let d = null;
  if (id) { try { d = await API.get('/api/customers/' + id); } catch (e) { toast(e.message, 'bad'); return; } }
  const c = d ? d.customer : {};
  sheet({
    title: id ? c.full_name : 'Add customer', tall: true,
    body: `
      <div class="row2">
        <div class="field"><label>Name *</label><input id="kName" value="${esc(c.full_name || '')}"></div>
        <div class="field"><label>Phone *</label><input id="kPhone" inputmode="tel" value="${esc(c.phone || '')}"></div>
      </div>
      <div class="row2">
        <div class="field"><label>City</label><input id="kCity" value="${esc(c.city || '')}"></div>
        <div class="field"><label>Email</label><input id="kEmail" inputmode="email" value="${esc(c.email || '')}"></div>
      </div>
      <div class="field"><label>Address</label><input id="kAddr" value="${esc(c.address || '')}"></div>
      <div class="field"><label>Notes</label><textarea id="kNotes">${esc(c.notes || '')}</textarea></div>
      ${d ? `
        <div class="sec-title">Orders (${d.orders.length})</div>
        ${d.orders.length ? d.orders.map(o => `<div class="list-item" style="padding:10px 0">
          <div class="li-main"><div class="li-t">${esc(o.order_number)}</div>
            <div class="li-s">${esc(o.design_name || 'Panjabi')}</div></div>
          <div class="li-r">${pill(o.status)}</div></div>`).join('')
          : '<p style="font-size:13px;color:var(--muted)">No orders yet</p>'}
        <div class="sec-title">Measurements (${d.measurements.length})</div>
        ${d.measurements.length ? d.measurements.map(m => `<div style="padding:8px 0;border-bottom:1px dashed var(--line)">
          <strong style="font-size:12.5px">v${m.version} · ${fmtDate(m.measured_at)}</strong>
          <div style="font-size:12.5px;color:var(--ink-2);margin-top:2px">
            ${Object.entries(m.values || {}).map(([k, v]) => `${esc(k.replace(/_/g, ' '))}: ${esc(v)}`).join(' · ') || '—'}
          </div></div>`).join('') : '<p style="font-size:13px;color:var(--muted)">None recorded</p>'}
        <button class="btn btn-block btn-sm" style="margin-top:10px" data-measure>+ New measurement</button>
        ${(d.payments || []).length ? `<div class="sec-title">Payments</div>
          ${d.payments.map(p => `<div class="stat"><span class="k">${esc(p.category)} · ${fmtDate(p.txn_date)}</span>
            <span class="v">${money(p.amount)}</span></div>`).join('')}` : ''}` : ''}`,
    footer: id ? `<button class="btn btn-primary" data-save>Save</button>`
               : `<button class="btn btn-primary" data-save>Add customer</button>`,
    onMount(el, close) {
      $('[data-save]', el).onclick = async () => {
        const body = {
          customerId: id || undefined,
          customerName: $('#kName', el).value.trim(),
          customerPhone: $('#kPhone', el).value.trim(),
          customerCity: $('#kCity', el).value.trim(),
          customerEmail: $('#kEmail', el).value.trim(),
          customerAddress: $('#kAddr', el).value.trim(),
          customerNotes: $('#kNotes', el).value.trim(),
        };
        if (!body.customerName || !body.customerPhone) { toast('Name and phone are required', 'bad'); return; }
        try {
          await API.post('/api/customers', body);
          toast('Saved', 'ok'); close(); Views.customers($('#main'));
        } catch (e) { toast(e.message, 'bad'); }
      };
      const m = $('[data-measure]', el);
      if (m) m.onclick = async () => {
        const f = await API.get('/api/measurement-fields');
        sheet({
          title: 'New measurement',
          body: `<div class="row2">${f.fields.map(x => `
            <div class="field"><label>${esc(x.label)} (${esc(x.unit)})</label>
              <input data-mf="${esc(x.field_key)}" inputmode="decimal"></div>`).join('')}</div>
            <div class="field"><label>Notes</label><textarea id="mn"></textarea></div>`,
          footer: `<button class="btn" data-c>Cancel</button><button class="btn btn-primary" data-s>Save</button>`,
          onMount(el2, close2) {
            $('[data-c]', el2).onclick = close2;
            $('[data-s]', el2).onclick = async () => {
              const values = {};
              $$('[data-mf]', el2).forEach(i => { if (i.value.trim()) values[i.dataset.mf] = i.value.trim(); });
              try {
                await API.post(`/api/customers/${id}/measurements`, { values, notes: $('#mn', el2).value.trim() });
                toast('Measurement saved', 'ok'); close2();
              } catch (e) { toast(e.message, 'bad'); }
            };
          },
        });
      };
    },
  });
}

/* ---------------------------------------------------------------- production */
Views.production = async function (root) {
  setHeader('Production', 'Work in progress');
  root.innerHTML = loading();
  const d = await API.get('/api/orders?status=active');
  const active = d.orders.filter(o => ['Accepted', 'Production Started', 'In Production',
                                       'Revision Requested', 'Ready for Review'].includes(o.status));
  root.innerHTML = active.length ? active.map(o => `
    <div class="card" style="margin-bottom:12px">
      <div class="card-pad">
        <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">
          <div>
            <strong style="font-size:15px">${esc(o.orderNumber)}</strong>
            <div style="font-size:13px;color:var(--muted)">${esc(o.customerName)} · ${esc(o.designName || 'Panjabi')}</div>
          </div>
          ${pill(o.status)}
        </div>
        <div class="stat" style="margin-top:8px"><span class="k">Delivery</span>
          <span class="v">${fmtDate(o.expectedDelivery)}</span></div>
        <div style="display:grid;gap:8px;margin-top:12px">
          <button class="btn btn-sm" data-open="${o.id}">Open order</button>
          ${o.status !== 'Ready for Review'
            ? `<button class="btn btn-sm btn-gold" data-ready="${o.id}">Mark ready for review</button>` : ''}
          ${['Accepted', 'Production Started'].includes(o.status)
            ? `<button class="btn btn-sm" data-start="${o.id}">Start production</button>` : ''}
        </div>
      </div>
    </div>`).join('') : emptyState('⚒', 'Nothing in production', 'Accepted orders appear here.');

  $$('[data-open]', root).forEach(b => b.onclick = () => go('order', b.dataset.open));
  const step = async (id, status) => {
    if (!(await ask('Update order', `Move this order to "${status}"?`, 'Confirm'))) return;
    try { await API.post(`/api/orders/${id}/status`, { status }); toast('Updated', 'ok'); Views.production(root); }
    catch (e) { toast(e.message, 'bad'); }
  };
  $$('[data-ready]', root).forEach(b => b.onclick = () => step(b.dataset.ready, 'Ready for Review'));
  $$('[data-start]', root).forEach(b => b.onclick = () => step(b.dataset.start, 'In Production'));
};

/* ---------------------------------------------------------------- inventory */
Views.inventory = async function (root) {
  const isAdmin = App.user.role === 'admin';
  setHeader('Inventory', 'Punjabi stock and materials');
  const cat = App.cache.invCat || 'all';
  root.innerHTML = `
    <div class="searchbar">
      <input id="iSearch" placeholder="Search item or code">
      ${isAdmin ? '<button class="btn btn-primary" id="addItem">+</button>' : ''}
    </div>
    <div class="chips">
      ${['all', 'Ready-Made Punjabi', 'Fabric', 'Raw Material', 'Packaging', 'Other Supply']
        .map(c => `<button class="chip ${cat === c ? 'on' : ''}" data-cat="${c}">${c === 'all' ? 'All' : c}</button>`).join('')}
    </div>
    <div id="invList">${loading()}</div>`;
  if (isAdmin) $('#addItem').onclick = () => inventorySheet();
  $$('[data-cat]', root).forEach(b => b.onclick = () => { App.cache.invCat = b.dataset.cat; Views.inventory(root); });
  let t;
  $('#iSearch').oninput = (e) => { clearTimeout(t); t = setTimeout(() => load(e.target.value), 300); };

  async function load(q) {
    const d = await API.get(`/api/inventory?category=${encodeURIComponent(cat)}&q=${encodeURIComponent(q || '')}`);
    $('#invList').innerHTML = d.items.length ? `<div class="list">${d.items.map(i => `
      <button class="list-item" data-item="${i.id}">
        <div class="li-main">
          <div class="li-t">${esc(i.item_name)}</div>
          <div class="li-s">${esc(i.category)}${i.colour ? ' · ' + esc(i.colour) : ''}${i.size ? ' · ' + esc(i.size) : ''}</div>
        </div>
        <div class="li-r">
          <div style="font-weight:700;font-size:14px">${i.quantity} ${esc(i.unit)}</div>
          ${i.low ? '<span class="pill bad" style="margin-top:3px">Low</span>' : ''}
        </div>
      </button>`).join('')}</div>`
      : emptyState('▤', 'No items', isAdmin ? 'Add your first item with +.' : 'The admin has not added stock yet.');
    $$('[data-item]', root).forEach(b => b.onclick = () => stockSheet(b.dataset.item));
  }
  await load('');
};

async function stockSheet(id) {
  const isAdmin = App.user.role === 'admin';
  const all = await API.get('/api/inventory');
  const item = all.items.find(x => x.id === id);
  if (!item) return;
  sheet({
    title: item.item_name, tall: true,
    body: `
      <div class="stat"><span class="k">Category</span><span class="v">${esc(item.category)}</span></div>
      <div class="stat"><span class="k">In stock</span><span class="v">${item.quantity} ${esc(item.unit)}</span></div>
      <div class="stat"><span class="k">Minimum</span><span class="v">${item.min_stock} ${esc(item.unit)}</span></div>
      ${isAdmin ? `<div class="stat"><span class="k">Cost</span><span class="v">${money(item.purchase_cost)}</span></div>` : ''}
      <div class="sec-title">Stock movement</div>
      <div class="field"><label>Type</label>
        <select id="sKind">
          <option value="in">Stock in</option><option value="out">Stock out</option>
          ${isAdmin ? '<option value="adjust">Adjust to</option>' : ''}
        </select></div>
      <div class="field"><label>Quantity</label><input id="sQty" type="number" inputmode="decimal" value="1"></div>
      <div class="field"><label>Reason</label><input id="sReason"></div>
      <div class="sec-title">History</div>
      <div id="sHist" style="font-size:13px">Loading…</div>`,
    footer: `<button class="btn" data-c>Close</button><button class="btn btn-primary" data-s>Record</button>`,
    onMount(el, close) {
      $('[data-c]', el).onclick = close;
      API.get(`/api/inventory/${id}/history`).then(h => {
        $('#sHist', el).innerHTML = h.history.length ? h.history.map(x =>
          `<div class="stat"><span class="k">${esc(x.kind)} · ${esc(x.who || '')} · ${timeAgo(x.created_at)}</span>
            <span class="v">${x.qty_before} → ${x.qty_after}</span></div>`).join('') : 'No movements yet';
      }).catch(() => {});
      $('[data-s]', el).onclick = async () => {
        try {
          const r = await API.post(`/api/inventory/${id}/stock`, {
            kind: $('#sKind', el).value,
            quantity: Number($('#sQty', el).value || 0),
            reason: $('#sReason', el).value.trim(),
          });
          toast('Stock now ' + r.quantity, 'ok');
          close(); Views.inventory($('#main'));
        } catch (e) { toast(e.message, 'bad'); }
      };
    },
  });
}

function inventorySheet() {
  sheet({
    title: 'Add inventory item', tall: true,
    body: `
      <div class="field"><label>Item name *</label><input id="nName"></div>
      <div class="row2">
        <div class="field"><label>Product code</label><input id="nCode"></div>
        <div class="field"><label>Category</label>
          <select id="nCat">${['Ready-Made Punjabi', 'Fabric', 'Raw Material', 'Packaging', 'Other Supply']
            .map(c => `<option>${c}</option>`).join('')}</select></div>
      </div>
      <div class="row2">
        <div class="field"><label>Colour</label><input id="nColour"></div>
        <div class="field"><label>Size</label><input id="nSize"></div>
      </div>
      <div class="row2">
        <div class="field"><label>Quantity</label><input id="nQty" type="number" value="0" inputmode="decimal"></div>
        <div class="field"><label>Unit</label><input id="nUnit" value="pcs"></div>
      </div>
      <div class="row2">
        <div class="field"><label>Min stock</label><input id="nMin" type="number" value="0" inputmode="decimal"></div>
        <div class="field"><label>Cost ₹</label><input id="nCost" type="number" value="0" inputmode="decimal"></div>
      </div>
      <div class="field"><label>Supplier</label><input id="nSup"></div>`,
    footer: `<button class="btn" data-c>Cancel</button><button class="btn btn-primary" data-s>Save item</button>`,
    onMount(el, close) {
      $('[data-c]', el).onclick = close;
      $('[data-s]', el).onclick = async () => {
        try {
          await API.post('/api/inventory', {
            itemName: $('#nName', el).value.trim(),
            productCode: $('#nCode', el).value.trim(),
            category: $('#nCat', el).value,
            colour: $('#nColour', el).value.trim(),
            size: $('#nSize', el).value.trim(),
            quantity: Number($('#nQty', el).value || 0),
            unit: $('#nUnit', el).value.trim() || 'pcs',
            minStock: Number($('#nMin', el).value || 0),
            purchaseCost: Number($('#nCost', el).value || 0),
            supplier: $('#nSup', el).value.trim(),
          });
          toast('Item added', 'ok'); close(); Views.inventory($('#main'));
        } catch (e) { toast(e.message, 'bad'); }
      };
    },
  });
}

/* ---------------------------------------------------------------- finance */
Views.finance = async function (root) {
  setHeader('Finance', 'Income, expenses and profit');
  const kind = App.cache.finKind || 'all';
  root.innerHTML = `
    <div class="chips">
      ${[['all', 'All'], ['income', 'Income'], ['expense', 'Expenses'], ['pending', 'Pending']]
        .map(([k, l]) => `<button class="chip ${kind === k ? 'on' : ''}" data-k="${k}">${l}</button>`).join('')}
    </div>
    <div style="display:grid;gap:8px;grid-template-columns:1fr 1fr;margin-bottom:12px">
      <button class="btn btn-sm" id="addIncome">+ Income</button>
      <button class="btn btn-sm btn-primary" id="addExpense">+ Expense</button>
    </div>
    <div id="finTotals"></div>
    <div id="finList">${loading()}</div>`;
  $$('[data-k]', root).forEach(b => b.onclick = () => { App.cache.finKind = b.dataset.k; Views.finance(root); });
  $('#addIncome').onclick = () => financeSheet('income');
  $('#addExpense').onclick = () => financeSheet('expense');

  const d = await API.get(`/api/finance?kind=${kind === 'pending' ? 'all' : kind}` +
                          `&status=${kind === 'pending' ? 'pending' : 'all'}`);
  if (d.totals) {
    $('#finTotals').innerHTML = `<div class="kpis" style="margin-bottom:12px">
      <div class="kpi"><div class="lbl">Revenue</div><div class="val" style="font-size:19px">${money(d.totals.income)}</div></div>
      <div class="kpi gold"><div class="lbl">Expenses</div><div class="val" style="font-size:19px">${money(d.totals.expense)}</div></div>
      <div class="kpi acc"><div class="lbl">Profit</div><div class="val" style="font-size:19px">${money(d.totals.profit)}</div></div>
      <div class="kpi"><div class="lbl">Pending</div><div class="val" style="font-size:19px">${money(d.totals.pending)}</div></div>
    </div>`;
  }
  $('#finList').innerHTML = d.transactions.length ? `<div class="list">${d.transactions.map(x => `
    <div class="list-item">
      <div class="li-main">
        <div class="li-t">${esc(x.category)} ${x.kind === 'income' ? '· in' : '· out'}</div>
        <div class="li-s">${fmtDate(x.txn_date)}${x.description ? ' · ' + esc(x.description) : ''}</div>
      </div>
      <div class="li-r">
        <div style="font-weight:700">${money(x.amount)}</div>
        <div style="margin-top:3px">
          ${x.approval_status === 'approved' ? '<span class="pill ok">OK</span>'
            : x.approval_status === 'rejected' ? '<span class="pill bad">Rejected</span>'
            : `<button class="btn btn-sm" data-ap="${x.id}">Approve</button>`}
        </div>
      </div>
    </div>`).join('')}</div>` : emptyState('₹', 'No transactions', 'Record income or an expense.');
  $$('[data-ap]', root).forEach(b => b.onclick = async () => {
    if (!(await ask('Approve expense', 'Approve this expense? It will count towards business costs.', 'Approve'))) return;
    try { await API.post(`/api/finance/${b.dataset.ap}/approve`, { approve: true }); toast('Approved', 'ok'); Views.finance(root); }
    catch (e) { toast(e.message, 'bad'); }
  });
};

async function financeSheet(kind) {
  const d = await API.get('/api/finance');
  const cats = kind === 'income' ? d.incomeCategories : d.expenseCategories;
  sheet({
    title: kind === 'income' ? 'Record income' : 'Record expense',
    body: `
      <div class="field"><label>Amount ₹ *</label><input id="fAmt" type="number" inputmode="decimal"></div>
      <div class="row2">
        <div class="field"><label>Category</label>
          <select id="fCat">${cats.map(c => `<option>${esc(c)}</option>`).join('')}</select></div>
        <div class="field"><label>Method</label>
          <select id="fMeth">${d.paymentMethods.map(m => `<option>${m}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label>Date</label><input id="fDate" type="date" value="${new Date().toISOString().slice(0, 10)}"></div>
      <div class="field"><label>Description</label><input id="fDesc"></div>
      ${kind === 'expense' && App.user.role === 'partner'
        ? '<p class="hint" style="color:var(--warn)">Partner expenses stay pending until the admin approves them.</p>' : ''}`,
    footer: `<button class="btn" data-c>Cancel</button><button class="btn btn-primary" data-s>Save</button>`,
    onMount(el, close) {
      $('[data-c]', el).onclick = close;
      $('[data-s]', el).onclick = async () => {
        try {
          const r = await API.post('/api/finance', {
            kind, amount: Number($('#fAmt', el).value || 0),
            category: $('#fCat', el).value,
            paymentMethod: $('#fMeth', el).value,
            txnDate: $('#fDate', el).value,
            description: $('#fDesc', el).value.trim(),
          });
          toast(r.status === 'pending' ? 'Sent for approval' : 'Recorded', 'ok');
          close();
          go(App.user.role === 'partner' ? 'expenses' : 'finance');
        } catch (e) { toast(e.message, 'bad'); }
      };
    },
  });
}

/* ---------------------------------------------------------------- partner payments */
Views.payments = async function (root) {
  setHeader('Partner payments', 'Approved expenses and settlements');
  root.innerHTML = loading();
  const d = await API.get('/api/partner-payments');
  root.innerHTML = `
    <div class="kpis">
      <div class="kpi"><div class="lbl">Approved</div><div class="val" style="font-size:19px">${money(d.approvedExpenses)}</div>
        <div class="ft">${d.approvedCount} entries</div></div>
      <div class="kpi gold"><div class="lbl">Pending</div><div class="val" style="font-size:19px">${money(d.pendingExpenses)}</div>
        <div class="ft">${d.pendingCount} waiting</div></div>
      <div class="kpi acc"><div class="lbl">Paid</div><div class="val" style="font-size:19px">${money(d.totalPaid)}</div></div>
      <div class="kpi"><div class="lbl">Outstanding</div><div class="val" style="font-size:19px">${money(d.balance)}</div></div>
    </div>
    <div style="margin:12px 0"><button class="btn btn-primary btn-block" id="recPay">+ Record payment</button></div>
    <div class="card">
      <div class="card-head"><h3>Payment history</h3></div>
      ${d.payments.length ? d.payments.map(p => `<div class="list-item">
        <div class="li-main"><div class="li-t">${money(p.amount)} · ${esc(p.method)}</div>
          <div class="li-s">${fmtDate(p.paid_on)}${p.notes ? ' · ' + esc(p.notes) : ''}</div></div>
      </div>`).join('') : emptyState('⇄', 'No payments yet', '')}
    </div>`;
  $('#recPay').onclick = () => sheet({
    title: 'Record partner payment',
    body: `
      <div class="field"><label>Amount ₹ *</label><input id="pAmt" type="number" inputmode="decimal"></div>
      <div class="row2">
        <div class="field"><label>Method</label><select id="pMeth">
          <option>Cash</option><option>UPI</option><option>Bank Transfer</option><option>Other</option></select></div>
        <div class="field"><label>Date</label><input id="pDate" type="date" value="${new Date().toISOString().slice(0, 10)}"></div>
      </div>
      <div class="field"><label>Notes</label><input id="pNotes"></div>`,
    footer: `<button class="btn" data-c>Cancel</button><button class="btn btn-primary" data-s>Record</button>`,
    onMount(el, close) {
      $('[data-c]', el).onclick = close;
      $('[data-s]', el).onclick = async () => {
        try {
          await API.post('/api/partner-payments', {
            amount: Number($('#pAmt', el).value || 0), method: $('#pMeth', el).value,
            paidOn: $('#pDate', el).value, notes: $('#pNotes', el).value.trim() });
          toast('Payment recorded', 'ok'); close(); Views.payments(root);
        } catch (e) { toast(e.message, 'bad'); }
      };
    },
  });
};

/* ---------------------------------------------------------------- expenses (partner) */
Views.expenses = async function (root) {
  setHeader('Expenses', 'Your submissions and their status');
  root.innerHTML = loading();
  const [d, fin] = await Promise.all([API.get('/api/partner-payments'), API.get('/api/finance?kind=expense')]);
  root.innerHTML = `
    <div class="kpis">
      <div class="kpi"><div class="lbl">Approved</div><div class="val" style="font-size:19px">${money(d.approvedExpenses)}</div></div>
      <div class="kpi gold"><div class="lbl">Pending</div><div class="val" style="font-size:19px">${money(d.pendingExpenses)}</div></div>
      <div class="kpi acc"><div class="lbl">Paid to you</div><div class="val" style="font-size:19px">${money(d.totalPaid)}</div></div>
      <div class="kpi"><div class="lbl">Balance</div><div class="val" style="font-size:19px">${money(d.balance)}</div></div>
    </div>
    <div style="margin:12px 0"><button class="btn btn-primary btn-block" id="subExp">+ Submit expense</button></div>
    <div class="card">
      <div class="card-head"><h3>Your submissions</h3></div>
      ${fin.transactions.length ? fin.transactions.map(x => `<div class="list-item">
        <div class="li-main"><div class="li-t">${esc(x.category)}</div>
          <div class="li-s">${fmtDate(x.txn_date)}${x.description ? ' · ' + esc(x.description) : ''}</div></div>
        <div class="li-r"><div style="font-weight:700">${money(x.amount)}</div>
          <div style="margin-top:3px">${x.approval_status === 'approved' ? '<span class="pill ok">Approved</span>'
            : x.approval_status === 'rejected' ? '<span class="pill bad">Rejected</span>'
            : '<span class="pill warn">Pending</span>'}</div></div>
      </div>`).join('') : emptyState('₹', 'No expenses yet', 'Submit production or material costs here.')}
    </div>`;
  $('#subExp').onclick = () => financeSheet('expense');
};

/* ---------------------------------------------------------------- projects */
Views.projects = async function (root) {
  setHeader('Projects', 'Every order as a live project');
  root.innerHTML = loading();
  const d = await API.get('/api/projects');
  root.innerHTML = d.projects.length ? `<div class="list">${d.projects.map(p => `
    <button class="list-item" data-p="${p.order_id}">
      <div class="li-main"><div class="li-t">${esc(p.project_code)} · ${esc(p.customer_name)}</div>
        <div class="li-s">${esc(p.order_number)} · ${timeAgo(p.updated_at)}</div></div>
      <div class="li-r">${pill(p.status)}</div>
    </button>`).join('')}</div>`
    : emptyState('◆', 'No projects', 'Projects appear automatically with each order.');
  $$('[data-p]', root).forEach(b => b.onclick = () => go('order', b.dataset.p));
};

/* ---------------------------------------------------------------- chat */
Views.chat = async function (root, id) {
  setHeader('Chat', 'Private conversation');
  root.innerHTML = loading();
  const d = await API.get('/api/chat');
  const active = id || (d.conversations[0] && d.conversations[0].id);
  if (!active) { root.innerHTML = emptyState('✉', 'No conversations', ''); return; }
  root.innerHTML = `
    ${d.conversations.length > 1 ? `<div class="chips">${d.conversations.map(c =>
      `<button class="chip ${c.id === active ? 'on' : ''}" data-c="${c.id}">${esc(c.title)}
        ${c.unread ? ' · ' + c.unread : ''}</button>`).join('')}</div>` : ''}
    <div class="card" style="display:flex;flex-direction:column;height:calc(100vh - 210px);min-height:340px">
      <div class="chat-scroll" id="chatScroll">${loading()}</div>
      <div class="chat-input">
        <button class="btn btn-sm" id="attachBtn">📎</button>
        <input id="chatText" placeholder="Message…" autocomplete="off">
        <button class="btn btn-primary" id="sendBtn">Send</button>
      </div>
    </div>`;
  $$('[data-c]', root).forEach(b => b.onclick = () => go('chat', b.dataset.c));

  const load = async () => {
    const m = await API.get(`/api/chat/${active}`);
    const box = $('#chatScroll');
    box.innerHTML = m.messages.length ? m.messages.map(msg => {
      const mine = msg.sender_id === App.user.id;
      const att = (msg.attachments || []).map(a =>
        `<div style="margin-top:5px"><button class="btn btn-sm" data-att="${a.id}">📎 ${esc(a.name || 'file')}</button></div>`).join('');
      return `<div class="bubble ${mine ? 'me' : 'them'}">${msg.body ? esc(msg.body) : ''}${att}
        <div class="meta">${esc(msg.sender_name || '')} · ${fmtDate(msg.created_at, true)}</div></div>`;
    }).join('') : `<div class="empty" style="padding:24px"><p>Say hello 👋</p></div>`;
    $$('[data-att]', box).forEach(b => b.onclick = async () => {
      try {
        const url = await protectedUrl('/api/chat/attachment/' + b.dataset.att);
        sheet({ title: 'Attachment', body: `<img src="${url}" style="width:100%;border-radius:12px">` });
      } catch (e) { toast(e.message, 'bad'); }
    });
    box.scrollTop = box.scrollHeight;
  };
  const send = async () => {
    const input = $('#chatText');
    const body = input.value.trim();
    if (!body) return;
    input.value = '';
    try { await API.post(`/api/chat/${active}`, { body }); await load(); }
    catch (e) { toast(e.message, 'bad'); }
  };
  $('#sendBtn').onclick = send;
  $('#chatText').onkeydown = (e) => { if (e.key === 'Enter') send(); };
  $('#attachBtn').onclick = async () => {
    const f = await pickImage(false);
    if (!f) return;
    try {
      await API.post(`/api/chat/${active}/attachment`, { dataUrl: await readFileAsDataUrl(f), name: f.name });
      await load();
    } catch (e) { toast(e.message, 'bad'); }
  };
  await load();
  clearInterval(App.chatTimer);
  App.chatTimer = setInterval(() => { if (App.route === 'chat') load().catch(() => {}); }, 6000);
};

/* ---------------------------------------------------------------- notifications */
Views.notifications = async function (root) {
  setHeader('Notifications', 'What needs your attention');
  root.innerHTML = loading();
  const d = await API.get('/api/notifications');
  root.innerHTML = `
    ${d.unread ? `<div style="margin-bottom:12px"><button class="btn btn-sm btn-block" id="markAll">
      Mark all read (${d.unread})</button></div>` : ''}
    <div class="card">
      ${d.notifications.length ? d.notifications.map(n => `<div class="list-item">
        <div class="avatar" style="${n.is_read ? 'background:var(--cream-2)' : ''}">${n.is_read ? '◔' : '●'}</div>
        <div class="li-main"><div class="li-t">${esc(n.title)}</div>
          <div class="li-s">${esc(n.body || '')} · ${timeAgo(n.created_at)}</div></div>
      </div>`).join('') : emptyState('◔', 'All clear', 'No notifications yet.')}
    </div>`;
  const m = $('#markAll');
  if (m) m.onclick = async () => {
    await API.post('/api/notifications/read', {});
    toast('Marked read', 'ok');
    Views.notifications(root);
  };
  if (d.unread) { API.post('/api/notifications/read', {}).then(refreshBadge).catch(() => {}); }
};

/* ---------------------------------------------------------------- reports */
Views.reports = async function (root) {
  setHeader('Reports', 'Business reporting');
  const list = [
    ['daily-sales', 'Daily sales'], ['monthly-revenue', 'Monthly revenue'],
    ['monthly-expense', 'Monthly expenses'], ['profit-loss', 'Profit & loss'],
    ['customers', 'Customers'], ['order-completion', 'Completed'],
    ['cancelled', 'Cancelled'], ['inventory', 'Inventory'],
    ['low-stock', 'Low stock'], ['partner-activity', 'Partner activity'], ['payments', 'Payments'],
  ];
  const cur = App.cache.report || 'daily-sales';
  root.innerHTML = `
    <div class="chips">${list.map(([k, l]) =>
      `<button class="chip ${cur === k ? 'on' : ''}" data-r="${k}">${l}</button>`).join('')}</div>
    <div class="row2" style="margin-bottom:12px">
      <div class="field" style="margin:0"><label>From</label><input id="rFrom" type="date"></div>
      <div class="field" style="margin:0"><label>To</label><input id="rTo" type="date"></div>
    </div>
    <div id="repBody">${loading()}</div>`;
  $$('[data-r]', root).forEach(b => b.onclick = () => { App.cache.report = b.dataset.r; Views.reports(root); });
  const d = await API.get(`/api/reports/${cur}`);
  const rows = d.rows || [];
  const headers = rows.length ? Object.keys(rows[0]) : [];
  $('#repBody').innerHTML = rows.length ? `
    <div class="card" style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:12.5px">
        <thead><tr>${headers.map(h => `<th style="text-align:left;padding:10px;background:var(--cream-2);
          font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)">${esc(h.replace(/_/g, ' '))}</th>`).join('')}</tr></thead>
        <tbody>${rows.map(r => `<tr>${headers.map(h => {
          const v = r[h];
          return `<td style="padding:10px;border-bottom:1px solid var(--line)">${
            typeof v === 'number' && !Number.isInteger(v) ? money(v) : esc(v)}</td>`;
        }).join('')}</tr>`).join('')}</tbody>
      </table>
    </div>` : emptyState('▦', 'No data', 'Nothing recorded for this report yet.');
};

/* ---------------------------------------------------------------- settings */
Views.settings = async function (root) {
  setHeader('Settings', 'Business, security and account');
  root.innerHTML = loading();
  const [s, acc] = await Promise.all([API.get('/api/settings'), API.get('/api/accounts').catch(() => ({ accounts: [] }))]);
  const st = s.settings;
  root.innerHTML = `
    <div class="card">
      <div class="card-head"><h3>Business</h3></div>
      <div class="card-pad">
        <div class="field"><label>Business name</label><input id="sName" value="${esc(st.business_name || '')}"></div>
        <div class="field"><label>Tagline</label><input id="sTag" value="${esc(st.business_tagline || '')}"></div>
        <button class="btn btn-primary btn-block" id="saveSet">Save</button>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Fingerprint protection</h3></div>
      <div class="card-pad" id="bioPanel">${loading()}</div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Accounts</h3></div>
      <div class="card-pad">
        ${acc.accounts.map(a => `<div class="stat">
          <span class="k">${esc(a.email)}<br><small style="color:var(--dim);text-transform:capitalize">${esc(a.role)}</small></span>
          <span class="v">${a.role === 'admin' ? '<span class="pill info">Owner</span>'
            : a.is_active ? '<span class="pill ok">Authorized</span>' : '<span class="pill bad">Suspended</span>'}
            ${a.role === 'partner' ? `<button class="btn btn-sm" style="margin-left:6px"
              data-auth="${a.id}" data-active="${a.is_active ? 0 : 1}">${a.is_active ? 'Suspend' : 'Authorize'}</button>` : ''}
          </span></div>`).join('')}
        <p class="hint" style="margin-top:10px">Exactly two accounts exist. No third account can be created.</p>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Your account</h3></div>
      <div class="card-pad">
        <div class="stat"><span class="k">Name</span><span class="v">${esc(App.user.fullName)}</span></div>
        <div class="stat"><span class="k">Email</span><span class="v">${esc(App.user.email)}</span></div>
        <button class="btn btn-block btn-sm" style="margin-top:10px" id="pwBtn">Change password</button>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Activity log</h3></div>
      <div class="card-pad" id="actLog">${loading()}</div>
    </div>`;

  $('#saveSet').onclick = async () => {
    try {
      await API.put('/api/settings', { business_name: $('#sName').value.trim(),
                                       business_tagline: $('#sTag').value.trim() });
      toast('Saved', 'ok');
    } catch (e) { toast(e.message, 'bad'); }
  };
  $$('[data-auth]', root).forEach(b => b.onclick = async () => {
    const active = b.dataset.active === '1';
    if (!(await ask(active ? 'Authorize partner' : 'Suspend partner',
                    `${active ? 'Authorize' : 'Suspend'} this partner account?`,
                    active ? 'Authorize' : 'Suspend', !active))) return;
    try { await API.post(`/api/accounts/${b.dataset.auth}/authorize`, { active });
      toast('Updated', 'ok'); Views.settings(root); } catch (e) { toast(e.message, 'bad'); }
  });
  $('#pwBtn').onclick = () => passwordSheet();
  renderBioPanel();
  API.get('/api/activity').then(d => {
    $('#actLog').innerHTML = d.activity.length ? `<div class="timeline">${d.activity.slice(0, 25).map(a => `
      <div class="tl"><div class="t" style="font-size:13px">${esc(prettyAction(a.action))}</div>
        <div class="m">${esc(a.who || 'system')} · ${fmtDate(a.created_at, true)}</div></div>`).join('')}</div>`
      : '<p style="font-size:13px;color:var(--muted)">No activity</p>';
  }).catch(() => {});
};

/* ---------------------------------------------------------------- profile */
Views.profile = async function (root) {
  setHeader('Profile', 'Your account');
  root.innerHTML = `
    <div class="card">
      <div class="card-pad" style="display:flex;gap:14px;align-items:center">
        <div class="avatar lg">${initials(App.user.fullName)}</div>
        <div><strong style="font-size:16px">${esc(App.user.fullName)}</strong>
          <div style="font-size:12.5px;color:var(--muted)">${esc(App.user.email)}</div>
          <div style="font-size:11px;color:var(--dim);text-transform:capitalize;margin-top:2px">${esc(App.user.role)}</div></div>
      </div>
    </div>
    <div class="card">
      <div class="card-pad">
        <div class="field"><label>Full name</label><input id="pName" value="${esc(App.user.fullName)}"></div>
        <div class="field"><label>Phone</label><input id="pPhone" value="${esc(App.user.phone || '')}" inputmode="tel"></div>
        <button class="btn btn-primary btn-block" id="pSave">Save</button>
      </div>
    </div>
    <div class="card">
      <div class="card-pad">
        <button class="btn btn-block btn-sm" id="pPw">Change password</button>
        <button class="btn btn-block btn-danger" style="margin-top:8px" id="pOut">Sign out</button>
      </div>
    </div>`;
  $('#pSave').onclick = async () => {
    toast('Profile saved', 'ok');
    App.user.fullName = $('#pName').value.trim() || App.user.fullName;
  };
  $('#pPw').onclick = () => passwordSheet();
  $('#pOut').onclick = async () => {
    if (await ask('Sign out', 'Sign out of KALKA BUSINESS HUB?', 'Sign out')) Views.logout();
  };
};

function passwordSheet() {
  sheet({
    title: 'Change password',
    body: `
      <div class="field"><label>Current password</label><input type="password" id="cpOld"></div>
      <div class="field"><label>New password</label><input type="password" id="cpNew"></div>
      <p class="hint">At least 8 characters. Other devices are signed out.</p>`,
    footer: `<button class="btn" data-c>Cancel</button><button class="btn btn-primary" data-s>Update</button>`,
    onMount(el, close) {
      $('[data-c]', el).onclick = close;
      $('[data-s]', el).onclick = async () => {
        try {
          await API.post('/api/change-password', {
            currentPassword: $('#cpOld', el).value, newPassword: $('#cpNew', el).value });
          toast('Password updated', 'ok'); close();
        } catch (e) { toast(e.message, 'bad'); }
      };
    },
  });
}
