require("dotenv").config();

function requireEnv(name) {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function parseAdminIds(value) {
  if (!value || value.trim() === "") {
    return [];
  }

  return value
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => {
      if (!/^-?\d+$/.test(id)) {
        throw new Error(`Invalid ADMIN_IDS entry: ${id}`);
      }
      return Number(id);
    });
}

function parseChatId(value) {
  if (!/^-?\d+$/.test(value)) {
    throw new Error("GROUP_CHAT_ID must be a numeric Telegram chat id");
  }
  return Number(value);
}

const config = {
  botToken: requireEnv("BOT_TOKEN"),
  adminIds: parseAdminIds(process.env.ADMIN_IDS),
  groupChatId: parseChatId(requireEnv("GROUP_CHAT_ID")),
  databaseUrl:
    process.env.DATABASE_URL ||
    "postgresql://postgres:invitebot123@localhost:5432/tg_invite_bot",
};

module.exports = config;
