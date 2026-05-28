const { Bot } = require("grammy");
const config = require("./config");
const db = require("./db");

const bot = new Bot(config.botToken);

function isAdmin(ctx) {
  return Boolean(ctx.from && config.adminIds.includes(ctx.from.id));
}

function requireAdmin(ctx) {
  if (isAdmin(ctx)) {
    return true;
  }

  ctx.reply("Sorry, this command is only available to admins.");
  return false;
}

function userLabel(row, fallback = "Anonymous") {
  return row.username ? `@${row.username}` : fallback;
}

function formatDate(value) {
  return new Date(value).toISOString().replace("T", " ").replace(".000Z", " UTC");
}

function validateWallet(address) {
  return address.startsWith("0x") || address.length >= 26;
}

function getCommandText(ctx) {
  return ctx.message?.text || "";
}

async function getFreshActiveContest() {
  await db.completeExpiredContests();
  return db.getActiveContest();
}

async function replyWithActiveContest(ctx) {
  const contest = await getFreshActiveContest();

  if (!contest) {
    await ctx.reply("No active contest is running right now.");
    return;
  }

  await ctx.reply(
    [
      `Active contest: ${contest.title}`,
      `Ends: ${formatDate(contest.ends_at)}`,
      "Use /join to enter and get your invite link.",
    ].join("\n"),
  );
}

bot.command("start", async (ctx) => {
  try {
    await ctx.reply("Welcome to the invite contest bot.");
    await replyWithActiveContest(ctx);
  } catch (error) {
    console.error("Failed to handle /start:", error);
    await ctx.reply("Something went wrong while loading contest info.");
  }
});

bot.command("newcontest", async (ctx) => {
  if (!requireAdmin(ctx)) return;

  try {
    const text = getCommandText(ctx).replace(/^\/newcontest(@\w+)?\s*/i, "");
    const [rawTitle, rawDuration] = text.split("|").map((part) => part && part.trim());
    const durationHours = Number(rawDuration);

    if (!rawTitle || !Number.isFinite(durationHours) || durationHours <= 0) {
      await ctx.reply("Usage: /newcontest <title> | <duration_hours>");
      return;
    }

    const existingContest = await getFreshActiveContest();
    if (existingContest) {
      await ctx.reply("There is already an active contest. Use /endcontest first.");
      return;
    }

    const contest = await db.createContest(rawTitle, durationHours);
    await ctx.reply(
      [
        `Contest created: ${contest.title}`,
        `Ends: ${formatDate(contest.ends_at)}`,
      ].join("\n"),
    );
  } catch (error) {
    console.error("Failed to handle /newcontest:", error);
    await ctx.reply("Could not create the contest. Please check the format and try again.");
  }
});

bot.command("endcontest", async (ctx) => {
  if (!requireAdmin(ctx)) return;

  try {
    const contest = await db.endActiveContest();
    if (!contest) {
      await ctx.reply("There is no active contest to end.");
      return;
    }

    await ctx.reply(`Contest ended: ${contest.title}`);
  } catch (error) {
    console.error("Failed to handle /endcontest:", error);
    await ctx.reply("Could not end the contest right now.");
  }
});

bot.command("contestinfo", async (ctx) => {
  if (!requireAdmin(ctx)) return;

  try {
    const contest = await getFreshActiveContest();
    if (!contest) {
      await ctx.reply("No active contest is running right now.");
      return;
    }

    const stats = await db.getContestStats(contest.id);
    await ctx.reply(
      [
        `Contest: ${stats.title}`,
        `Status: ${stats.status}`,
        `Started: ${formatDate(stats.starts_at)}`,
        `Ends: ${formatDate(stats.ends_at)}`,
        `Participants: ${stats.participant_count}`,
        `Invites: ${stats.invite_count}`,
      ].join("\n"),
    );
  } catch (error) {
    console.error("Failed to handle /contestinfo:", error);
    await ctx.reply("Could not load contest info right now.");
  }
});

bot.command("join", async (ctx) => {
  try {
    if (!ctx.from) {
      await ctx.reply("Could not identify your Telegram account.");
      return;
    }

    const contest = await getFreshActiveContest();
    if (!contest) {
      await ctx.reply("No active contest is running right now.");
      return;
    }

    const existingParticipant = await db.getParticipant(contest.id, ctx.from.id);
    if (existingParticipant?.invite_link) {
      await ctx.reply(`You are already in the contest.\nYour invite link: ${existingParticipant.invite_link}`);
      return;
    }

    const invite = await bot.api.createChatInviteLink(config.groupChatId, {
      member_limit: 1,
      name: `contest-${contest.id}-user-${ctx.from.id}`,
    });
    const participant = await db.upsertParticipant(contest.id, ctx.from, invite.invite_link);

    await ctx.reply(
      [
        `You joined: ${contest.title}`,
        `Your invite link: ${participant.invite_link}`,
        "Share it with one person. Each successful join counts as one invite.",
      ].join("\n"),
    );
  } catch (error) {
    console.error("Failed to handle /join:", error);
    await ctx.reply("Could not create your invite link right now. Please try again later.");
  }
});

bot.command("wallet", async (ctx) => {
  try {
    if (!ctx.from) {
      await ctx.reply("Could not identify your Telegram account.");
      return;
    }

    const walletAddress = getCommandText(ctx).replace(/^\/wallet(@\w+)?\s*/i, "").trim();
    if (!walletAddress) {
      await ctx.reply("Usage: /wallet <address>");
      return;
    }

    if (!validateWallet(walletAddress)) {
      await ctx.reply("Wallet address must start with 0x or be at least 26 characters long.");
      return;
    }

    const contest = await getFreshActiveContest();
    if (!contest) {
      await ctx.reply("No active contest is running right now.");
      return;
    }

    const participant = await db.updateWallet(contest.id, ctx.from.id, walletAddress);
    if (!participant) {
      await ctx.reply("Join the active contest first with /join, then submit your wallet.");
      return;
    }

    await ctx.reply("Wallet saved.");
  } catch (error) {
    console.error("Failed to handle /wallet:", error);
    await ctx.reply("Could not save your wallet right now.");
  }
});

bot.command("mystats", async (ctx) => {
  try {
    if (!ctx.from) {
      await ctx.reply("Could not identify your Telegram account.");
      return;
    }

    const contest = await getFreshActiveContest();
    if (!contest) {
      await ctx.reply("No active contest is running right now.");
      return;
    }

    const participant = await db.getParticipant(contest.id, ctx.from.id);
    if (!participant) {
      await ctx.reply("You have not joined the active contest yet. Use /join first.");
      return;
    }

    const inviteCount = await db.getInviteCount(contest.id, ctx.from.id);
    await ctx.reply(
      [
        `Contest: ${contest.title}`,
        `Your invites: ${inviteCount}`,
        `Wallet: ${participant.wallet_address || "not submitted"}`,
        `Invite link: ${participant.invite_link}`,
      ].join("\n"),
    );
  } catch (error) {
    console.error("Failed to handle /mystats:", error);
    await ctx.reply("Could not load your stats right now.");
  }
});

bot.command("leaderboard", async (ctx) => {
  try {
    const contest = await getFreshActiveContest();
    if (!contest) {
      await ctx.reply("No active contest is running right now.");
      return;
    }

    const rows = await db.getLeaderboard(contest.id, 10);
    if (rows.length === 0) {
      await ctx.reply("No one has joined the contest yet.");
      return;
    }

    const lines = rows.map((row, index) => {
      return `${index + 1}. ${userLabel(row, `User ${row.user_id}`)} - ${row.invite_count} invites`;
    });

    await ctx.reply([`Leaderboard: ${contest.title}`, ...lines].join("\n"));
  } catch (error) {
    console.error("Failed to handle /leaderboard:", error);
    await ctx.reply("Could not load the leaderboard right now.");
  }
});

bot.on("message:new_chat_members", async (ctx) => {
  try {
    const inviteLink = ctx.message?.invite_link?.invite_link;
    if (!inviteLink) {
      return;
    }

    const inviter = await db.getParticipantByInviteLink(inviteLink);
    if (!inviter || inviter.contest_status !== "active" || new Date(inviter.ends_at) <= new Date()) {
      return;
    }

    for (const member of ctx.message.new_chat_members) {
      if (member.is_bot || member.id === Number(inviter.user_id)) {
        continue;
      }

      await db.recordInvite(inviter.contest_id, inviter.user_id, member);
    }
  } catch (error) {
    console.error("Failed to track invite:", error);
  }
});

bot.catch((error) => {
  console.error("Bot error:", error);
});

async function main() {
  try {
    await db.initSchema();
    await bot.start();
  } catch (error) {
    console.error("Failed to start bot:", error);
    await db.close().catch((closeError) => {
      console.error("Failed to close database pool:", closeError);
    });
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  bot,
  main,
  validateWallet,
};
