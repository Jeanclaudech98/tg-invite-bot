require("dotenv").config();

const REQUIRED_ENV = ["BOT_TOKEN", "ADMIN_IDS", "GROUP_CHAT_ID", "DATABASE_URL"];

/**
 * @param {string} name
 * @returns {string}
 */
function requireEnv(name) {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

/**
 * @param {string} value
 * @returns {number[]}
 */
function parseAdminIds(value) {
  const ids = value
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  if (ids.length === 0) {
    throw new Error("ADMIN_IDS must contain at least one Telegram user id");
  }

  return ids.map((id) => {
    if (!/^-?\d+$/.test(id)) {
      throw new Error(`Invalid ADMIN_IDS entry: ${id}`);
    }

    const parsed = Number(id);
    if (!Number.isSafeInteger(parsed)) {
      throw new Error(`ADMIN_IDS entry is outside JavaScript safe integer range: ${id}`);
    }

    return parsed;
  });
}

/**
 * @param {string} value
 * @returns {number}
 */
function parseChatId(value) {
  if (!/^-?\d+$/.test(value)) {
    throw new Error("GROUP_CHAT_ID must be a numeric Telegram chat id");
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("GROUP_CHAT_ID is outside JavaScript safe integer range");
  }

  return parsed;
}

/**
 * Validate all required runtime configuration at module load so startup fails
 * before polling begins.
 */
function validateEnvironment() {
  for (const name of REQUIRED_ENV) {
    requireEnv(name);
  }
}

validateEnvironment();

/** @type {{ botToken: string, adminIds: number[], groupChatId: number, databaseUrl: string }} */
const config = {
  botToken: requireEnv("BOT_TOKEN"),
  adminIds: parseAdminIds(requireEnv("ADMIN_IDS")),
  groupChatId: parseChatId(requireEnv("GROUP_CHAT_ID")),
  databaseUrl: requireEnv("DATABASE_URL"),
};

module.exports = config;
