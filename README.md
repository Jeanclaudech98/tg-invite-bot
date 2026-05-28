# Telegram Invite Contest Bot

A production-grade Telegram bot that runs invite-based contests. Participants get unique invite links, the bot tracks who brings in the most members, and everyone can submit their wallet for prize distribution.

Built with Node.js + grammy + PostgreSQL.

## Features

- **Contest management** — Admins create contests with a title and duration
- **Unique invite links** — Each participant gets a single-use invite link
- **Real-time tracking** — Automatically records when someone joins via an invite link
- **Leaderboard** — See who invited the most members
- **Wallet submission** — Participants submit their crypto wallets for prizes
- **Rate limiting** — Protects against spam (5 commands per 10 seconds)
- **Graceful shutdown** — Handles SIGTERM/SIGINT cleanly
- **Structured logging** — JSON-formatted logs for monitoring

## Commands

### Admin
| Command | Description |
|---------|-------------|
| `/newcontest <title> \| <hours>` | Create a contest. Example: `/newcontest April Giveaway \| 72` |
| `/endcontest` | End the active contest immediately |
| `/contestinfo` | Show stats for the active contest |

### Users
| Command | Description |
|---------|-------------|
| `/start` | Welcome message and current contest info |
| `/join` | Join the active contest and get your invite link |
| `/wallet <address>` | Submit or update your crypto wallet |
| `/mystats` | Your personal invite stats |
| `/leaderboard` | Top 10 inviters |

## Quick Start

### Prerequisites
- Node.js 18+
- PostgreSQL 14+

### 1. Clone and install
```bash
git clone https://github.com/Jeanclaudech98/tg-invite-bot.git
cd tg-invite-bot
npm install
```

### 2. Configure environment
Create a `.env` file:

```env
BOT_TOKEN=your_telegram_bot_token
ADMIN_IDS=your_telegram_user_id
GROUP_CHAT_ID=-1001234567890
DATABASE_URL=postgresql://user:password@host:5432/tg_invite_bot
```

- **BOT_TOKEN** — Get from [@BotFather](https://t.me/BotFather) on Telegram
- **ADMIN_IDS** — Your Telegram user ID (comma-separated for multiple admins). Get it from [@userinfobot](https://t.me/userinfobot)
- **GROUP_CHAT_ID** — The group where invites will be tracked. The bot must be an admin in this group with "Invite Users" permission
- **DATABASE_URL** — PostgreSQL connection string

### 3. Run
```bash
node index.js
```

The bot creates all database tables automatically on first run.

### 4. Add bot to your group
1. Add the bot as an admin to your Telegram group
2. Grant it the "Invite Users" admin permission (required for creating invite links)
3. Users send `/join` in DM with the bot to get their invite link

## Database

The bot creates three tables automatically:

- **contests** — Contest metadata (title, timing, status)
- **participants** — Users who joined, their invite link, wallet
- **invites** — Tracked invites linking inviters to new members

## Production Deployment

### PM2
```bash
npm install -g pm2
pm2 start index.js --name tg-invite-bot
pm2 save
pm2 startup
```

### Docker
```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
CMD ["node", "index.js"]
```

## Tech Stack
- **Runtime:** Node.js 22
- **Framework:** [grammy](https://grammy.dev/)
- **Database:** PostgreSQL (via `pg`)
- **Schema:** Auto-created on first run

## Development
```bash
git clone https://github.com/Jeanclaudech98/tg-invite-bot.git
cd tg-invite-bot
npm install
cp .env.example .env   # fill in your values
node index.js
```