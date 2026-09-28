# BillBolt Backend

Node/Express + Prisma + PostgreSQL API for BillBolt. Same pattern as
RentAdmin: deploy this on Render, database on Supabase.

## 1. Create the Supabase project

1. Go to supabase.com → New project. Save the database password you set.
2. Project Settings → Database → Connect → note down 3 simple pieces
   (don't try to assemble the connection string by hand — the next step
   builds it for you, correctly, even if your password has `$` or other
   symbols in it):
   - **Host** — e.g. `aws-0-us-east-2.pooler.supabase.com`
   - **User** — e.g. `postgres.kyjesprlzkvmzmlpngcj`
   - **Password** — exactly as you set it, no encoding needed

## 2. Push this code to GitHub

```
cd backend
git init
git add .
git commit -m "BillBolt backend"
git remote add origin https://github.com/YOUR_USERNAME/billbolt-backend.git
git push -u origin main
```

(`.env` is already git-ignored — never commit real credentials.)

## 3. Deploy on Render

1. Render dashboard → New → Web Service → connect the repo above.
2. Settings:
   - **Runtime**: Node
   - **Build Command**:
     `npm install && npm run prepare-env && npx prisma generate && npx prisma migrate deploy`
   - **Start Command**: `npm start`
3. Environment Variables (Render service → Environment) — paste each
   piece from step 1 into its own field, exactly as Supabase shows it:
   - `SUPABASE_HOST` — the Host from step 1
   - `SUPABASE_USER` — the User from step 1
   - `SUPABASE_PASSWORD` — the raw password, exactly as-is (yes, even
     with `$` in it — nothing to encode by hand, the build step handles
     that automatically)
   - `JWT_SECRET` — generate one:
     `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   - `CORS_ORIGIN` — the URL where you'll host the frontend (add it after
     step 4, then redeploy — `*` works temporarily while testing)
   - `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` — for real push notifications.
     Generate your own pair:
     `node -e "console.log(require('web-push').generateVAPIDKeys())"`
   - `VAPID_SUBJECT` — `mailto:you@example.com` (any contact address)
   - `CRON_SECRET` — another random string (same command as `JWT_SECRET`)
4. Deploy. First deploy runs the Prisma migration automatically and
   creates all four tables (User, Client, Document, Payment).
5. Visit `https://your-service.onrender.com/health` — should return
   `{"ok":true}`.

## 4. Host the frontend

The frontend is the `index.html` (+ `manifest.json` + `service-worker.js`)
from the other delivered folder. Before hosting it:

1. Open `index.html`, find this line near the top of the `<script>`:
   ```js
   const API_BASE = 'https://YOUR-BACKEND-URL.onrender.com/api';
   ```
   Replace it with your actual Render backend URL from step 3.
2. Upload all three files (same folder) to Netlify Drop / GitHub Pages /
   your own hosting — same as before.
3. Go back to Render → your backend service → Environment → set
   `CORS_ORIGIN` to that frontend's real URL → redeploy the backend.

## 5. First run

Open the frontend URL. Since no account exists yet, it'll show "Create
Login" — set a username and password once. Every device that logs in
with those same credentials sees the same invoices, clients and
payments, kept in sync through the database.

## 6. Push notifications (real, arrive even with the app closed)

1. On the client's phone, open the frontend URL and **add it to the home
   screen first** (Share → Add to Home Screen on iPhone; ⋮ menu → Install
   app on Android). Push only works from the installed app, not a regular
   browser tab — this is a browser/OS rule, not something this app
   controls. On iPhone this also needs iOS 16.4+.
2. Open the installed app → **Due Dates** page → **🔔 Enable Reminders**.
   That subscribes this specific device.
3. The server checks every account once a day and pushes a reminder to
   every subscribed device that has something due soon. Two ways this
   check can run — pick ONE:
   - **Simplest**: leave it as-is. The backend has a built-in daily timer
     (`REMINDER_CRON` env var, default 13:00 UTC). Works out of the box,
     but on Render's **free tier** the service can spin down when idle,
     and a sleeping service can't fire its own timer.
   - **More reliable on the free tier**: Render dashboard → New → Cron
     Job → same repo → Command: nothing to build, it just needs to `curl`
     your own backend:
     ```
     curl -X POST https://your-backend.onrender.com/api/push/run-daily-check \
       -H "X-Cron-Secret: <your CRON_SECRET value>"
     ```
     Schedule it once a day. This also wakes the free-tier service up in
     the process. If you set this up, set `ENABLE_IN_PROCESS_CRON=false`
     on the web service so it doesn't also fire its own (harmless either
     way, just redundant).

## Notes

- Render's free tier spins down after inactivity — the first request
  after a while can take ~30 seconds to wake it up (same as RentAdmin).
- Render's free Postgres databases expire after 90 days — that's why
  this uses Supabase instead, same fix already applied to RentAdmin.
- Consider setting up the same daily `pg_dump` GitHub Action backup used
  for RentAdmin if this client's data matters long-term.
