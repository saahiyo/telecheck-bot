# TeleCheck Telegram Bot (Node.js)

Telegram bot that validates Telegram links using the same API used by `saahiyo/telecheck-webui`.

## Features
- `/check <link>` for single link validation
- Bulk validation by sending multiple links in one message
- `/stats` to read TeleCheck API counters
- Handles unknown response formats gracefully

## Setup
1. Install dependencies:
   npm install
2. Create env file:
   copy .env.example .env
3. Put your bot token in `.env` (`BOT_TOKEN=...`)
4. Run:
   npm run start

## Commands
- `/start`
- `/help`
- `/check https://t.me/example`
- `/stats`
- `/bulk` then send many links

## Notes
- API endpoint defaults to `https://telecheck.vercel.app`
- If the bulk API request body shape changes, the bot retries with alternate payload formats.
