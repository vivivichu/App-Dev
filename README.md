# LifeLedger

A personal dashboard for monitoring your finances and day-to-day activities. Plain HTML/CSS/JS: no build step and no server-side code.

## Features

- **Dashboard**: this month's income, spending and net; spending by category; budget progress; today's tasks and habits; and a 14-day income/spending chart with your daily mood.
- **Money**: log income and expenses with categories and notes, browse by month, and set monthly budgets per category (the bar turns amber above 80% and red when you go over).
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

Everything is stored in your browser's `localStorage` on the device you use. Nothing is sent anywhere. Use **Settings → Export backup** to save a copy, or to move your data to another device.
