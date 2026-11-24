/* LifeLedger — personal finance & daily activity tracker.
   All data lives in localStorage under STORAGE_KEY. */
(() => {
  'use strict';

  const STORAGE_KEY = 'lifeledger:v1';
  const MOODS = [
    { v: 1, e: '😞', l: 'Awful' },
    { v: 2, e: '😕', l: 'Bad' },
    { v: 3, e: '😐', l: 'Okay' },
    { v: 4, e: '🙂', l: 'Good' },
    { v: 5, e: '😄', l: 'Great' },
  ];
  const DEFAULT_CATEGORIES = ['Groceries', 'Rent', 'Transport', 'Dining', 'Utilities', 'Health', 'Shopping', 'Entertainment', 'Salary', 'Transfer', 'Other'];
  // Transactions in this category (moving money between your own accounts, paying a
  // credit card) are listed but left out of income/spending totals.
  const TRANSFER = 'Transfer';
  const CURRENCIES = ['USD', 'INR', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'SGD', 'AED', 'CHF', 'CNY', 'BRL'];

  // ---------- helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const isoDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const isoMonth = (d = new Date()) => isoDate(d).slice(0, 7);
  const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return isoDate(d); };
  const fmtDay = (iso, opts = { month: 'short', day: 'numeric' }) => new Date(iso + 'T00:00:00').toLocaleDateString(undefined, opts);
  const today = () => isoDate();

  const home = () => state.settings.currency;
  function money(n, currency = home()) {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(n);
    } catch {
      return `${Number(n).toFixed(2)} ${currency}`;
    }
  }

  // Value of an amount in the home currency, or null when no exchange rate is set.
  // settings.rates[c] = how much 1 unit of currency c is worth in the home currency.
  function toHome(amount, currency) {
    const c = currency || home();
    if (c === home()) return amount;
    const rate = Number(state.settings.rates?.[c]);
    return rate > 0 ? amount * rate : null;
  }
  const countsInTotals = (t) => t.category !== TRANSFER;
  // Currencies used by transactions that have no exchange rate yet.
  const missingRates = () => [...new Set(state.transactions
    .map((t) => t.currency || home())
    .filter((c) => c !== home() && !(Number(state.settings.rates?.[c]) > 0)))];

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 1800);
  }

  // ---------- state ----------
  const emptyState = () => ({
    transactions: [],
    budgets: {},
    tasks: [],
    habits: [],
    journal: [],
    recurring: [],
    settings: { currency: 'USD', rates: {} },
    categoryRules: {}, // learned: normalized description -> category
    bank: { items: {} }, // item_id -> { institution, cursor, accounts, lastSync, error }
  });

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return emptyState();
      return normalize(JSON.parse(raw));
    } catch {
      return emptyState();
    }
  }

  function normalize(data) {
    const base = emptyState();
    if (!data || typeof data !== 'object') return base;
    const out = {
      transactions: Array.isArray(data.transactions) ? data.transactions : [],
      budgets: data.budgets && typeof data.budgets === 'object' ? data.budgets : {},
      tasks: Array.isArray(data.tasks) ? data.tasks : [],
      habits: Array.isArray(data.habits) ? data.habits.map((h) => ({ ...h, log: h.log || {} })) : [],
      journal: Array.isArray(data.journal) ? data.journal : [],
      recurring: Array.isArray(data.recurring) ? data.recurring : [],
      settings: { ...base.settings, ...(data.settings || {}), rates: { ...(data.settings?.rates || {}) } },
      categoryRules: data.categoryRules && typeof data.categoryRules === 'object' ? data.categoryRules : {},
      bank: { items: { ...(data.bank?.items || {}) } },
    };
    // Older data had no per-item currency: it was all in the home currency of the time.
    const cur = out.settings.currency;
    for (const t of out.transactions) if (!t.currency) t.currency = cur;
    for (const r of out.recurring) if (!r.currency) r.currency = cur;
    return out;
  }

  let state = load();
  let storageOk = true;

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      if (storageOk) toast('Could not save — browser storage unavailable');
      storageOk = false;
    }
    render();
  }

  // ---------- recurring & bills ----------
  // A recurring item is { id, name, type, amount, category, frequency, next, day, mode, active, done }.
  // mode 'auto' posts a transaction on each due date; mode 'remind' waits for the user to mark it paid.
  const FREQ_LABEL = { weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly', once: 'One time' };
  const REMIND_DAYS = 3;
  const daysUntil = (iso) => Math.round((new Date(iso + 'T00:00:00') - new Date(today() + 'T00:00:00')) / 86400000);

  // Move an item to its next due date. Monthly/yearly keep the original day of month,
  // clamped to the month's length (e.g. the 31st becomes Feb 28, then back to Mar 31).
  function advance(r) {
    if (r.frequency === 'once') { r.active = false; r.done = true; return; }
    if (r.frequency === 'weekly') { r.next = addDays(r.next, 7); return; }
    const d = new Date(r.next + 'T00:00:00');
    const target = new Date(d.getFullYear() + (r.frequency === 'yearly' ? 1 : 0), d.getMonth() + (r.frequency === 'monthly' ? 1 : 0), 1);
    const daysInMonth = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    target.setDate(Math.min(r.day || d.getDate(), daysInMonth));
    r.next = isoDate(target);
  }

  function recordFromRecurring(r, date) {
    state.transactions.push({
      id: uid(), created: Date.now(), type: r.type, amount: r.amount, currency: r.currency || home(),
      category: r.category, date, note: r.name, recurringId: r.id,
    });
  }

  // Post every auto item that has come due (including any missed while the app was closed).
  function processRecurring() {
    let added = 0;
    for (const r of state.recurring) {
      let guard = 0;
      while (r.mode === 'auto' && r.active && r.next <= today() && guard++ < 500) {
        recordFromRecurring(r, r.next);
        advance(r);
        added++;
      }
    }
    return added;
  }

  const billsDue = () => state.recurring
    .filter((r) => r.mode === 'remind' && r.active && daysUntil(r.next) <= REMIND_DAYS)
    .sort((a, b) => a.next.localeCompare(b.next));

  function dueTag(r) {
    if (r.done) return '<span class="tag">Done</span>';
    if (!r.active) return '<span class="tag">Paused</span>';
    const n = daysUntil(r.next);
    if (n < 0) return `<span class="tag overdue">Overdue · ${esc(fmtDay(r.next))}</span>`;
    if (n === 0) return '<span class="tag soon">Due today</span>';
    if (n === 1) return '<span class="tag soon">Tomorrow</span>';
    if (n <= REMIND_DAYS) return `<span class="tag soon">In ${n} days</span>`;
    return `<span class="tag">${esc(fmtDay(r.next))}</span>`;
  }

  const signedAmount = (r) => `<span class="amt ${r.type}">${r.type === 'income' ? '+' : '−'}${esc(money(r.amount, r.currency))}</span>`;

  // ---------- derived data ----------
  const txInMonth = (month) => state.transactions.filter((t) => t.date.startsWith(month));

  function monthTotals(month) {
    let income = 0, expense = 0;
    for (const t of txInMonth(month)) {
      const v = countsInTotals(t) ? toHome(t.amount, t.currency) : null;
      if (v == null) continue;
      if (t.type === 'income') income += v; else expense += v;
    }
    return { income, expense, net: income - expense };
  }

  function spendByCategory(month) {
    const map = {};
    for (const t of txInMonth(month)) {
      const v = t.type === 'expense' && countsInTotals(t) ? toHome(t.amount, t.currency) : null;
      if (v != null) map[t.category] = (map[t.category] || 0) + v;
    }
    return Object.entries(map).sort((a, b) => b[1] - a[1]);
  }

  function habitStreak(h) {
    let streak = 0;
    let d = today();
    if (!h.log[d]) d = addDays(d, -1); // today not done yet doesn't break streak
    while (h.log[d]) { streak++; d = addDays(d, -1); }
    return streak;
  }

  const sortTasks = (a, b) =>
    (a.done - b.done) ||
    ((a.due || '9999') < (b.due || '9999') ? -1 : (a.due || '9999') > (b.due || '9999') ? 1 : 0) ||
    (prioRank(a.priority) - prioRank(b.priority));
  const prioRank = (p) => ({ high: 0, normal: 1, low: 2 }[p] ?? 1);

  // ---------- rendering ----------
  function render() {
    renderDashboard();
    renderMoney();
    renderTasks();
    renderHabits();
    renderJournal();
    renderRecurring();
    renderCategoryList();
    renderCurrencies();
    for (const fn of renderHooks) fn();
  }
  const renderHooks = []; // extra renderers registered by bank.js

  function rateWarning() {
    const miss = missingRates();
    return miss.length
      ? `<p class="warn-note">Set an exchange rate for ${esc(miss.join(', '))} in Settings to include those transactions in totals.</p>`
      : '';
  }

  function renderCurrencies() {
    const sel = $('#currency');
    if (sel.options.length !== CURRENCIES.length) sel.innerHTML = CURRENCIES.map((c) => `<option>${c}</option>`).join('');
    sel.value = home();
    const txCur = $('#tx-form').currency;
    const seen = new Set([home(), ...CURRENCIES, ...state.transactions.map((t) => t.currency)]);
    const keep = txCur.value;
    txCur.innerHTML = [...seen].map((c) => `<option>${esc(c)}</option>`).join('');
    txCur.value = keep && seen.has(keep) ? keep : home();
    // Rates for every non-home currency that appears in your data.
    const foreign = [...new Set([...state.transactions.map((t) => t.currency), ...Object.keys(state.settings.rates)])]
      .filter((c) => c && c !== home()).sort();
    $('#rates').innerHTML = foreign.length
      ? foreign.map((c) => `<label class="inline rate-row">1 ${esc(c)} =
          <input type="number" step="any" min="0" data-rate="${esc(c)}" value="${esc(state.settings.rates[c] ?? '')}" placeholder="rate" class="rate-input" /> ${esc(home())}</label>`).join('')
      : '<p class="muted hint">Rates appear here once you have transactions in another currency.</p>';
  }

  function statHtml(label, value, cls = '') {
    return `<div class="stat"><div class="label">${esc(label)}</div><div class="value ${cls}">${esc(value)}</div></div>`;
  }

  function barRow(label, value, max, rightText, cls = '') {
    const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
    return `<div class="bar-row"><div class="bar-label"><span>${esc(label)}</span><span>${esc(rightText)}</span></div>
      <div class="bar"><div class="${cls}" style="width:${pct.toFixed(1)}%"></div></div></div>`;
  }

  function budgetRows(month) {
    const spent = Object.fromEntries(spendByCategory(month));
    return Object.entries(state.budgets)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([cat, limit]) => {
        const s = spent[cat] || 0;
        const ratio = limit > 0 ? s / limit : s > 0 ? 2 : 0;
        const cls = ratio > 1 ? 'over' : ratio > 0.8 ? 'warn' : '';
        return { cat, limit, s, cls };
      });
  }

  function renderDashboard() {
    const month = isoMonth();
    const { income, expense, net } = monthTotals(month);
    const openTasks = state.tasks.filter((t) => !t.done);
    const dueToday = openTasks.filter((t) => t.due && t.due <= today());
    const doneHabits = state.habits.filter((h) => h.log[today()]).length;

    $('#dash-warn').innerHTML = rateWarning();
    $('#dash-stats').innerHTML =
      statHtml('Income this month', money(income), 'income') +
      statHtml('Spent this month', money(expense), 'expense') +
      statHtml('Net this month', money(net), net >= 0 ? 'income' : 'expense') +
      statHtml('Tasks due / habits done', `${dueToday.length} · ${doneHabits}/${state.habits.length}`);

    const cats = spendByCategory(month);
    const maxCat = cats[0]?.[1] || 0;
    $('#dash-categories').innerHTML = cats.length
      ? cats.slice(0, 8).map(([c, v]) => barRow(c, v, maxCat, money(v))).join('')
      : '<p class="empty">No spending recorded this month.</p>';

    const rows = budgetRows(month);
    $('#dash-budgets').innerHTML = rows.length
      ? rows.map((r) => barRow(r.cat, r.s, r.limit, `${money(r.s)} / ${money(r.limit)}`, r.cls)).join('')
      : '<p class="empty">Set budgets on the Money tab.</p>';

    const tasksForToday = openTasks.filter((t) => !t.due || t.due <= today()).sort(sortTasks).slice(0, 8);
    $('#dash-tasks').innerHTML = tasksForToday.length
      ? tasksForToday.map(taskLi).join('')
      : '<li><span class="title muted">All clear for today 🎉</span></li>';

    $('#dash-habits').innerHTML = state.habits.length
      ? state.habits.map((h) => `<li>
          <input type="checkbox" data-act="habit-toggle" data-id="${h.id}" data-date="${today()}" ${h.log[today()] ? 'checked' : ''} aria-label="${esc(h.name)}" />
          <span class="title">${esc(h.name)}</span><span class="tag">🔥 ${habitStreak(h)}</span></li>`).join('')
      : '<li><span class="title muted">Add habits on the Habits tab.</span></li>';

    renderTrend();
  }

  function renderRecurring() {
    // Dashboard: bills needing attention.
    const due = billsDue();
    const hasBills = state.recurring.some((r) => r.mode === 'remind' && r.active);
    $('#dash-bills').innerHTML = due.length
      ? due.map((r) => `<li>
          <span class="title">${esc(r.name)}<span class="sub">${esc(r.category)}</span></span>
          ${signedAmount(r)}
          <span class="actions">${dueTag(r)}
          <button class="small primary" data-act="rec-paid" data-id="${r.id}">Paid</button>
          <button class="small" data-act="rec-skip" data-id="${r.id}" title="Skip this one without recording a payment">Skip</button></span></li>`).join('')
      : `<li><span class="title muted">${hasBills ? 'Nothing due in the next few days ✅' : 'Add bills under Money → Recurring & bills.'}</span></li>`;

    // Badge on the Money tab (and the home-screen icon where supported).
    const badge = $('#money-badge');
    badge.textContent = due.length;
    badge.hidden = due.length === 0;
    try {
      if (due.length && navigator.setAppBadge) navigator.setAppBadge(due.length).catch(() => {});
      else if (navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});
    } catch {}

    // Money tab: full list.
    const items = [...state.recurring].sort((a, b) =>
      (b.active - a.active) || a.next.localeCompare(b.next));
    $('#rec-list').innerHTML = items.map((r) => `<li class="${r.active ? '' : 'paused'}">
        <span class="title">${esc(r.name)}
          <span class="sub">${esc(FREQ_LABEL[r.frequency] || r.frequency)} · ${r.mode === 'auto' ? 'Auto-added' : 'Reminder'} · ${esc(r.category)}</span></span>
        ${signedAmount(r)}
        <span class="actions">${dueTag(r)}
        ${r.active && r.mode === 'remind' ? `<button class="small" data-act="rec-paid" data-id="${r.id}">Paid</button>` : ''}
        ${r.done ? '' : `<button class="icon-btn" data-act="rec-pause" data-id="${r.id}" aria-label="${r.active ? 'Pause' : 'Resume'}" title="${r.active ? 'Pause' : 'Resume'}">${r.active ? '⏸' : '▶'}</button>`}
        <button class="icon-btn" data-act="rec-del" data-id="${r.id}" aria-label="Delete">✕</button></span></li>`).join('');
    $('#rec-empty').hidden = items.length > 0;
  }

  function renderTrend() {
    const days = [];
    for (let i = 13; i >= 0; i--) days.push(addDays(today(), -i));
    const byDay = Object.fromEntries(days.map((d) => [d, { in: 0, out: 0 }]));
    for (const t of state.transactions) {
      const v = byDay[t.date] && countsInTotals(t) ? toHome(t.amount, t.currency) : null;
      if (v != null) byDay[t.date][t.type === 'income' ? 'in' : 'out'] += v;
    }
    const moodByDay = Object.fromEntries(state.journal.map((j) => [j.date, j.mood]));
    const max = Math.max(1, ...days.flatMap((d) => [byDay[d].in, byDay[d].out]));
    const h = (v) => `${Math.round((v / max) * 100)}%`;
    $('#dash-trend').innerHTML = `<div class="trend">${days.map((d) => {
      const m = MOODS.find((x) => x.v === moodByDay[d]);
      return `<div class="col" title="${esc(fmtDay(d))}: +${esc(money(byDay[d].in))} / -${esc(money(byDay[d].out))}">
        <div class="mood">${m ? m.e : ''}</div>
        <div class="pair"><div class="in" style="height:${h(byDay[d].in)}"></div><div class="out" style="height:${h(byDay[d].out)}"></div></div>
        <div class="day">${new Date(d + 'T00:00:00').getDate()}</div></div>`;
    }).join('')}</div>
    <div class="legend"><span><i class="in" style="background:var(--income)"></i>Income</span><span><i style="background:var(--expense)"></i>Spending</span><span>Emoji = mood from journal</span></div>`;
  }

  function renderMoney() {
    const monthInput = $('#tx-month');
    if (!monthInput.value) monthInput.value = isoMonth();
    const month = monthInput.value;
    const { income, expense, net } = monthTotals(month);
    $('#money-warn').innerHTML = rateWarning();
    $('#month-stats').innerHTML =
      statHtml('Income', money(income), 'income') +
      statHtml('Spent', money(expense), 'expense') +
      statHtml('Net', money(net), net >= 0 ? 'income' : 'expense');

    const txs = txInMonth(month).sort((a, b) => b.date.localeCompare(a.date) || (b.created || 0) - (a.created || 0));
    $('#tx-body').innerHTML = txs.map((t) => `<tr class="${countsInTotals(t) ? '' : 'transfer'}">
        <td>${esc(fmtDay(t.date))}</td>
        <td><button class="cat-btn" data-act="tx-cat" data-id="${t.id}" title="Change category">${esc(t.category)}</button></td>
        <td class="note">${esc(t.note)}${t.account ? `<span class="sub">${esc(t.account)}</span>` : ''}</td>
        <td class="num ${t.type}">${t.type === 'income' ? '+' : '−'}${esc(money(t.amount, t.currency))}</td>
        <td class="num"><button class="icon-btn" data-act="tx-del" data-id="${t.id}" aria-label="Delete">✕</button></td></tr>`).join('');
    $('#tx-empty').hidden = txs.length > 0;

    const rows = budgetRows(month);
    $('#budget-list').innerHTML = rows.length
      ? rows.map((r) => `<div style="display:flex;gap:8px;align-items:center"><div style="flex:1;min-width:0">${barRow(r.cat, r.s, r.limit, `${money(r.s)} / ${money(r.limit)}`, r.cls)}</div>
          <button class="icon-btn" data-act="budget-del" data-cat="${esc(r.cat)}" aria-label="Remove budget">✕</button></div>`).join('')
      : '<p class="empty">No budgets yet.</p>';
  }

  function taskLi(t) {
    const overdue = !t.done && t.due && t.due < today();
    const dueTag = t.due ? `<span class="tag ${overdue ? 'overdue' : ''}">${t.due === today() ? 'Today' : esc(fmtDay(t.due))}</span>` : '';
    const prio = t.priority !== 'normal' ? `<span class="tag ${t.priority}">${esc(t.priority)}</span>` : '';
    return `<li class="${t.done ? 'done' : ''}">
      <input type="checkbox" data-act="task-toggle" data-id="${t.id}" ${t.done ? 'checked' : ''} aria-label="Done" />
      <span class="title">${esc(t.title)}</span>${prio}${dueTag}
      <button class="icon-btn" data-act="task-del" data-id="${t.id}" aria-label="Delete">✕</button></li>`;
  }

  function renderTasks() {
    const f = $('#task-filter').value;
    const list = state.tasks.filter((t) =>
      f === 'open' ? !t.done : f === 'done' ? t.done : f === 'today' ? !t.done && t.due && t.due <= today() : true
    ).sort(sortTasks);
    $('#task-list').innerHTML = list.map(taskLi).join('');
    $('#task-empty').hidden = list.length > 0;
  }

  function renderHabits() {
    const days = [];
    for (let i = 6; i >= 0; i--) days.push(addDays(today(), -i));
    $('#habit-empty').hidden = state.habits.length > 0;
    if (!state.habits.length) { $('#habit-grid').innerHTML = ''; return; }
    $('#habit-grid').innerHTML = `<table class="habit-table"><thead><tr><th></th>${days.map((d) =>
      `<th>${esc(fmtDay(d, { weekday: 'narrow' }))}<br>${new Date(d + 'T00:00:00').getDate()}</th>`).join('')}<th></th></tr></thead>
      <tbody>${state.habits.map((h) => `<tr>
        <td class="name">${esc(h.name)}<div class="streak">🔥 ${habitStreak(h)} day streak</div></td>
        ${days.map((d) => `<td><button class="dot ${h.log[d] ? 'on' : ''}" data-act="habit-toggle" data-id="${h.id}" data-date="${d}" aria-label="${esc(h.name)} ${d}" aria-pressed="${!!h.log[d]}"></button></td>`).join('')}
        <td><button class="icon-btn" data-act="habit-del" data-id="${h.id}" aria-label="Delete habit">✕</button></td></tr>`).join('')}</tbody></table>`;
  }

  function renderJournal() {
    const entries = [...state.journal].sort((a, b) => b.date.localeCompare(a.date));
    $('#journal-list').innerHTML = entries.map((j) => {
      const m = MOODS.find((x) => x.v === j.mood);
      return `<li style="align-items:flex-start">
        <span style="font-size:1.4rem">${m ? m.e : '📝'}</span>
        <div class="title"><strong>${esc(fmtDay(j.date, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }))}</strong>
          ${j.sleep ? `<span class="tag">😴 ${esc(j.sleep)}h</span>` : ''}
          <div class="journal-text">${esc(j.note)}</div></div>
        <button class="icon-btn" data-act="journal-edit" data-id="${j.id}" aria-label="Edit">✎</button>
        <button class="icon-btn" data-act="journal-del" data-id="${j.id}" aria-label="Delete">✕</button></li>`;
    }).join('');
    $('#journal-empty').hidden = entries.length > 0;
  }

  function renderCategoryList() {
    const cats = new Set([...DEFAULT_CATEGORIES, ...state.transactions.map((t) => t.category), ...Object.keys(state.budgets)]);
    $('#category-list').innerHTML = [...cats].sort().map((c) => `<option value="${esc(c)}">`).join('');
  }

  // ---------- mood picker ----------
  let selectedMood = 0;
  function renderMoodPicker() {
    $('#mood-picker').innerHTML = MOODS.map((m) =>
      `<button type="button" role="radio" aria-checked="${selectedMood === m.v}" class="${selectedMood === m.v ? 'selected' : ''}" data-mood="${m.v}" title="${m.l}">${m.e}</button>`).join('');
  }
  function loadJournalForm(date) {
    const form = $('#journal-form');
    const entry = state.journal.find((j) => j.date === date);
    form.date.value = date;
    form.note.value = entry?.note || '';
    form.sleep.value = entry?.sleep || '';
    selectedMood = entry?.mood || 0;
    renderMoodPicker();
  }

  // ---------- events ----------
  $('#tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-view]');
    if (!btn) return;
    $$('#tabs button').forEach((b) => b.classList.toggle('active', b === btn));
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + btn.dataset.view));
    try { localStorage.setItem(STORAGE_KEY + ':tab', btn.dataset.view); } catch {}
  });

  $('#tx-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const amount = parseFloat(f.amount.value);
    if (!(amount > 0)) return;
    state.transactions.push({
      id: uid(), created: Date.now(), type: f.type.value, amount: Math.round(amount * 100) / 100,
      currency: f.currency.value || home(),
      category: f.category.value.trim() || 'Other', date: f.date.value || today(), note: f.note.value.trim(),
    });
    $('#tx-month').value = (f.date.value || today()).slice(0, 7);
    f.amount.value = ''; f.note.value = ''; f.category.value = '';
    f.amount.focus();
    save();
    toast('Transaction added');
  });

  $('#tx-month').addEventListener('change', renderMoney);

  $('#budget-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const cat = f.category.value.trim();
    const amt = parseFloat(f.amount.value);
    if (!cat || !(amt >= 0)) return;
    state.budgets[cat] = Math.round(amt * 100) / 100;
    f.reset();
    save();
    toast(`Budget set for ${cat}`);
  });

  $('#rec-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const amount = parseFloat(f.amount.value);
    const name = f.name.value.trim();
    if (!name || !(amount > 0)) return;
    const next = f.next.value || today();
    const r = {
      id: uid(), name, type: f.type.value, amount: Math.round(amount * 100) / 100,
      category: f.category.value.trim() || 'Other', frequency: f.frequency.value,
      next, day: Number(next.slice(8, 10)), mode: f.mode.value, active: true, currency: home(),
    };
    state.recurring.push(r);
    const added = processRecurring();
    f.name.value = ''; f.amount.value = ''; f.category.value = '';
    save();
    toast(added ? `Added — ${added} past transaction${added > 1 ? 's' : ''} recorded` : `${name} added`);
  });

  $('#task-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const title = f.title.value.trim();
    if (!title) return;
    state.tasks.push({ id: uid(), title, due: f.due.value || '', priority: f.priority.value, done: false, created: Date.now() });
    f.title.value = '';
    save();
  });
  $('#task-filter').addEventListener('change', renderTasks);

  $('#habit-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = e.target.name.value.trim();
    if (!name) return;
    state.habits.push({ id: uid(), name, log: {} });
    e.target.reset();
    save();
  });

  $('#mood-picker').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mood]');
    if (!b) return;
    const v = Number(b.dataset.mood);
    selectedMood = selectedMood === v ? 0 : v;
    renderMoodPicker();
  });
  $('#journal-form').date.addEventListener('change', (e) => loadJournalForm(e.target.value || today()));
  $('#journal-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const date = f.date.value || today();
    const note = f.note.value.trim();
    const sleep = f.sleep.value ? Number(f.sleep.value) : '';
    if (!note && !selectedMood && !sleep) { toast('Add a mood, sleep or note first'); return; }
    const existing = state.journal.find((j) => j.date === date);
    if (existing) Object.assign(existing, { note, mood: selectedMood, sleep });
    else state.journal.push({ id: uid(), date, note, mood: selectedMood, sleep });
    save();
    toast('Entry saved');
  });

  // Delegated actions for list items across all views.
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const { act, id } = el.dataset;
    switch (act) {
      case 'tx-del':
        if (!confirm('Delete this transaction?')) return;
        state.transactions = state.transactions.filter((t) => t.id !== id);
        break;
      case 'budget-del':
        delete state.budgets[el.dataset.cat];
        break;
      case 'tx-cat': {
        const t = state.transactions.find((x) => x.id === id);
        if (!t) return;
        const cat = prompt(`Category for "${t.note || t.category}" (use "${TRANSFER}" to leave it out of totals):`, t.category);
        if (cat == null || !cat.trim()) return;
        t.category = cat.trim();
        t.categoryEdited = true;
        // Remember the choice for future imported/synced transactions with this description.
        if (t.source && t.note) state.categoryRules[ruleKey(t.note)] = t.category;
        break;
      }
      case 'rec-paid':
      case 'rec-skip': {
        const r = state.recurring.find((x) => x.id === id);
        if (!r || !r.active) return;
        if (act === 'rec-paid') recordFromRecurring(r, today());
        advance(r);
        save();
        toast(act === 'rec-paid'
          ? `${r.name} recorded${r.active ? ` · next due ${fmtDay(r.next)}` : ''}`
          : `${r.name} skipped${r.active ? ` · next due ${fmtDay(r.next)}` : ''}`);
        return;
      }
      case 'rec-pause': {
        const r = state.recurring.find((x) => x.id === id);
        if (!r || r.done) return;
        r.active = !r.active;
        // On resume, jump past dates missed while paused instead of back-filling them.
        if (r.active) { let g = 0; while (r.next < today() && g++ < 500) advance(r); }
        break;
      }
      case 'rec-del':
        if (!confirm('Delete this recurring item? Transactions already recorded are kept.')) return;
        state.recurring = state.recurring.filter((r) => r.id !== id);
        break;
      case 'task-toggle': {
        const t = state.tasks.find((x) => x.id === id);
        if (t) { t.done = !t.done; t.doneAt = t.done ? Date.now() : null; }
        break;
      }
      case 'task-del':
        state.tasks = state.tasks.filter((t) => t.id !== id);
        break;
      case 'habit-toggle': {
        const h = state.habits.find((x) => x.id === id);
        const d = el.dataset.date;
        if (h) { if (h.log[d]) delete h.log[d]; else h.log[d] = true; }
        break;
      }
      case 'habit-del':
        if (!confirm('Delete this habit and its history?')) return;
        state.habits = state.habits.filter((h) => h.id !== id);
        break;
      case 'journal-edit': {
        const j = state.journal.find((x) => x.id === id);
        if (j) { loadJournalForm(j.date); $('#journal-form').scrollIntoView({ behavior: 'smooth' }); }
        return;
      }
      case 'journal-del':
        if (!confirm('Delete this journal entry?')) return;
        state.journal = state.journal.filter((j) => j.id !== id);
        break;
      default:
        return;
    }
    save();
  });

  // ---------- settings / data ----------
  // Changing home currency re-bases the stored exchange rates so they stay correct.
  $('#currency').addEventListener('change', (e) => {
    const oldHome = home(), newHome = e.target.value;
    const rates = state.settings.rates;
    const pivot = Number(rates[newHome]); // 1 newHome = pivot oldHome
    const rebased = {};
    if (pivot > 0) {
      for (const [c, r] of Object.entries(rates)) if (c !== newHome && r > 0) rebased[c] = r / pivot;
      rebased[oldHome] = 1 / pivot;
    }
    state.settings.rates = rebased;
    state.settings.currency = newHome;
    save();
    if (!(pivot > 0) && state.transactions.some((t) => t.currency !== newHome)) toast(`Set exchange rates to ${newHome} below`);
  });
  $('#rates').addEventListener('change', (e) => {
    const c = e.target.dataset.rate;
    if (!c) return;
    const v = parseFloat(e.target.value);
    if (v > 0) state.settings.rates[c] = v; else delete state.settings.rates[c];
    save();
  });

  function download(name, content, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  $('#export-json').addEventListener('click', () =>
    download(`lifeledger-backup-${today()}.json`, JSON.stringify(state, null, 2), 'application/json'));

  $('#export-csv').addEventListener('click', () => {
    const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const rows = [['date', 'type', 'category', 'amount', 'currency', 'note', 'account'].join(',')]
      .concat([...state.transactions].sort((a, b) => a.date.localeCompare(b.date))
        .map((t) => [t.date, t.type, q(t.category), t.amount.toFixed(2), t.currency || home(), q(t.note), q(t.account)].join(',')));
    download(`lifeledger-transactions-${today()}.csv`, rows.join('\n'), 'text/csv');
  });

  $('#import-json').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!confirm('Replace all current data with this backup?')) return;
      state = normalize(data);
      save();
      toast('Backup imported');
    } catch {
      toast('That file is not a valid backup');
    } finally {
      e.target.value = '';
    }
  });

  $('#reset').addEventListener('click', () => {
    if (!confirm('Erase ALL data? Export a backup first if you want to keep it.')) return;
    state = emptyState();
    save();
    toast('All data erased');
  });

  $('#load-demo').addEventListener('click', () => {
    if ((state.transactions.length || state.tasks.length) && !confirm('Replace current data with demo data?')) return;
    state = demoData();
    save();
    toast('Demo data loaded');
  });

  function demoData() {
    const s = emptyState();
    const d = (n) => addDays(today(), -n);
    const tx = (n, type, amount, category, note = '') =>
      s.transactions.push({ id: uid(), created: Date.now() - n, type, amount, currency: 'USD', category, date: d(n), note });
    tx(0, 'expense', 12.5, 'Dining', 'Lunch');
    tx(1, 'expense', 64.2, 'Groceries', 'Weekly shop');
    tx(2, 'expense', 3.2, 'Transport', 'Bus');
    tx(3, 'expense', 45, 'Utilities', 'Electricity');
    tx(4, 'expense', 28, 'Entertainment', 'Movie');
    tx(5, 'income', 250, 'Other', 'Freelance');
    tx(6, 'expense', 52.3, 'Groceries');
    tx(8, 'expense', 19.99, 'Shopping', 'Book');
    tx(10, 'expense', 34, 'Dining', 'Dinner with friends');
    tx(12, 'income', 3200, 'Salary');
    tx(12, 'expense', 1200, 'Rent');
    s.budgets = { Groceries: 400, Dining: 150, Entertainment: 80, Transport: 60 };
    s.tasks = [
      { id: uid(), title: 'Pay credit card bill', due: today(), priority: 'high', done: false },
      { id: uid(), title: 'Book dentist appointment', due: d(-3), priority: 'normal', done: false },
      { id: uid(), title: 'Renew car insurance', due: d(1), priority: 'high', done: false },
      { id: uid(), title: 'Call mom', due: '', priority: 'normal', done: false },
      { id: uid(), title: 'Submit expense report', due: d(2), priority: 'normal', done: true },
    ];
    const log = (pattern) => Object.fromEntries(pattern.map((on, i) => on && [d(i), true]).filter(Boolean));
    s.habits = [
      { id: uid(), name: 'Exercise 30 min', log: log([0, 1, 1, 1, 0, 1, 1]) },
      { id: uid(), name: 'Read 20 pages', log: log([1, 1, 1, 1, 1, 0, 1]) },
      { id: uid(), name: 'No takeout', log: log([0, 0, 1, 1, 0, 1, 0]) },
    ];
    s.journal = [
      { id: uid(), date: d(0), mood: 4, sleep: 7, note: 'Productive day, cleared most of my inbox.' },
      { id: uid(), date: d(1), mood: 3, sleep: 6, note: 'Tired, but got groceries done.' },
      { id: uid(), date: d(3), mood: 5, sleep: 8, note: 'Great run in the morning!' },
      { id: uid(), date: d(4), mood: 2, sleep: 5, note: 'Stressful meetings.' },
    ];
    const rec = (name, type, amount, category, frequency, next, mode) => {
      const r = { id: uid(), name, type, amount, category, frequency, next, day: Number(next.slice(8, 10)), mode, active: true, currency: 'USD' };
      s.recurring.push(r);
      return r;
    };
    // Salary and rent were paid 12 days ago (see transactions above); next occurrence is a month on.
    advance(rec('Salary', 'income', 3200, 'Salary', 'monthly', d(12), 'auto'));
    advance(rec('Rent', 'expense', 1200, 'Rent', 'monthly', d(12), 'auto'));
    rec('Credit card', 'expense', 340, 'Other', 'monthly', d(0), 'remind');
    rec('Phone bill', 'expense', 35, 'Utilities', 'monthly', d(-2), 'remind');
    rec('Electricity', 'expense', 48, 'Utilities', 'monthly', d(1), 'remind');
    rec('Netflix', 'expense', 15.49, 'Entertainment', 'monthly', d(-9), 'remind');
    rec('Car insurance', 'expense', 620, 'Transport', 'yearly', d(-40), 'remind');
    return s;
  }

  // ---------- shared with bank.js ----------
  // Normalize a bank description into a stable key: drop digits/refs, collapse spaces.
  function ruleKey(desc) {
    return String(desc).toUpperCase().replace(/[0-9]+/g, ' ').replace(/[^A-Z&]+/g, ' ').trim().split(' ').slice(0, 4).join(' ');
  }
  const KEYWORD_CATEGORIES = [
    [/SWIGGY|ZOMATO|RESTAURANT|CAFE|STARBUCKS|MCDONALD|DOMINO|PIZZA|DOORDASH|GRUBHUB|UBER ?EATS|CHIPOTLE/, 'Dining'],
    [/BIGBASKET|BLINKIT|ZEPTO|DMART|GROFERS|INSTAMART|RELIANCE ?FRESH|MORE ?RETAIL|WHOLE ?FOODS|TRADER ?JOE|KROGER|SAFEWAY|COSTCO|WALMART ?GROCERY|INSTACART/, 'Groceries'],
    [/UBER|OLA|RAPIDO|IRCTC|FASTAG|METRO|PETROL|FUEL|SHELL|CHEVRON|EXXON|LYFT|PARKING/, 'Transport'],
    [/AMAZON|FLIPKART|MYNTRA|AJIO|NYKAA|MEESHO|TARGET|EBAY|ETSY/, 'Shopping'],
    [/NETFLIX|HOTSTAR|SPOTIFY|PRIME ?VIDEO|BOOKMYSHOW|YOUTUBE|HULU|DISNEY|STEAM/, 'Entertainment'],
    [/SALARY|PAYROLL|SAL CREDIT|DIRECT ?DEP/, 'Salary'],
    [/ELECTRICITY|BESCOM|MSEDCL|TATA ?POWER|ADANI ?ELEC|AIRTEL|JIO|VODAFONE|BSNL|BROADBAND|COMCAST|XFINITY|VERIZON|AT ?& ?T|T-?MOBILE|WATER ?BILL|GAS ?BILL|PG ?&E/, 'Utilities'],
    [/\bRENT\b|NOBROKER/, 'Rent'],
    [/PHARM|APOLLO|HOSPITAL|CLINIC|MEDPLUS|1MG|NETMEDS|CVS|WALGREENS|DENTAL/, 'Health'],
    [/CREDIT ?CARD ?PAY|CC ?PAYMENT|CARD ?PAYMENT|SELF ?TRANSFER|OWN ?ACCOUNT|AUTOPAY.*CARD/, 'Transfer'],
    [/ATM|CASH ?WDL|CASH ?WITHDRAWAL/, 'Cash'],
  ];
  // Best-guess category: your own past corrections first, then keyword rules.
  function guessCategory(desc, fallback = 'Other') {
    const learned = state.categoryRules[ruleKey(desc)];
    if (learned) return learned;
    const up = String(desc).toUpperCase();
    for (const [re, cat] of KEYWORD_CATEGORIES) if (re.test(up)) return cat;
    return fallback;
  }

  window.LifeLedger = {
    get state() { return state; },
    save, render, toast, money, esc, uid, today, fmtDay, home, guessCategory, ruleKey, toHome,
    CURRENCIES, TRANSFER,
    onRender(fn) { renderHooks.push(fn); },
    // Insert or update transactions by id; returns { added, updated }.
    upsertTransactions(list) {
      const byId = new Map(state.transactions.map((t) => [t.id, t]));
      let added = 0, updated = 0;
      for (const t of list) {
        const cur = byId.get(t.id);
        if (!cur) { state.transactions.push(t); byId.set(t.id, t); added++; continue; }
        const keepCat = cur.categoryEdited ? { category: cur.category, categoryEdited: true } : {};
        Object.assign(cur, t, keepCat);
        updated++;
      }
      return { added, updated };
    },
    removeTransactions(ids) {
      const set = new Set(ids);
      const before = state.transactions.length;
      state.transactions = state.transactions.filter((t) => !set.has(t.id));
      return before - state.transactions.length;
    },
  };

  // ---------- init ----------
  let shownDay = '';
  // Runs on launch and whenever the app comes back to the foreground — an installed
  // iPhone app can stay suspended in memory for days, so recheck what's due.
  function refreshForToday() {
    const day = today();
    if (day !== shownDay) {
      $('#today-label').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
      $('#tx-form').date.value = day;
      $('#rec-form').next.value = day;
      if (!shownDay) loadJournalForm(day);
      shownDay = day;
    }
    const added = processRecurring();
    if (added) {
      save();
      toast(`${added} recurring transaction${added > 1 ? 's' : ''} added`);
    } else {
      render();
    }
  }

  try {
    const tab = localStorage.getItem(STORAGE_KEY + ':tab');
    if (tab) $(`#tabs button[data-view="${tab}"]`)?.click();
  } catch {}
  refreshForToday();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshForToday();
  });

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
