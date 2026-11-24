# LifeLedger

A personal dashboard for monitoring your finances and day-to-day activities. Plain HTML/CSS/JS: no build step and no server-side code.

## Features

- **Dashboard**: this month's income, spending and net; spending by category; budget progress; today's tasks and habits; and a 14-day income/spending chart with your daily mood.
- **Money**: log income and expenses with categories and notes, browse by month, and set monthly budgets per category (the bar turns amber above 80% and red when you go over).
- **Bank sync (US)**: connect US bank and credit card accounts through Plaid. Transactions, balances and net balance update automatically. This needs your own free sync server, set up as described in [SETUP-BANK-SYNC.md](SETUP-BANK-SYNC.md).
- **Statement import (CSV)**: for any other bank, such as Indian banks, where automatic sync isn't available. Column and date formats are detected automatically (HDFC, SBI, ICICI and Axis tested), transactions are categorised, and re-importing the same statement skips duplicates.
- **Multiple currencies**: each transaction keeps its own currency, and totals are converted to your home currency at rates you set. Tap a transaction's category to change it, and future imports from the same merchant follow your choice. Use **Transfer** for money moved between your own accounts so it isn't counted as spending.
- **Recurring & bills**: set up repeating income or expenses (weekly, monthly, yearly or one time).
  - **Add automatically**: salary, rent and subscriptions are entered as transactions on their due date. Any payments that came due while the app was closed are filled in when you next open it.
  - **Remind me to pay**: bills appear on the Dashboard 3 days before they're due and turn red when overdue, and the Money tab shows a count of bills due. Tap **Paid** to record the payment and move the bill to its next due date, or **Skip** to move on without recording anything.
- **Tasks**: to-dos with due dates and priorities. You can filter by open, due today/overdue, completed or all.
- **Habits**: daily habits with a 7-day check grid and streak counter.
- **Journal**: one entry per day with mood, hours of sleep and notes.
- **Settings**: currency, JSON backup export/import, CSV export of transactions, demo data, and erase all data.
- Works offline and can be installed to your phone's home screen (PWA). Supports light and dark mode.

## Run it

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

You can also open `index.html` directly, but offline/install support needs it served over http(s). For free hosting on GitHub Pages, go to Settings → Pages and deploy from this branch.

## Your data

Everything is stored in your browser's `localStorage` on the device you use. The only exception is bank sync: your sync server stores the bank access tokens, and transactions pass through it to your phone. Exported backups never include your sync passcode or bank tokens. Use **Settings → Export backup** to save a copy, or to move your data to another device.

## Project layout

- `index.html`, `styles.css`, `app.js`: the app
- `bank.js`: bank sync and CSV statement import
- `server/`: the bank sync server (Cloudflare Worker). Run `cd server && npm install && npm test` for its tests.
