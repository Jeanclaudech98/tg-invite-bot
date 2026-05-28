# Telegram Invite Contest Bot — Build Spec

## Stack
- Node.js (v22)
- grammy (Telegram bot framework)
- PostgreSQL 16 (running on localhost:5432 via Docker)
- pg (node-postgres) for database
- PM2 for process management

## Database
PostgreSQL connection: postgresql://postgres:invitebot123@localhost:5432/tg_invite_bot

### Schema (auto-create on first run)
CREATE TABLE contests (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ends_at TIMESTAMPTZ NOT NULL,
    status TEXT DEFAULT 'active' CHECK (status IN ('pending', 'active', 'completed'))
);

CREATE TABLE participants (
    id SERIAL PRIMARY KEY,
    contest_id INTEGER REFERENCES contests(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL,
    username TEXT,
    invite_link TEXT,
    wallet_address TEXT,
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(contest_id, user_id)
);

CREATE TABLE invites (
    id SERIAL PRIMARY KEY,
    contest_id INTEGER REFERENCES contests(id) ON DELETE CASCADE,
    inviter_user_id BIGINT NOT NULL,
    invited_user_id BIGINT NOT NULL,
    invited_username TEXT,
    invited_at TIMESTAMPTZ DEFAULT NOW()
);

## Bot Commands

### Admin (configurable ADMIN_IDS)
- /newcontest <title> | <duration_hours> - Creates a contest
- /endcontest - End current active contest
- /contestinfo - Show active contest stats
- /leaderboard - Show invite leaderboard

### Users
- /start - Welcome + info about active contest
- /join - Join the active contest, get a unique invite link
- /wallet <address> - Submit or update your crypto wallet
- /mystats - Your personal invite count
- /leaderboard - See top inviters (top 10)

## Key Implementation Details

### Invite Link Generation
Use bot.api.createChatInviteLink(chatId, { member_limit: 1 }) to generate unique single-use invite links per participant.

Track new_chat_members. When someone joins via an invite link, check if the link matches any participant's invite_link. Record the invite.

### Wallet Validation
Must start with 0x (Ethereum) or be at least 26 characters.

### Error Handling
All errors return friendly messages. Database errors log to console.

## Config (.env)
BOT_TOKEN=your_bot_token_here
ADMIN_IDS=123456789,987654321
GROUP_CHAT_ID=-1001234567890
DATABASE_URL=postgresql://postgres:invitebot123@localhost:5432/tg_invite_bot

## File Structure
tg-invite-bot/
  index.js          # Main entry: bot init, polling, command registration
  db.js             # Database pool, schema init, all query functions
  config.js         # Load .env, export config object
  package.json      # Dependencies: grammy, pg, dotenv
  .env              # Not committed to git

## PM2
Start with: pm2 start index.js --name tg-invite-bot

## Rules
1. Create ALL files needed for the bot to work
2. Initialize the database schema automatically on first run
3. Add proper error handling everywhere
4. Format the code cleanly
5. Make sure .env is in .gitignore
6. Run npm init first, then npm install dependencies
7. Test that the bot starts without errors (verify node index.js starts)