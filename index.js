const { Bot, session } = require("grammy");
const config = require("./config");
const db = require("./db");

const ACTIVE_CONTEST_TTL_MS = 10_000;
const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_MAX_COMMANDS = 5;
const SHUTDOWN_TIMEOUT_MS = 10_000;

const bot = new Bot(config.botToken);
const activeContestCache = { value: null, expiresAt: 0 };
const rateLimitBuckets = new Map();
let isShuttingDown = false;

const BOT_COMMANDS = [
  { command: "start", description: "Show welcome message and active contest" },
  { command: "help", description: "Show available commands" },
  { command: "join", description: "Join the active contest (DM only)" },
  { command: "wallet", description: "Submit your wallet address (DM only)" },
  { command: "mystats", description: "View your invite stats (DM only)" },
  { command: "leaderboard", description: "View the invite leaderboard" },
  { command: "contestinfo", description: "Admin: view contest details" },
  { command: "newcontest", description: "Admin: create a new contest" },
  { command: "endcontest", description: "Admin: end the active contest" },
];

/**
 * @typedef {{ activeContest?: { value: Record<string, unknown> | null, expiresAt: number } }} SessionData
 * @typedef {import("grammy").Context & { session: SessionData, isAdmin?: boolean, isPrivateChat?: boolean, requireAdmin?: () => Promise<boolean> }} BotContext
 */

/**
 * @returns {SessionData}
 */
function initialSession() {
  return {};
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {BotContext | null} ctx
 * @param {unknown} error
 * @param {string} command
 * @param {Record<string, unknown>} [extra]
 */
function logStructuredError(ctx, error, command, extra = {}) {
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    command,
    userId: ctx?.from?.id || null,
    chatId: ctx?.chat?.id || null,
    error: errorMessage(error),
    ...extra,
  }));
}

/**
 * @param {string} event
 * @param {Record<string, unknown>} data
 */
function logEvent(event, data) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    event,
    ...data,
  }));
}

/**
 * @param {string} value
 * @returns {string}
 */
function sanitizeInput(value) {
  return String(value || "").trim().replace(/[\u0000-\u001f\u007f]/g, "");
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeMarkdown(value) {
  return value.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

/**
 * @param {string} value
 * @param {number} maxLength
 * @returns {{ ok: true, value: string } | { ok: false, reason: string }}
 */
function validateLength(value, maxLength) {
  const sanitized = sanitizeInput(value);
  if (sanitized.length > maxLength) {
    return { ok: false, reason: `Please keep this under ${maxLength} characters.` };
  }
  return { ok: true, value: sanitized };
}

/**
 * @param {Record<string, unknown>} row
 * @param {string} [fallback]
 * @returns {string}
 */
function userLabel(row, fallback = "Anonymous") {
  return row.username ? `@${escapeMarkdown(String(row.username))}` : escapeMarkdown(fallback);
}

/**
 * @param {string | Date} value
 * @returns {string}
 */
function formatDate(value) {
  return new Date(value).toISOString().replace("T", " ").replace(".000Z", " UTC");
}

/**
 * @param {string} address
 * @returns {boolean}
 */
function validateWallet(address) {
  return /^(0x[a-fA-F0-9]{20,98}|[A-Za-z0-9:_-]{26,100})$/.test(address);
}

/**
 * @param {BotContext} ctx
 * @returns {string}
 */
function getCommandText(ctx) {
  return sanitizeInput(ctx.message?.text || "");
}

/**
 * @param {BotContext} ctx
 * @returns {Promise<boolean>}
 */
async function enforceRateLimit(ctx) {
  const text = ctx.message?.text || "";
  if (!text.startsWith("/")) return true;

  const userId = ctx.from?.id;
  if (!userId) return true;

  const now = Date.now();
  const bucket = rateLimitBuckets.get(userId) || [];
  const recent = bucket.filter((timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS);

  if (recent.length >= RATE_LIMIT_MAX_COMMANDS) {
    rateLimitBuckets.set(userId, recent);
    await ctx.reply("Please slow down.");
    return false;
  }

  recent.push(now);
  rateLimitBuckets.set(userId, recent);
  return true;
}

/**
 * @param {BotContext} ctx
 * @returns {Promise<Record<string, unknown> | null>}
 */
async function getCachedActiveContest(ctx) {
  const now = Date.now();

  if (ctx.session.activeContest && ctx.session.activeContest.expiresAt > now) {
    return ctx.session.activeContest.value;
  }

  if (activeContestCache.expiresAt > now) {
    ctx.session.activeContest = {
      value: activeContestCache.value,
      expiresAt: activeContestCache.expiresAt,
    };
    return activeContestCache.value;
  }

  const contest = await db.getActiveContest();
  activeContestCache.value = contest;
  activeContestCache.expiresAt = now + ACTIVE_CONTEST_TTL_MS;
  ctx.session.activeContest = {
    value: contest,
    expiresAt: activeContestCache.expiresAt,
  };

  return contest;
}

function clearActiveContestCache() {
  activeContestCache.value = null;
  activeContestCache.expiresAt = 0;
}

/**
 * @param {BotContext} ctx
 */
async function replyWithActiveContest(ctx) {
  const contest = await getCachedActiveContest(ctx);

  if (!contest) {
    await ctx.reply("No active contest is running right now.");
    return;
  }

  await ctx.reply(
    [
      `Active contest: ${escapeMarkdown(String(contest.title))}`,
      `Ends: ${escapeMarkdown(formatDate(contest.ends_at))}`,
      "Use /join to enter and get your invite link.",
    ].join("\n"),
    { parse_mode: "MarkdownV2" },
  );
}

/**
 * @param {BotContext} ctx
 * @param {string} command
 * @param {(ctx: BotContext) => Promise<void>} handler
 */
async function runCommand(ctx, command, handler) {
  try {
    await handler(ctx);
  } catch (error) {
    logStructuredError(ctx, error, command);
    await ctx.reply("Something went wrong. Please try again later.");
  }
}

bot.use(session({ initial: initialSession }));

bot.use(async (ctx, next) => {
  /** @type {BotContext} */
  const typedCtx = ctx;
  typedCtx.isPrivateChat = ctx.chat?.type === "private";

  await next();
});

bot.use(async (ctx, next) => {
  /** @type {BotContext} */
  const typedCtx = ctx;
  typedCtx.isAdmin = Boolean(ctx.from && config.adminIds.includes(ctx.from.id));
  typedCtx.requireAdmin = async () => {
    if (typedCtx.isAdmin) return true;
    await typedCtx.reply("Sorry, this command is only available to admins.");
    return false;
  };

  await next();
});

bot.use(async (ctx, next) => {
  if (!(await enforceRateLimit(ctx))) return;
  await next();
});

bot.command("start", async (ctx) => {
  await runCommand(ctx, "start", async (typedCtx) => {
    if (!typedCtx.isPrivateChat) {
      await typedCtx.reply("Hi! Send /join in DM with me to join the contest.");
      return;
    }

    await typedCtx.reply("Welcome to the invite contest bot.");
    await replyWithActiveContest(typedCtx);
  });
});

bot.command("help", async (ctx) => {
  await runCommand(ctx, "help", async (typedCtx) => {
    const lines = BOT_COMMANDS.map(({ command, description }) => `/${command} - ${description}`);
    await typedCtx.reply(["Available commands:", ...lines].join("\n"));
  });
});

bot.command("newcontest", async (ctx) => {
  await runCommand(ctx, "newcontest", async (typedCtx) => {
    if (!(await typedCtx.requireAdmin())) return;

    const text = getCommandText(typedCtx).replace(/^\/newcontest(@\w+)?\s*/i, "");
    const [rawTitle = "", rawDuration = ""] = text.split("|");
    const titleResult = validateLength(rawTitle, 100);
    const durationHours = Number(sanitizeInput(rawDuration));

    if (!titleResult.ok) {
      await typedCtx.reply(titleResult.reason);
      return;
    }

    if (!titleResult.value || !Number.isFinite(durationHours) || durationHours <= 0 || durationHours > 24 * 365) {
      await typedCtx.reply("Usage: /newcontest <title> | <duration_hours>");
      return;
    }

    const existingContest = await getCachedActiveContest(typedCtx);
    if (existingContest) {
      await typedCtx.reply("There is already an active contest. Use /endcontest first.");
      return;
    }

    const contest = await db.createContest(titleResult.value, durationHours);
    clearActiveContestCache();
    typedCtx.session.activeContest = undefined;

    await typedCtx.reply(
      [
        `Contest created: ${escapeMarkdown(String(contest.title))}`,
        `Ends: ${escapeMarkdown(formatDate(contest.ends_at))}`,
      ].join("\n"),
      { parse_mode: "MarkdownV2" },
    );
  });
});

bot.command("endcontest", async (ctx) => {
  await runCommand(ctx, "endcontest", async (typedCtx) => {
    if (!(await typedCtx.requireAdmin())) return;

    const contest = await db.endActiveContest();
    clearActiveContestCache();
    typedCtx.session.activeContest = undefined;

    if (!contest) {
      await typedCtx.reply("There is no active contest to end.");
      return;
    }

    await typedCtx.reply(`Contest ended: ${escapeMarkdown(String(contest.title))}`, { parse_mode: "MarkdownV2" });
  });
});

bot.command("contestinfo", async (ctx) => {
  await runCommand(ctx, "contestinfo", async (typedCtx) => {
    if (!(await typedCtx.requireAdmin())) return;

    const contest = await getCachedActiveContest(typedCtx);
    if (!contest) {
      await typedCtx.reply("No active contest is running right now.");
      return;
    }

    const stats = await db.getContestStats(contest.id);
    await typedCtx.reply(
      [
        `Contest: ${escapeMarkdown(String(stats.title))}`,
        `Status: ${escapeMarkdown(String(stats.status))}`,
        `Started: ${escapeMarkdown(formatDate(stats.starts_at))}`,
        `Ends: ${escapeMarkdown(formatDate(stats.ends_at))}`,
        `Participants: ${stats.participant_count}`,
        `Invites: ${stats.invite_count}`,
      ].join("\n"),
      { parse_mode: "MarkdownV2" },
    );
  });
});

bot.command("join", async (ctx) => {
  await runCommand(ctx, "join", async (typedCtx) => {
    if (!typedCtx.isPrivateChat) {
      await typedCtx.reply("Please send this command in DM with the bot.");
      return;
    }

    if (!typedCtx.from) {
      await typedCtx.reply("Could not identify your Telegram account.");
      return;
    }

    const contest = await getCachedActiveContest(typedCtx);
    if (!contest) {
      await typedCtx.reply("No active contest is running right now.");
      return;
    }

    const existingParticipant = await db.getParticipant(contest.id, typedCtx.from.id);
    if (existingParticipant?.invite_link) {
      await typedCtx.reply(`You are already in the contest.\nYour invite link: ${existingParticipant.invite_link}`);
      return;
    }

    const invite = await bot.api.createChatInviteLink(config.groupChatId, {
      member_limit: 1,
      name: `contest-${contest.id}-user-${typedCtx.from.id}`,
    });
    const participant = await db.upsertParticipant(contest.id, typedCtx.from, invite.invite_link);

    await typedCtx.reply(
      [
        `You joined: ${escapeMarkdown(String(contest.title))}`,
        `Your invite link: ${escapeMarkdown(String(participant.invite_link))}`,
        "Share it with one person. Each successful join counts as one invite.",
      ].join("\n"),
      { parse_mode: "MarkdownV2" },
    );
  });
});

bot.command("wallet", async (ctx) => {
  await runCommand(ctx, "wallet", async (typedCtx) => {
    if (!typedCtx.isPrivateChat) {
      await typedCtx.reply("Please submit your wallet in DM with the bot.");
      return;
    }

    if (!typedCtx.from) {
      await typedCtx.reply("Could not identify your Telegram account.");
      return;
    }

    const walletAddress = getCommandText(typedCtx).replace(/^\/wallet(@\w+)?\s*/i, "");
    const walletResult = validateLength(walletAddress, 100);

    if (!walletResult.ok) {
      await typedCtx.reply(walletResult.reason);
      return;
    }

    if (!walletResult.value) {
      await typedCtx.reply("Usage: /wallet <address>");
      return;
    }

    if (!validateWallet(walletResult.value)) {
      await typedCtx.reply("That wallet address does not look valid. Please check it and try again.");
      return;
    }

    const contest = await getCachedActiveContest(typedCtx);
    if (!contest) {
      await typedCtx.reply("No active contest is running right now.");
      return;
    }

    const participant = await db.updateWallet(contest.id, typedCtx.from.id, walletResult.value);
    if (!participant) {
      await typedCtx.reply("Join the active contest first with /join, then submit your wallet.");
      return;
    }

    await typedCtx.reply("Wallet saved.");
  });
});

bot.command("mystats", async (ctx) => {
  await runCommand(ctx, "mystats", async (typedCtx) => {
    if (!typedCtx.isPrivateChat) {
      await typedCtx.reply("Please send this command in DM with the bot.");
      return;
    }

    if (!typedCtx.from) {
      await typedCtx.reply("Could not identify your Telegram account.");
      return;
    }

    const contest = await getCachedActiveContest(typedCtx);
    if (!contest) {
      await typedCtx.reply("No active contest is running right now.");
      return;
    }

    const participant = await db.getParticipantWithInviteCount(contest.id, typedCtx.from.id);
    if (!participant) {
      await typedCtx.reply("You have not joined the active contest yet. Use /join first.");
      return;
    }

    await typedCtx.reply(
      [
        `Contest: ${escapeMarkdown(String(contest.title))}`,
        `Your invites: ${participant.invite_count}`,
        `Wallet: ${participant.wallet_address ? escapeMarkdown(String(participant.wallet_address)) : "not submitted"}`,
        `Invite link: ${escapeMarkdown(String(participant.invite_link))}`,
      ].join("\n"),
      { parse_mode: "MarkdownV2" },
    );
  });
});

bot.command("leaderboard", async (ctx) => {
  await runCommand(ctx, "leaderboard", async (typedCtx) => {
    const contest = await getCachedActiveContest(typedCtx);
    if (!contest) {
      await typedCtx.reply("No active contest is running right now.");
      return;
    }

    const rows = await db.getLeaderboard(contest.id, 10);
    if (rows.length === 0) {
      await typedCtx.reply("No one has joined the contest yet.");
      return;
    }

    const lines = rows.map((row, index) => {
      return `${index + 1}\\. ${userLabel(row, `User ${row.user_id}`)} \\- ${row.invite_count} invites`;
    });

    await typedCtx.reply([`Leaderboard: ${escapeMarkdown(String(contest.title))}`, ...lines].join("\n"), {
      parse_mode: "MarkdownV2",
    });
  });
});

bot.on("message:new_chat_members", async (ctx) => {
  await runCommand(ctx, "new_chat_members", async (typedCtx) => {
    const inviteLink = typedCtx.message?.invite_link?.invite_link;
    const inviteName = typedCtx.message?.invite_link?.name || null;

    if (!inviteLink) {
      logEvent("invite_event_ignored", { reason: "missing_invite_link", chatId: typedCtx.chat?.id || null });
      return;
    }

    const inviter = await db.getParticipantByInviteLink(inviteLink);
    if (!inviter || inviter.contest_status !== "active" || new Date(inviter.ends_at) <= new Date()) {
      logEvent("invite_event_ignored", {
        reason: "inactive_or_unknown_link",
        inviteName,
        chatId: typedCtx.chat?.id || null,
      });
      return;
    }

    for (const member of typedCtx.message.new_chat_members) {
      if (member.is_bot || member.id === Number(inviter.user_id)) {
        logEvent("invite_event_ignored", {
          reason: member.is_bot ? "bot_member" : "self_invite",
          contestId: inviter.contest_id,
          inviterUserId: inviter.user_id,
          invitedUserId: member.id,
          inviteName,
        });
        continue;
      }

      const recorded = await db.recordInvite(
        inviter.contest_id,
        Number(inviter.user_id),
        inviter.username || null,
        member,
      );

      logEvent(recorded ? "invite_recorded" : "invite_duplicate_ignored", {
        contestId: inviter.contest_id,
        inviterUserId: inviter.user_id,
        inviterUsername: inviter.username || null,
        invitedUserId: member.id,
        invitedUsername: member.username || null,
        inviteName,
      });
    }
  });
});

bot.catch((error) => {
  logStructuredError(error.ctx, error.error, "bot");
});

/**
 * @param {string} signal
 */
async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logEvent("shutdown_started", { signal });

  const timeout = setTimeout(() => {
    logStructuredError(null, new Error("Graceful shutdown timed out"), "shutdown", { signal });
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  try {
    await bot.stop();
  } catch (error) {
    logStructuredError(null, error, "shutdown_bot", { signal });
  }

  try {
    await db.close();
  } catch (error) {
    logStructuredError(null, error, "shutdown_db", { signal });
  } finally {
    clearTimeout(timeout);
  }

  logEvent("shutdown_completed", { signal });
  process.exit(0);
}

async function main() {
  try {
    await db.assertReachable();
    await db.initSchema();
    await bot.init();
    await bot.api.setMyCommands(BOT_COMMANDS);

    process.once("SIGTERM", () => {
      void shutdown("SIGTERM");
    });
    process.once("SIGINT", () => {
      void shutdown("SIGINT");
    });

    await bot.start();
  } catch (error) {
    logStructuredError(null, error, "startup");
    await db.close().catch((closeError) => {
      logStructuredError(null, closeError, "startup_db_close");
    });
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  bot,
  escapeMarkdown,
  main,
  sanitizeInput,
  shutdown,
  validateWallet,
};
