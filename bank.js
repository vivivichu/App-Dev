/* LifeLedger — bank sync (US banks via Plaid + your own sync server) and
   CSV statement import (any bank, e.g. Indian banks). Uses the API that app.js
   exposes on window.LifeLedger. */
(() => {
  'use strict';

  const LL = window.LifeLedger;
  const $ = (sel) => document.querySelector(sel);
  const { esc } = LL;
  const CONN_KEY = 'lifeledger:bank-conn'; // { url, passcode } — kept out of state/backups
  const LINK_KEY = 'lifeledger:plaid-link'; // { token, item_id } while an OAuth redirect is in flight
  const AUTO_SYNC_MS = 4 * 60 * 60 * 1000;

  // ===================================================================
  // Sync server connection
  // ===================================================================
  function getConn() {
    try { return JSON.parse(localStorage.getItem(CONN_KEY)) || null; } catch { return null; }
  }
  function setConn(conn) {
    try {
      if (conn) localStorage.setItem(CONN_KEY, JSON.stringify(conn)); else localStorage.removeItem(CONN_KEY);
    } catch {}
  }

  async function api(path, body) {
    const conn = getConn();
    if (!conn) throw new Error('Set up your sync server in Settings first');
    let res;
    try {
      res = await fetch(conn.url + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${conn.passcode}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error("Can't reach your sync server — check the URL and your connection");
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error('Sync server rejected the passcode');
    if (!res.ok) throw Object.assign(new Error(data.error || `Sync server error ${res.status}`), { code: data.code });
    return data;
  }

  // ===================================================================
  // Plaid → LifeLedger transactions
  // ===================================================================
  const PFC_PRIMARY = {
    FOOD_AND_DRINK: 'Dining', TRANSPORTATION: 'Transport', TRAVEL: 'Travel',
    RENT_AND_UTILITIES: 'Utilities', MEDICAL: 'Health', ENTERTAINMENT: 'Entertainment',
    GENERAL_MERCHANDISE: 'Shopping', INCOME: 'Income', TRANSFER_IN: 'Transfer', TRANSFER_OUT: 'Transfer',
    LOAN_PAYMENTS: 'Loan payments', BANK_FEES: 'Fees', PERSONAL_CARE: 'Personal care',
    GENERAL_SERVICES: 'Services', HOME_IMPROVEMENT: 'Home', GOVERNMENT_AND_NON_PROFIT: 'Taxes & donations',
  };
  const PFC_DETAILED = {
    FOOD_AND_DRINK_GROCERIES: 'Groceries', RENT_AND_UTILITIES_RENT: 'Rent',
    INCOME_WAGES: 'Salary', LOAN_PAYMENTS_CREDIT_CARD_PAYMENT: 'Transfer',
  };

  function plaidCategory(t, desc) {
    const learned = LL.state.categoryRules[LL.ruleKey(desc)];
    if (learned) return learned;
    const c = t.category;
    if (c) return PFC_DETAILED[c.detailed] || PFC_PRIMARY[c.primary] || LL.guessCategory(desc);
    return LL.guessCategory(desc);
  }

  function accountLabel(item, accountId) {
    const a = item.accounts?.find((x) => x.account_id === accountId);
    return a ? `${item.institution} ${a.name}${a.mask ? ' ••' + a.mask : ''}` : item.institution;
  }

  function toLedger(t, item) {
    const desc = t.merchant_name || t.name || 'Bank transaction';
    return {
      id: 'plaid:' + t.transaction_id,
      source: 'plaid',
      itemId: item.item_id,
      accountId: t.account_id,
      account: accountLabel(item, t.account_id),
      type: t.amount > 0 ? 'expense' : 'income', // Plaid: positive = money out
      amount: Math.round(Math.abs(t.amount) * 100) / 100,
      currency: t.currency || 'USD',
      date: t.date,
      note: desc,
      category: plaidCategory(t, desc),
      created: Date.now(),
    };
  }

  // ===================================================================
  // Sync
  // ===================================================================
  let syncing = false;
  async function sync({ quiet = false } = {}) {
    if (syncing || !getConn()) return;
    syncing = true;
    renderBank();
    const bank = LL.state.bank;
    let added = 0, removed = 0;
    const errors = [];
    try {
      for (let round = 0; round < 6; round++) {
        const cursors = Object.fromEntries(Object.entries(bank.items).map(([id, it]) => [id, it.cursor || null]));
        const { items } = await api('/api/sync', { cursors });
        const seen = new Set();
        let more = false;
        for (const r of items) {
          seen.add(r.item_id);
          const item = bank.items[r.item_id] || (bank.items[r.item_id] = { item_id: r.item_id });
          item.institution = r.institution;
          if (r.accounts?.length) item.accounts = r.accounts;
          if (r.error) {
            item.error = r.error;
            errors.push(`${r.institution}: ${r.error.message}`);
            continue;
          }
          item.error = null;
          // Pending transactions change or vanish once posted, so only keep posted ones.
          const upserts = [...r.added, ...r.modified].filter((t) => !t.pending).map((t) => toLedger(t, item));
          added += LL.upsertTransactions(upserts).added;
          removed += LL.removeTransactions(r.removed.map((id) => 'plaid:' + id));
          item.cursor = r.cursor;
          item.lastSync = Date.now();
          if (r.has_more) more = true;
        }
        // Banks disconnected from the server elsewhere: forget them (their transactions stay).
        for (const id of Object.keys(bank.items)) if (!seen.has(id)) delete bank.items[id];
        if (!more) break;
      }
      bank.lastSync = Date.now();
      LL.save();
      if (errors.length) LL.toast(errors[0]);
      else if (!quiet || added || removed) LL.toast(added || removed ? `Synced: ${added} new${removed ? `, ${removed} removed` : ''}` : 'Up to date');
    } catch (err) {
      bank.lastError = err.message;
      if (!quiet) LL.toast(err.message);
    } finally {
      syncing = false;
      renderBank();
    }
  }

  // ===================================================================
  // Plaid Link (connect a bank / fix a bank login)
  // ===================================================================
  let plaidScript;
  function loadPlaid() {
    if (window.Plaid) return Promise.resolve();
    plaidScript ||= new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
      s.onload = resolve;
      s.onerror = () => { plaidScript = null; reject(new Error("Couldn't load Plaid — check your connection")); };
      document.head.appendChild(s);
    });
    return plaidScript;
  }

  function openLink(token, itemId, receivedRedirectUri) {
    const handler = window.Plaid.create({
      token,
      receivedRedirectUri,
      onSuccess: async (publicToken, metadata) => {
        try { localStorage.removeItem(LINK_KEY); } catch {}
        try {
          if (!itemId) {
            const r = await api('/api/exchange', { public_token: publicToken, institution: metadata?.institution?.name });
            LL.toast(`${r.institution} connected — importing transactions…`);
          }
          await sync();
        } catch (err) { LL.toast(err.message); }
      },
      onExit: (err) => {
        try { localStorage.removeItem(LINK_KEY); } catch {}
        if (err) LL.toast(err.display_message || err.error_message || 'Bank connection cancelled');
      },
    });
    handler.open();
  }

  async function connect(itemId) {
    if (!getConn()) { LL.toast('Add your sync server in Settings first'); showSettings(); return; }
    try {
      const [{ link_token }] = await Promise.all([api('/api/link-token', itemId ? { item_id: itemId } : {}), loadPlaid()]);
      // Remember the token in case the bank sends us through an OAuth redirect.
      try { localStorage.setItem(LINK_KEY, JSON.stringify({ token: link_token, item_id: itemId || null })); } catch {}
      openLink(link_token, itemId);
    } catch (err) { LL.toast(err.message); }
  }

  // Returning from a bank's OAuth page: resume Link where it left off.
  async function resumeOAuth() {
    if (!new URLSearchParams(location.search).has('oauth_state_id')) return;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(LINK_KEY)); } catch {}
    const uri = location.href;
    history.replaceState(null, '', location.pathname);
    if (!saved?.token) { LL.toast('Bank sign-in finished in another window — tap Connect a bank again'); return; }
    try { await loadPlaid(); openLink(saved.token, saved.item_id, uri); } catch (err) { LL.toast(err.message); }
  }

  async function removeBank(itemId) {
    const item = LL.state.bank.items[itemId];
    const name = item?.institution || 'this bank';
    if (!confirm(`Disconnect ${name}?`)) return;
    try {
      await api('/api/remove', { item_id: itemId });
      delete LL.state.bank.items[itemId];
      const ids = LL.state.transactions.filter((t) => t.itemId === itemId).map((t) => t.id);
      // e.g. fake transactions from a Plaid sandbox test bank
      const purge = ids.length && confirm(`Also delete the ${ids.length} transaction${ids.length === 1 ? '' : 's'} imported from ${name}? Choose Cancel to keep them.`);
      if (purge) LL.removeTransactions(ids);
      LL.save();
      LL.toast(purge ? `${name} disconnected and its transactions deleted` : `${name} disconnected`);
    } catch (err) { LL.toast(err.message); }
  }

  // ===================================================================
  // Rendering
  // ===================================================================
  function ago(ms) {
    const m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
  }

  const LIABILITY = new Set(['credit', 'loan']);

  function renderBank() {
    const conn = getConn();
    const bank = LL.state.bank;
    const items = Object.values(bank.items);
    $('#bank-sync').hidden = !conn || !items.length;
    $('#bank-sync').disabled = syncing;
    $('#bank-sync').textContent = syncing ? 'Syncing…' : 'Sync now';

    let status;
    if (!conn) status = 'Connect your US bank accounts for automatic transactions. First set up your sync server under Settings → Bank sync server. For other banks (e.g. in India), use “Import bank statement” below.';
    else if (!items.length) status = 'Sync server connected. Tap “Connect a bank” to link an account.';
    else status = `Last synced ${bank.lastSync ? ago(bank.lastSync) : 'never'}. Syncs automatically when you open the app.`;
    if (conn && bank.lastError && !syncing) status += ` Last attempt failed: ${bank.lastError}`;
    $('#bank-status').textContent = status;

    let total = 0, convertible = true;
    $('#bank-accounts').innerHTML = items.map((it) => {
      const needsLogin = it.error?.code === 'ITEM_LOGIN_REQUIRED' || it.error?.code === 'PENDING_EXPIRATION';
      const accounts = (it.accounts || []).map((a) => {
        const owed = LIABILITY.has(a.type);
        if (a.balance != null) {
          const v = LL.toHome(a.balance, a.currency);
          if (v == null) convertible = false; else total += owed ? -v : v;
        }
        return `<li class="acct"><span class="title">${esc(a.name)}${a.mask ? ` <span class="muted">••${esc(a.mask)}</span>` : ''}
            <span class="sub">${esc(a.subtype || a.type)}</span></span>
          <span class="amt ${owed ? 'expense' : ''}">${a.balance == null ? '—' : (owed ? '−' : '') + esc(LL.money(a.balance, a.currency))}</span></li>`;
      }).join('');
      return `<li class="bank-item"><div class="bank-head">
          <strong class="title">${esc(it.institution || 'Bank')}</strong>
          ${it.error ? `<span class="tag overdue" title="${esc(it.error.message)}">${needsLogin ? 'Login needed' : 'Sync error'}</span>` : ''}
          ${needsLogin ? `<button class="small primary" data-bank="fix" data-id="${esc(it.item_id)}">Fix login</button>` : ''}
          <button class="icon-btn" data-bank="remove" data-id="${esc(it.item_id)}" aria-label="Disconnect ${esc(it.institution)}">✕</button>
        </div><ul class="list">${accounts || '<li><span class="title muted">Fetching accounts…</span></li>'}</ul></li>`;
    }).join('') + (items.some((i) => i.accounts?.length)
      ? `<li class="bank-total"><span class="title"><strong>Net balance</strong> <span class="muted">(cash minus credit cards/loans)</span></span>
          <strong class="amt">${convertible ? esc(LL.money(total)) : 'set exchange rates in Settings'}</strong></li>`
      : '');

    const form = $('#bank-config');
    if (document.activeElement?.form !== form) {
      form.url.value = conn?.url || '';
      form.passcode.value = conn?.passcode || '';
    }
    $('#bank-forget').hidden = !conn;
  }

  function showSettings() {
    document.querySelector('#tabs button[data-view="settings"]')?.click();
    $('#bank-config').url.focus();
  }

  // ===================================================================
  // CSV statement import
  // ===================================================================
  function detectDelimiter(text) {
    const sample = text.split(/\r?\n/).slice(0, 30).join('\n');
    const counts = { ',': 0, ';': 0, '\t': 0, '|': 0 };
    for (const ch of sample) if (ch in counts) counts[ch]++;
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  }

  // RFC 4180-style parser (quoted fields, escaped quotes, newlines inside quotes).
  function parseCSV(text) {
    text = text.replace(/^﻿/, '');
    const delim = detectDelimiter(text);
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
        } else field += ch;
      } else if (ch === '"') inQuotes = true;
      else if (ch === delim) { row.push(field); field = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += ch;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c));
  }

  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

  // Returns 'YYYY-MM-DD' or null. Accepts 05/11/2026, 5-11-26, 2026-11-05, 05 Nov 2026, 05-Nov-26, Nov 5, 2026.
  function parseDate(raw, fmt) {
    const s = String(raw).trim().replace(/[T ]\d{1,2}:\d{2}(:\d{2})?.*$/, '').replace(/,/g, ' ');
    const parts = s.split(/[\/\-. ]+/).filter(Boolean);
    if (parts.length !== 3) return null;
    let d, m, y;
    const monthIdx = parts.findIndex((p) => MONTHS[p.toLowerCase().slice(0, 4)] || MONTHS[p.toLowerCase().slice(0, 3)]);
    if (monthIdx >= 0) {
      m = MONTHS[parts[monthIdx].toLowerCase().slice(0, 4)] || MONTHS[parts[monthIdx].toLowerCase().slice(0, 3)];
      const rest = parts.filter((_, i) => i !== monthIdx).map(Number);
      if (rest.some(isNaN)) return null;
      [d, y] = rest[0] > 31 ? [rest[1], rest[0]] : [rest[0], rest[1]];
    } else {
      const n = parts.map(Number);
      if (n.some(isNaN)) return null;
      if (parts[0].length === 4) [y, m, d] = n;
      else if (fmt === 'mdy') [m, d, y] = n;
      else [d, m, y] = n;
    }
    if (y < 100) y += 2000;
    if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
    const dt = new Date(y, m - 1, d);
    if (dt.getMonth() !== m - 1) return null; // e.g. 31/02
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  // Pick the date order that parses every value; ambiguous files fall back by currency.
  function detectDateFormat(values, currency) {
    const nums = values.map((v) => String(v).trim().split(/[\/\-. ]+/)).filter((p) => p.length === 3 && /^\d+$/.test(p[0]) && /^\d+$/.test(p[1]));
    if (nums.some((p) => p[0].length === 4)) return 'ymd';
    if (nums.some((p) => Number(p[0]) > 12)) return 'dmy';
    if (nums.some((p) => Number(p[1]) > 12)) return 'mdy';
    return currency === 'USD' ? 'mdy' : 'dmy';
  }

  // "1,23,456.78", "₹ 500.00", "(45.00)", "500.00 Cr", "-" → number (NaN if empty)
  function parseAmount(raw) {
    let s = String(raw ?? '').trim();
    if (!s || s === '-' || s === '--') return NaN;
    let sign = 1;
    if (/^\(.*\)$/.test(s)) { sign = -1; s = s.slice(1, -1); }
    if (/\bdr\.?$/i.test(s)) { sign = -1; s = s.replace(/\bdr\.?$/i, ''); }
    s = s.replace(/\bcr\.?$/i, '');
    s = s.replace(/[^\d.\-]/g, '');
    if (s.startsWith('-')) { sign *= -1; s = s.slice(1); }
    const n = parseFloat(s);
    return isNaN(n) ? NaN : sign * n;
  }

  const COLUMN_GUESSES = {
    date: [/^(txn|transaction|tran|trans|posting|post)\.? ?date/i, /^date$/i, /date/i],
    desc: [/narration|description|particulars|remarks|details|payee|memo|merchant/i, /^name$/i],
    debit: [/withdraw|debit|^dr\.?$|paid out|money out|^outflow/i],
    credit: [/deposit|credit|^cr\.?$|paid in|money in|^inflow/i],
    amount: [/^amount/i, /transaction amount|txn amount|amt/i],
    drcr: [/dr ?\/ ?cr|cr ?\/ ?dr|^type$|debit ?\/ ?credit/i],
  };

  function guessColumn(headers, kind, exclude = []) {
    for (const re of COLUMN_GUESSES[kind]) {
      const i = headers.findIndex((h, idx) => re.test(h) && !exclude.includes(idx) && !/balance|value ?d|^bal$/i.test(h) && !(kind !== 'drcr' && COLUMN_GUESSES.drcr[0].test(h)));
      if (i >= 0) return i;
    }
    return -1;
  }

  // Statements often start with account details; the header is the first row naming a date column.
  function findHeaderRow(rows) {
    for (let i = 0; i < Math.min(rows.length, 60); i++) {
      const r = rows[i];
      if (r.filter(Boolean).length >= 3 && r.some((c) => /date/i.test(c)) && r.some((c) => /amount|debit|credit|withdraw|deposit|^dr|^cr|narration|description|particulars/i.test(c))) return i;
    }
    return 0;
  }

  // Short stable hash (FNV-1a) for de-duplicating imported rows.
  function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36);
  }

  let csv = null; // { headers, rows }

  function prefs() { try { return JSON.parse(localStorage.getItem('lifeledger:csv-prefs')) || {}; } catch { return {}; } }

  function openMapping(text, fileName) {
    const all = parseCSV(text);
    if (all.length < 2) { LL.toast("That file doesn't look like a CSV statement"); return; }
    const h = findHeaderRow(all);
    const headers = all[h].map((c, i) => c || `Column ${i + 1}`);
    csv = { headers, rows: all.slice(h + 1), fileName };
    const f = $('#csv-map');
    const opts = (withNone) => (withNone ? '<option value="-1">—</option>' : '') + headers.map((c, i) => `<option value="${i}">${esc(c)}</option>`).join('');
    for (const name of ['date', 'desc', 'amount']) f[name].innerHTML = opts(false);
    for (const name of ['debit', 'credit', 'drcr']) f[name].innerHTML = opts(true);

    const p = prefs();
    const dateI = guessColumn(headers, 'date');
    const debitI = guessColumn(headers, 'debit');
    const creditI = guessColumn(headers, 'credit', [debitI]);
    const amountI = guessColumn(headers, 'amount', [debitI, creditI]);
    const drcrI = guessColumn(headers, 'drcr');
    f.date.value = Math.max(dateI, 0);
    f.desc.value = Math.max(guessColumn(headers, 'desc'), 0);
    f.debit.value = debitI; f.credit.value = creditI; f.drcr.value = drcrI;
    f.amount.value = Math.max(amountI, debitI, 0);
    f.amountMode.value = debitI >= 0 && creditI >= 0 ? 'split' : drcrI >= 0 ? 'drcr' : 'signed';

    // Statements mentioning ₹/INR/Rs are INR; otherwise reuse the last choice (default INR,
    // since US banks are normally synced automatically).
    const cur = /₹|\bINR\b|\bRs\.?\s?\d/.test(text.slice(0, 20000)) ? 'INR' : (p.currency || 'INR');
    f.currency.innerHTML = LL.CURRENCIES.map((c) => `<option>${c}</option>`).join('');
    f.currency.value = cur;
    f.dateFmt.value = detectDateFormat(csv.rows.map((r) => r[f.date.value] || ''), cur);
    f.account.value = (p.accounts || {})[headers.join('|')] || '';
    f.hidden = false;
    updatePreview();
    f.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // Turn the mapped rows into transactions (+ counts of what was skipped).
  function mappedTransactions() {
    const f = $('#csv-map');
    const col = (name) => Number(f[name].value);
    const mode = f.amountMode.value;
    const account = f.account.value.trim();
    const currency = f.currency.value;
    const out = [];
    let skipped = 0;
    const seenKeys = new Map();
    for (const r of csv.rows) {
      const date = parseDate(r[col('date')] || '', f.dateFmt.value);
      let amt; // signed: negative = money out
      if (mode === 'split') {
        const out_ = parseAmount(r[col('debit')]), in_ = parseAmount(r[col('credit')]);
        amt = (isNaN(in_) ? 0 : Math.abs(in_)) - (isNaN(out_) ? 0 : Math.abs(out_));
      } else {
        amt = parseAmount(r[col('amount')]);
        if (mode === 'signed-inv') amt = -amt;
        if (mode === 'drcr') {
          const flag = String(r[col('drcr')] || '').trim().toLowerCase();
          amt = Math.abs(amt) * (/^d|debit|withdraw/.test(flag) ? -1 : 1);
        }
      }
      const desc = (r[col('desc')] || '').replace(/\s+/g, ' ').trim();
      if (!date || !amt || isNaN(amt)) { skipped++; continue; }
      const base = `${account}|${date}|${amt.toFixed(2)}|${desc}`;
      // Two identical rows on the same day (e.g. two ₹50 chai) are both real.
      const n = (seenKeys.get(base) || 0) + 1;
      seenKeys.set(base, n);
      out.push({
        id: `csv:${hash(base)}:${n}`,
        source: 'csv',
        account,
        type: amt < 0 ? 'expense' : 'income',
        amount: Math.round(Math.abs(amt) * 100) / 100,
        currency,
        date,
        note: desc || 'Bank transaction',
        category: LL.guessCategory(desc, amt > 0 ? 'Income' : 'Other'),
        created: Date.now(),
      });
    }
    return { txs: out, skipped };
  }

  function updatePreview() {
    const f = $('#csv-map');
    const mode = f.amountMode.value;
    for (const el of f.querySelectorAll('[data-mode]')) el.hidden = !el.dataset.mode.split(' ').includes(mode);
    const { txs, skipped } = mappedTransactions();
    const existing = new Set(LL.state.transactions.map((t) => t.id));
    const fresh = txs.filter((t) => !existing.has(t.id));
    const dates = txs.map((t) => t.date).sort();
    $('#csv-summary').innerHTML = txs.length
      ? `<b>${fresh.length}</b> new transaction${fresh.length === 1 ? '' : 's'} to import` +
        (txs.length - fresh.length ? ` · ${txs.length - fresh.length} already imported` : '') +
        (skipped ? ` · ${skipped} row${skipped === 1 ? '' : 's'} skipped (no date or amount)` : '') +
        ` · ${esc(LL.fmtDay(dates[0], { day: 'numeric', month: 'short', year: 'numeric' }))} – ${esc(LL.fmtDay(dates[dates.length - 1], { day: 'numeric', month: 'short', year: 'numeric' }))}`
      : '<span class="err">No transactions recognised — check the columns and date format above.</span>';
    $('#csv-preview').innerHTML = txs.length
      ? `<thead><tr><th>Date</th><th>Description</th><th>Category</th><th class="num">Amount</th></tr></thead><tbody>${
        txs.slice(0, 8).map((t) => `<tr><td>${esc(LL.fmtDay(t.date, { day: 'numeric', month: 'short', year: 'numeric' }))}</td><td>${esc(t.note.slice(0, 40))}</td><td>${esc(t.category)}</td>
          <td class="num ${t.type}">${t.type === 'income' ? '+' : '−'}${esc(LL.money(t.amount, t.currency))}</td></tr>`).join('')}</tbody>`
      : '';
    f.querySelector('button[type=submit]').disabled = !fresh.length;
  }

  function closeMapping() {
    csv = null;
    $('#csv-map').hidden = true;
    $('#csv-preview').innerHTML = '';
  }

  // ===================================================================
  // Events
  // ===================================================================
  $('#bank-connect').addEventListener('click', () => connect());
  $('#bank-sync').addEventListener('click', () => sync());
  $('#bank-accounts').addEventListener('click', (e) => {
    const b = e.target.closest('[data-bank]');
    if (!b) return;
    if (b.dataset.bank === 'fix') connect(b.dataset.id);
    if (b.dataset.bank === 'remove') removeBank(b.dataset.id);
  });

  $('#bank-config').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const url = f.url.value.trim().replace(/\/+$/, '');
    const passcode = f.passcode.value;
    if (!/^https:\/\//.test(url)) { LL.toast('Server URL must start with https://'); return; }
    const prev = getConn();
    setConn({ url, passcode });
    try {
      const r = await api('/api/ping');
      LL.state.bank.lastError = null;
      LL.toast(`Connected to sync server (${r.env})`);
      renderBank();
      sync({ quiet: true });
    } catch (err) {
      setConn(prev);
      LL.toast(err.message);
      renderBank();
    }
  });
  $('#bank-forget').addEventListener('click', () => {
    if (!confirm('Remove the sync server from this device? Your banks stay connected on the server and imported transactions are kept.')) return;
    setConn(null);
    renderBank();
  });

  $('#csv-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (/\.(xlsx?|pdf)$/i.test(file.name)) { LL.toast('Please save the statement as CSV first (open it in Numbers/Excel → Export → CSV)'); return; }
    openMapping(await file.text(), file.name);
  });
  $('#csv-map').addEventListener('change', (e) => {
    if (e.target.name === 'date') {
      const f = $('#csv-map');
      f.dateFmt.value = detectDateFormat(csv.rows.map((r) => r[f.date.value] || ''), f.currency.value);
    }
    updatePreview();
  });
  $('#csv-map').addEventListener('input', (e) => { if (e.target.name === 'account') updatePreview(); });
  $('#csv-cancel').addEventListener('click', closeMapping);
  $('#csv-map').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const { txs } = mappedTransactions();
    const existing = new Set(LL.state.transactions.map((t) => t.id));
    const fresh = txs.filter((t) => !existing.has(t.id));
    LL.upsertTransactions(fresh);
    try {
      const p = prefs();
      p.currency = f.currency.value;
      p.accounts = { ...(p.accounts || {}), [csv.headers.join('|')]: f.account.value.trim() };
      localStorage.setItem('lifeledger:csv-prefs', JSON.stringify(p));
    } catch {}
    const latest = fresh.map((t) => t.date).sort().pop();
    if (latest) $('#tx-month').value = latest.slice(0, 7);
    closeMapping();
    LL.save();
    const needRate = f.currency.value !== LL.home() && !(LL.state.settings.rates[f.currency.value] > 0);
    LL.toast(`Imported ${fresh.length} transaction${fresh.length === 1 ? '' : 's'}${needRate ? ` — set the ${f.currency.value} exchange rate in Settings` : ''}`);
  });

  // ===================================================================
  // Init
  // ===================================================================
  LL.onRender(renderBank);
  renderBank();
  resumeOAuth();
  const maybeAutoSync = () => {
    const last = LL.state.bank.lastSync || 0;
    if (getConn() && Object.keys(LL.state.bank.items).length && Date.now() - last > AUTO_SYNC_MS) sync({ quiet: true });
  };
  maybeAutoSync();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') maybeAutoSync(); });

  // Exposed for tests.
  window.LifeLedgerBank = { parseCSV, parseDate, parseAmount, detectDateFormat, findHeaderRow, sync };
})();
