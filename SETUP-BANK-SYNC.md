# Setting up automatic bank sync (US banks)

LifeLedger syncs US bank and credit card transactions through **Plaid**, the service behind apps like Venmo and Robinhood. The connection runs through a small **sync server** that you own, hosted free on **Cloudflare Workers**:

```
iPhone app  ──passcode──▶  your sync server (Cloudflare)  ──secret keys──▶  Plaid  ──▶  your bank
```

The server exists because your Plaid secret key and your bank access tokens must never be in the app's code, which is public on GitHub. The server keeps them, and only someone with your passcode can use it.

You can do every step below in a phone browser. It takes about 15 minutes.

> **Indian bank accounts:** automatic sync isn't possible for a personal app in India. RBI's Account Aggregator network is only open to registered companies. Use **Money → Import bank statement** with a CSV statement from your bank instead. HDFC, SBI, ICICI and Axis formats are recognised automatically.

---

## 1. Create a Plaid account and get your keys

1. Go to **https://dashboard.plaid.com/signup** and create an account. A personal/hobby project is fine. New accounts get Plaid's free **Trial** plan, which allows real bank connections for up to 10 banks.
2. Open **Developers → Keys** (or **Team settings → Keys**).
3. Write down the **client_id** and the **Sandbox secret**. You'll get the **Production secret** later.

## 2. Make up a passcode

Make up a long passcode, at least 12 characters, for example `maple-river-42-orbit-glass`. The app sends it to your server with every request, so don't reuse a password from elsewhere. You'll type it once on your phone.

## 3. Create the sync server on Cloudflare

1. Sign up at **https://dash.cloudflare.com/sign-up**. The free plan is enough.
2. **Create the storage for bank connections:** go to **Storage & Databases → KV**, then **Create**, and name it `lifeledger-items`.
3. **Create the Worker:** go to **Compute (Workers) → Workers & Pages → Create → Create Worker** (start from "Hello World"), name it `lifeledger-sync`, and tap **Deploy**.
4. Tap **Edit code**. Delete everything in the editor and paste the full contents of [`server/src/index.js`](server/src/index.js). Copy it from the **Raw** view on GitHub: https://raw.githubusercontent.com/vivivichu/App-Dev/claude/focused-hopper-2e5acx/server/src/index.js. Then tap **Deploy**.
5. Open the Worker's **Settings**:
   - **Bindings → Add → KV namespace:** set the variable name to `ITEMS` (exactly that) and the namespace to `lifeledger-items`.
   - **Variables and Secrets → Add**, and create each of these:

     | Name | Type | Value |
     |---|---|---|
     | `PLAID_ENV` | Text | `sandbox` |
     | `ALLOWED_ORIGINS` | Text | `https://vivivichu.github.io` |
     | `PLAID_CLIENT_ID` | Secret | your Plaid client_id |
     | `PLAID_SECRET` | Secret | your Plaid **Sandbox** secret |
     | `APP_PASSCODE` | Secret | the passcode from step 2 |

   - Tap **Deploy** or **Save** after adding them.
6. Copy the Worker's address. It looks like `https://lifeledger-sync.<your-name>.workers.dev`.

## 4. Connect the app and test with Plaid's fake bank

1. In LifeLedger, go to **Settings → Bank sync server**, paste the Worker address and your passcode, then tap **Save & test**. You should see "Connected to sync server (sandbox)".
2. Go to **Money → Bank accounts → Connect a bank**, choose any bank (for example "First Platypus Bank"), and sign in with username **`user_good`** and password **`pass_good`**. If it asks for a code, enter `1234`.
3. Fake accounts and transactions appear. That means everything works.
4. Tap **✕** next to the test bank to disconnect it, and choose **OK** to delete its fake transactions.

## 5. Switch to your real banks

1. In the Plaid Dashboard, copy your **Production secret**. If Plaid asks you to complete a short profile or questionnaire to use Production, do that first.
2. In your Cloudflare Worker's settings, change `PLAID_ENV` to `production` and replace the `PLAID_SECRET` value with the Production secret. Deploy.
3. In LifeLedger, tap **Connect a bank** and sign in to your real bank.

The app syncs automatically when you open it (at most every 4 hours), and you can tap **Sync now** at any time.

---

## Good to know

- **Categories:** Plaid's categories are mapped to the app's. Tap a transaction's category to change it, and future transactions from the same merchant follow your choice. Payments to your own credit card are marked **Transfer** and left out of income/spending totals so they aren't counted twice.
- **Pending transactions** are skipped. They show up once your bank posts them.
- **"Login needed":** if your bank password changes, or the bank asks you to sign in again, tap **Fix login** next to that bank.
- **Recurring items:** if you set up Salary or Rent as **Add automatically** under Recurring & bills, switch them to **Remind me to pay** or delete them once that bank syncs. Otherwise they're counted twice.
- **Some large banks (for example Chase)** sign you in on their own website ("OAuth"). If connecting one fails, check in the Plaid Dashboard whether that bank needs extra approval for your account. If Plaid asks for a redirect URI, add `https://vivivichu.github.io/App-Dev/` under **Developers → API → Allowed redirect URIs**. Then add a `PLAID_REDIRECT_URI` text variable with that same value to the Worker.
- **Privacy:** your transactions are stored on your phone. The server only stores the bank access tokens. Backups you export never include your passcode or the bank tokens.
- **Updating the server later:** paste the new `server/src/index.js` into the Worker editor and deploy again.

### Using the command line instead (optional, on a computer)

```bash
cd server
npm install
npx wrangler login
npx wrangler kv namespace create ITEMS     # paste the printed id into wrangler.toml
npx wrangler secret put PLAID_CLIENT_ID
npx wrangler secret put PLAID_SECRET
npx wrangler secret put APP_PASSCODE
npx wrangler deploy
npm test                                   # server unit tests
```
