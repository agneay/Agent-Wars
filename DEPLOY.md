# Hosting AAI AssetFlow + AirportOps AI (no GitHub needed)

Everything deploys straight from this folder with each provider's CLI.

| Part | Where | Cost |
|---|---|---|
| MySQL database | Railway MySQL (or Aiven free MySQL) | Railway: trial credit, then ~$5/mo; Aiven: free tier |
| Backend (`server/`, Express + MCP + agents) | Railway | included above |
| Frontend (React / TanStack Start) | Cloudflare Workers | free tier |

Why not Supabase: Supabase is PostgreSQL. All of the existing app's SQL (and the new agent tools) is MySQL, so moving would mean rewriting every query. A hosted MySQL keeps the code unchanged.

## 1. Export your local data (once)
```bash
cd server
node scripts/export-db.js        # writes server/db/aai_asset_dump.sql (schema + all records)
```

## 2. Database + backend on Railway
```bash
npm i -g @railway/cli
railway login
cd server
railway init                     # create a project
railway add --database mysql     # adds a MySQL service
railway up                       # uploads and deploys server/ (runs npm start)
```
In the Railway dashboard, open the backend service and go to **Variables**. Add:
- `MYSQL_URL` = `${{MySQL.MYSQL_URL}}` (reference to the database)
- `JWT_SECRET` = a long random string
- `CORS_ORIGIN` = your frontend URL (fill in after step 3)
- optional `ANTHROPIC_API_KEY`

Then **Settings → Networking → Generate Domain** to get e.g. `https://aai-api.up.railway.app`.

Load your data into the hosted database using the MySQL service's **public** URL (Variables tab, `MYSQL_PUBLIC_URL`):
```bash
DATABASE_URL="mysql://...public-url..." node scripts/import-db.js
```
(Aiven/TiDB instead of Railway: use their connection URL and add `DB_SSL=true`.)

Check: open `https://<your-api-domain>/api/health` → `{"status":"ok","database":"connected"}`.

## 3. Frontend on Cloudflare Workers
```bash
cd ..                            # project root
npx wrangler login
VITE_API_URL=https://<your-api-domain> npm run build
npx wrangler deploy
```
PowerShell: `$env:VITE_API_URL="https://<your-api-domain>"; npm run build; npx wrangler deploy`

Copy the `*.workers.dev` URL it prints into the backend's `CORS_ORIGIN` variable, then redeploy the backend (`railway up` in `server/`).

## 4. Use it
Open the workers.dev URL, sign in, go to **AI Ops**. Voice works in Chrome/Edge over HTTPS (both hosts give HTTPS automatically).

## Notes
- Demo data: `DATABASE_URL=... node scripts/demo-seed.js` resets only the synthetic `DEMO-*` / E102/E201/E301 records.
- Secrets live only in Railway variables. `server/.env.example` lists every setting.
- The MCP endpoint is `https://<your-api-domain>/mcp` (bearer = the app's login token).
