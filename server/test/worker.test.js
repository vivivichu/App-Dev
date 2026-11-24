// Tests for the sync server with a fake Plaid API and an in-memory KV store.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const ORIGIN = 'https://vivivichu.github.io';
const PASS = 'correct-horse-battery';

function memoryKV() {
  const m = new Map();
  return {
    m,
    async get(k, type) { const v = m.get(k); return v == null ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
    async list({ prefix }) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
  };
}

let env, calls, plaidHandler;
beforeEach(() => {
  env = { PLAID_CLIENT_ID: 'cid', PLAID_SECRET: 'sec', PLAID_ENV: 'sandbox', APP_PASSCODE: PASS, ALLOWED_ORIGINS: ORIGIN, ITEMS: memoryKV() };
  calls = [];
  plaidHandler = () => ({ status: 500, body: {} });
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const path = new URL(url).pathname;
    calls.push({ url, path, body });
    const { status = 200, body: out } = plaidHandler(path, body, calls.filter((c) => c.path === path).length);
    return new Response(JSON.stringify(out), { status });
  };
});

const req = (method, path, { body, pass = PASS, origin = ORIGIN } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (pass != null) headers.Authorization = `Bearer ${pass}`;
  if (origin) headers.Origin = origin;
  return worker.fetch(new Request('https://w.example' + path, { method, headers, body: body ? JSON.stringify(body) : undefined }), env);
};

test('rejects wrong passcode and unknown origins', async () => {
  assert.equal((await req('GET', '/api/ping', { pass: 'nope' })).status, 401);
  assert.equal((await req('GET', '/api/ping', { pass: null })).status, 401);
  assert.equal((await req('GET', '/api/ping', { origin: 'https://evil.example' })).status, 403);
  const ok = await req('GET', '/api/ping');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.deepEqual(await ok.json(), { ok: true, env: 'sandbox' });
});

test('CORS preflight', async () => {
  const r = await worker.fetch(new Request('https://w.example/api/sync', { method: 'OPTIONS', headers: { Origin: ORIGIN } }), env);
  assert.equal(r.status, 204);
  assert.match(r.headers.get('Access-Control-Allow-Headers'), /Authorization/);
});

test('refuses to run with a weak/missing passcode', async () => {
  env.APP_PASSCODE = 'short';
  const r = await req('GET', '/api/ping', { pass: 'short' });
  assert.equal(r.status, 500);
});

test('link token, exchange, sync with pagination, remove', async () => {
  plaidHandler = (path, body, n) => {
    if (path === '/link/token/create') return { body: { link_token: 'link-sandbox-1' } };
    if (path === '/item/public_token/exchange') return { body: { access_token: 'access-1', item_id: 'item-1' } };
    if (path === '/transactions/sync') {
      if (!body.cursor) return { body: {
        added: [{ transaction_id: 't1', account_id: 'a1', amount: 12.5, iso_currency_code: 'USD', date: '2026-11-20', name: 'STARBUCKS', merchant_name: 'Starbucks', pending: false,
          personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_COFFEE' }, location: { secret: 'x' } }],
        modified: [], removed: [], next_cursor: 'c1', has_more: true,
        accounts: [{ account_id: 'a1', name: 'Checking', mask: '0000', type: 'depository', subtype: 'checking', balances: { current: 1000, available: 900, iso_currency_code: 'USD' } }] } };
      if (body.cursor === 'c1') return { body: { added: [{ transaction_id: 't2', account_id: 'a1', amount: -3000, iso_currency_code: 'USD', date: '2026-11-15', name: 'PAYROLL', pending: false }],
        modified: [], removed: [{ transaction_id: 't0' }], next_cursor: 'c2', has_more: false, accounts: [] } };
      if (body.cursor === 'c2') return { body: { added: [], modified: [], removed: [], next_cursor: 'c2', has_more: false, accounts: [] } };
    }
    if (path === '/accounts/get') return { body: { accounts: [{ account_id: 'a1', name: 'Checking', type: 'depository', balances: { current: 1000, iso_currency_code: 'USD' } }] } };
    if (path === '/item/remove') return { body: {} };
    return { status: 400, body: { error_code: 'UNEXPECTED', error_message: path } };
  };

  const lt = await (await req('POST', '/api/link-token', { body: {} })).json();
  assert.equal(lt.link_token, 'link-sandbox-1');
  const ltCall = calls.find((c) => c.path === '/link/token/create');
  assert.deepEqual(ltCall.body.products, ['transactions']);
  assert.equal(ltCall.body.secret, 'sec');
  assert.match(ltCall.url, /^https:\/\/sandbox\.plaid\.com/);

  const ex = await (await req('POST', '/api/exchange', { body: { public_token: 'public-1', institution: 'Chase' } })).json();
  assert.deepEqual(ex, { item_id: 'item-1', institution: 'Chase' });
  assert.equal(JSON.parse(env.ITEMS.m.get('item:item-1')).access_token, 'access-1');

  const s1 = await (await req('POST', '/api/sync', { body: { cursors: {} } })).json();
  const it = s1.items[0];
  assert.equal(it.cursor, 'c2');
  assert.deepEqual(it.added.map((t) => t.transaction_id), ['t1', 't2']);
  assert.deepEqual(it.removed, ['t0']);
  assert.equal(it.accounts[0].balance, 1000);
  assert.equal(it.added[0].category.primary, 'FOOD_AND_DRINK');
  assert.equal(it.added[0].location, undefined, 'extra fields are stripped');
  assert.ok(!JSON.stringify(s1).includes('access-1'), 'access token never returned');

  // Second sync resumes from the app-held cursor and falls back to /accounts/get for balances.
  const s2 = await (await req('POST', '/api/sync', { body: { cursors: { 'item-1': 'c2' } } })).json();
  assert.equal(s2.items[0].added.length, 0);
  assert.equal(s2.items[0].accounts.length, 1);

  // Update-mode link token uses the access token instead of products.
  await req('POST', '/api/link-token', { body: { item_id: 'item-1' } });
  const upd = calls.filter((c) => c.path === '/link/token/create')[1];
  assert.equal(upd.body.access_token, 'access-1');
  assert.equal(upd.body.products, undefined);

  const rm = await req('POST', '/api/remove', { body: { item_id: 'item-1' } });
  assert.equal(rm.status, 200);
  assert.equal(env.ITEMS.m.size, 0);
});

test('mutation during pagination restarts from the original cursor', async () => {
  env.ITEMS.m.set('item:i', JSON.stringify({ item_id: 'i', access_token: 'acc', institution: 'B' }));
  plaidHandler = (path, body, n) => {
    if (path !== '/transactions/sync') return { body: { accounts: [] } };
    if (n === 1) return { body: { added: [{ transaction_id: 'x', amount: 1, date: '2026-01-01', name: 'X' }], modified: [], removed: [], next_cursor: 'p1', has_more: true, accounts: [{ account_id: 'a' , name: 'A', type: 'depository', balances: {} }] } };
    if (n === 2) return { status: 400, body: { error_code: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' } };
    return { body: { added: [{ transaction_id: 'y', amount: 1, date: '2026-01-01', name: 'Y' }], modified: [], removed: [], next_cursor: 'p9', has_more: false, accounts: [{ account_id: 'a', name: 'A', type: 'depository', balances: {} }] } };
  };
  const s = await (await req('POST', '/api/sync', { body: { cursors: { i: 'start' } } })).json();
  assert.deepEqual(s.items[0].added.map((t) => t.transaction_id), ['y'], 'partial pages discarded');
  assert.equal(s.items[0].cursor, 'p9');
  const syncCalls = calls.filter((c) => c.path === '/transactions/sync');
  assert.equal(syncCalls[2].body.cursor, 'start');
});

test('a broken bank login is reported per item and keeps the old cursor', async () => {
  env.ITEMS.m.set('item:good', JSON.stringify({ item_id: 'good', access_token: 'g', institution: 'Good' }));
  env.ITEMS.m.set('item:bad', JSON.stringify({ item_id: 'bad', access_token: 'b', institution: 'Bad' }));
  plaidHandler = (path, body) => {
    if (body.access_token === 'b') return { status: 400, body: { error_code: 'ITEM_LOGIN_REQUIRED', error_message: 'login required' } };
    return { body: { added: [], modified: [], removed: [], next_cursor: 'g1', has_more: false, accounts: [{ account_id: 'a', name: 'A', type: 'depository', balances: {} }] } };
  };
  const s = await (await req('POST', '/api/sync', { body: { cursors: { bad: 'old' } } })).json();
  const bad = s.items.find((i) => i.item_id === 'bad');
  const good = s.items.find((i) => i.item_id === 'good');
  assert.equal(bad.error.code, 'ITEM_LOGIN_REQUIRED');
  assert.equal(bad.cursor, 'old');
  assert.equal(good.cursor, 'g1');
});

test('unknown route and bad input', async () => {
  assert.equal((await req('GET', '/api/nope')).status, 404);
  assert.equal((await req('POST', '/api/exchange', { body: {} })).status, 400);
  assert.equal((await req('POST', '/api/remove', { body: { item_id: 'missing' } })).status, 404);
});
