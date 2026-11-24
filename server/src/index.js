/**
 * LifeLedger bank sync server — a Cloudflare Worker that talks to Plaid.
 *
 * Why a server: Plaid's secret key and the per-bank access tokens must never be in the
 * web app (its code is public). This Worker keeps them in Cloudflare (secrets + KV) and
 * only hands the app transaction data, after checking the app's passcode.
 *
 * Bindings (see wrangler.toml and SETUP-BANK-SYNC.md):
 *   PLAID_CLIENT_ID, PLAID_SECRET  secrets from the Plaid dashboard
 *   PLAID_ENV                      "sandbox" or "production"
 *   APP_PASSCODE                   secret; the app sends it as a Bearer token
 *   ALLOWED_ORIGINS                comma-separated origins allowed to call this server
 *   PLAID_REDIRECT_URI             optional; OAuth redirect page registered in Plaid
 *   ITEMS                          KV namespace holding { access_token, institution } per bank
 *
 * Sync cursors are kept by the app, not here, so a sync the app fails to save is simply
 * repeated next time (transactions are upserted by id, so repeats are harmless).
 */

const PLAID_HOSTS = {
  sandbox: 'https://sandbox.plaid.com',
  production: 'https://production.plaid.com',
};
const MAX_PAGES_PER_ITEM = 8; // keeps each request well under Workers' subrequest limit
const ITEM_PREFIX = 'item:';

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: cors ? 204 : 403, headers: cors || {} });
    if (!cors) return json({ error: 'Origin not allowed' }, 403);

    try {
      if (!(await authorized(request, env))) return json({ error: 'Wrong passcode' }, 401, cors);
      const url = new URL(request.url);
      const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
      const route = ROUTES[`${request.method} ${url.pathname}`];
      if (!route) return json({ error: 'Not found' }, 404, cors);
      return json(await route(body, env), 200, cors);
    } catch (err) {
      const status = err.status || 500;
      return json({ error: err.message || 'Server error', code: err.code }, status, cors);
    }
  },
};

const ROUTES = {
  'GET /api/ping': async (_b, env) => ({ ok: true, env: plaidEnv(env) }),

  // Start Plaid Link. With item_id, opens Link in "update mode" to fix a bank login.
  'POST /api/link-token': async ({ item_id }, env) => {
    const req = {
      user: { client_user_id: 'lifeledger-owner' },
      client_name: 'LifeLedger',
      country_codes: ['US'],
      language: 'en',
    };
    if (env.PLAID_REDIRECT_URI) req.redirect_uri = env.PLAID_REDIRECT_URI;
    if (item_id) {
      req.access_token = (await getItem(env, item_id)).access_token;
    } else {
      req.products = ['transactions'];
      req.transactions = { days_requested: 730 };
    }
    const res = await plaid(env, '/link/token/create', req);
    return { link_token: res.link_token };
  },

  // Finish Plaid Link: swap the one-time public token for a long-lived access token.
  'POST /api/exchange': async ({ public_token, institution }, env) => {
    if (!public_token) throw httpError(400, 'public_token is required');
    const res = await plaid(env, '/item/public_token/exchange', { public_token });
    const item = {
      item_id: res.item_id,
      access_token: res.access_token,
      institution: String(institution || 'Bank').slice(0, 80),
      created: new Date().toISOString(),
    };
    await env.ITEMS.put(ITEM_PREFIX + item.item_id, JSON.stringify(item));
    return { item_id: item.item_id, institution: item.institution };
  },

  // Pull new/changed/removed transactions for every connected bank.
  // Body: { cursors: { [item_id]: cursor } }. Returns per-item results + new cursors.
  'POST /api/sync': async ({ cursors = {} }, env) => {
    const items = await listItems(env);
    const results = [];
    for (const item of items) results.push(await syncItem(env, item, cursors[item.item_id] || null));
    return { items: results };
  },

  'POST /api/remove': async ({ item_id }, env) => {
    const item = await getItem(env, item_id);
    try {
      await plaid(env, '/item/remove', { access_token: item.access_token });
    } catch (err) {
      // Already gone at Plaid: still forget it here.
      if (err.code !== 'ITEM_NOT_FOUND' && err.code !== 'INVALID_ACCESS_TOKEN') throw err;
    }
    await env.ITEMS.delete(ITEM_PREFIX + item_id);
    return { removed: item_id };
  },
};

async function syncItem(env, item, startCursor) {
  const out = { item_id: item.item_id, institution: item.institution, added: [], modified: [], removed: [], accounts: [] };
  let cursor = startCursor;
  let restarts = 0;
  try {
    for (let page = 0; page < MAX_PAGES_PER_ITEM; page++) {
      let res;
      try {
        res = await plaid(env, '/transactions/sync', {
          access_token: item.access_token, cursor: cursor || undefined, count: 500,
          options: { include_personal_finance_category: true },
        });
      } catch (err) {
        // Plaid asks clients to restart pagination from the original cursor in this case.
        if (err.code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' && restarts++ < 2) {
          cursor = startCursor; out.added = []; out.modified = []; out.removed = []; page = -1;
          continue;
        }
        throw err;
      }
      out.added.push(...res.added.map(slimTx));
      out.modified.push(...res.modified.map(slimTx));
      out.removed.push(...res.removed.map((r) => r.transaction_id));
      if (res.accounts?.length) out.accounts = res.accounts.map(slimAccount);
      cursor = res.next_cursor;
      out.has_more = res.has_more;
      if (!res.has_more) break;
    }
    out.cursor = cursor;
    // Initial sync can return an empty page while Plaid is still fetching history.
    if (!out.accounts.length) {
      const acc = await plaid(env, '/accounts/get', { access_token: item.access_token });
      out.accounts = acc.accounts.map(slimAccount);
    }
  } catch (err) {
    // Report per bank so one broken login doesn't block the others.
    out.error = { code: err.code || 'ERROR', message: err.message };
    out.cursor = startCursor;
    out.added = []; out.modified = []; out.removed = [];
  }
  return out;
}

// Only what the app needs — keeps responses small and avoids leaking extra data.
function slimTx(t) {
  return {
    transaction_id: t.transaction_id,
    account_id: t.account_id,
    amount: t.amount, // Plaid: positive = money out, negative = money in
    currency: t.iso_currency_code || t.unofficial_currency_code || 'USD',
    date: t.date,
    name: t.name,
    merchant_name: t.merchant_name || null,
    pending: !!t.pending,
    category: t.personal_finance_category
      ? { primary: t.personal_finance_category.primary, detailed: t.personal_finance_category.detailed }
      : null,
  };
}

function slimAccount(a) {
  return {
    account_id: a.account_id,
    name: a.name || a.official_name || 'Account',
    mask: a.mask || '',
    type: a.type,
    subtype: a.subtype || '',
    balance: a.balances?.current ?? null,
    available: a.balances?.available ?? null,
    currency: a.balances?.iso_currency_code || a.balances?.unofficial_currency_code || 'USD',
  };
}

// ---------- helpers ----------

function plaidEnv(env) {
  return env.PLAID_ENV === 'production' ? 'production' : 'sandbox';
}

async function plaid(env, path, body) {
  const res = await fetch(PLAID_HOSTS[plaidEnv(env)] + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: env.PLAID_CLIENT_ID, secret: env.PLAID_SECRET, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = httpError(res.status >= 500 ? 502 : 400, data.display_message || data.error_message || `Plaid error ${res.status}`);
    err.code = data.error_code;
    throw err;
  }
  return data;
}

async function listItems(env) {
  const items = [];
  let cursor;
  do {
    const page = await env.ITEMS.list({ prefix: ITEM_PREFIX, cursor });
    for (const k of page.keys) {
      const v = await env.ITEMS.get(k.name, 'json');
      if (v) items.push(v);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return items;
}

async function getItem(env, itemId) {
  if (!itemId || typeof itemId !== 'string') throw httpError(400, 'item_id is required');
  const item = await env.ITEMS.get(ITEM_PREFIX + itemId, 'json');
  if (!item) throw httpError(404, 'Unknown bank connection');
  return item;
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  // Requests without an Origin (curl, health checks) still need the passcode.
  if (origin && !allowed.includes(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin || allowed[0] || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

// Constant-time passcode check (compare SHA-256 digests).
async function authorized(request, env) {
  const expected = env.APP_PASSCODE;
  if (!expected || expected.length < 12) throw httpError(500, 'APP_PASSCODE is not set (min 12 characters)');
  const header = request.headers.get('Authorization') || '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : '';
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}
