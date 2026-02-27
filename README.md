# TeleCheck Telegram Bot (Node.js)

Telegram bot for validating Telegram links using `https://telecheck.vercel.app`.

## Features
- `/check <link>` single-link validation
- `/bulk` reply workflow for multi-link checks
- full result output in safe chunks (no 30-row truncation)
- valid links shown first, then invalid, then unknown
- bulk fallback to per-link checks when bulk response shape changes
- retries with backoff for transient API failures
- per-user rate limiting and input-size limits
- optional chat allowlist and admin-only `/health`
- polling mode (default) or webhook mode

## Local Run
1. `npm install`
2. `copy .env.example .env`
3. Set `BOT_TOKEN` in `.env`
4. `npm run start`

## Commands
- `/start`
- `/help`
- `/check https://t.me/example`
- `/bulk`
- `/stats`
- `/health` (admin only if `ADMIN_USER_IDS` is set)

## Tests
- `npm test`

## VPS (PM2)
1. Install Node.js 20+
2. `npm ci --omit=dev`
3. `copy .env.example .env` and configure values
4. `npm i -g pm2`
5. `pm2 start ecosystem.config.cjs`
6. `pm2 save`
7. `pm2 startup`

## Docker
1. Build: `docker build -t telecheck-bot .`
2. Run:
   `docker run -d --name telecheck-bot --env-file .env telecheck-bot`

## Webhook mode (optional)
Set in `.env`:
- `WEBHOOK_DOMAIN=https://your-domain.tld`
- `WEBHOOK_PATH=/telegram/webhook`
- `WEBHOOK_PORT=3000`
- `WEBHOOK_SECRET_TOKEN=<random-secret>`

If `WEBHOOK_DOMAIN` is empty, bot runs in polling mode.
