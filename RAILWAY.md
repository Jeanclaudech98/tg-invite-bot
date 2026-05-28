# Railway Deployment Guide

This guide walks you through deploying the Telegram Invite Contest Bot on [Railway](https://railway.app).

## Why Railway?

- **Free tier** — $5 credit monthly, enough for a bot + database
- **Auto HTTPS** — No certificate setup needed
- **Auto-deploy** — Push to GitHub, Railway deploys automatically
- **PostgreSQL** — One-click database provisioning
- **Always-on** — No sleeping like free-tier alternatives

## Step 1: Create a Railway account

Go to [https://railway.app](https://railway.app) and sign in with GitHub.

## Step 2: Deploy the bot

1. Click **"New Project"** → **"Deploy from GitHub repo"**
2. Select `Jeanclaudech98/tg-invite-bot`
3. Railway detects Node.js automatically and starts building

## Step 3: Add PostgreSQL

1. In your project dashboard, click **"New"** → **"Database"** → **"PostgreSQL"**
2. Wait for it to provision (30 seconds)
3. Click the PostgreSQL service → **"Connect"** tab
4. Copy the **Postgres Connection String** (starts with `postgresql://...`)

## Step 4: Configure environment variables

1. Click your bot service (not the database)
2. Go to the **"Variables"** tab
3. Add the following:

| Variable | Value |
|----------|-------|
| `BOT_TOKEN` | Your bot token from [@BotFather](https://t.me/BotFather) |
| `ADMIN_IDS` | Your Telegram user ID (get from [@userinfobot](https://t.me/userinfobot)) |
| `GROUP_CHAT_ID` | The group chat ID (numeric, with minus sign if supergroup) |
| `DATABASE_URL` | Paste the PostgreSQL connection string from Step 3 |

Important: Railway generates a new connection string each time you restart the database. To make it permanent, **reference the database service variable** instead of pasting the raw string:

In the Variables tab, set `DATABASE_URL` to:
```
${{Postgres.DATABASE_URL}}
```

This tells Railway to inject the connection string from your PostgreSQL service automatically. If the database restarts, your bot still connects.

## Step 5: Deploy

1. Railway builds and deploys automatically once variables are set
2. Check the **"Deployments"** tab for build logs
3. Once deployed, check **"Deploy Logs"** for:
   ```
   Database schema initialized
   Bot started
   ```
   If you see errors, check the variables are correct.

## Step 6: Keep it alive

Railway keeps your bot running 24/7 on paid plans. On the free tier ($5 credit):
- The bot costs ~$2-3/month with the PostgreSQL add-on
- No sleep or cold starts

## Updating the bot

Push changes to the GitHub repo and Railway auto-deploys:

```bash
git add -A
git commit -m "Update bot"
git push
```

Railway detects the push, rebuilds, and redeploys. The PostgreSQL database persists across deploys.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Bot doesn't respond | Check `BOT_TOKEN` is correct. Regenerate in BotFather if needed |
| `ECONNREFUSED` database | The `DATABASE_URL` may have changed — use `${{Postgres.DATABASE_URL}}` instead of a hardcoded string |
| Invite links not working | Bot must be admin in the group with **"Invite Users"** permission enabled |
| 429 Too Many Requests | Built-in rate limiting (5 commands/10s) prevents this. If hitting Telegram API limits, add delays between actions |
| Build fails | Ensure `npm install` runs. Check Railway build logs for specific errors |

## Cost Estimate (Free Tier)

| Service | Monthly Cost |
|---------|-------------|
| Bot service (Node.js) | ~$1.50 |
| PostgreSQL (512MB) | ~$2.00 |
| **Total** | **~$3.50** |

Free tier gives you $5 credit. One bot + DB fits comfortably.