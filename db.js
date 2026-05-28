const { Pool } = require("pg");
const config = require("./config");

const pool = new Pool({
  connectionString: config.databaseUrl,
});

async function query(text, params = []) {
  try {
    const result = await pool.query(text, params);
    return result;
  } catch (error) {
    console.error("Database error:", error);
    throw error;
  }
}

async function initSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS contests (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ends_at TIMESTAMPTZ NOT NULL,
      status TEXT DEFAULT 'active' CHECK (status IN ('pending', 'active', 'completed'))
    );

    CREATE TABLE IF NOT EXISTS participants (
      id SERIAL PRIMARY KEY,
      contest_id INTEGER REFERENCES contests(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL,
      username TEXT,
      invite_link TEXT,
      wallet_address TEXT,
      joined_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(contest_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS invites (
      id SERIAL PRIMARY KEY,
      contest_id INTEGER REFERENCES contests(id) ON DELETE CASCADE,
      inviter_user_id BIGINT NOT NULL,
      invited_user_id BIGINT NOT NULL,
      invited_username TEXT,
      invited_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS invites_unique_invited_per_contest
      ON invites (contest_id, invited_user_id);

    CREATE INDEX IF NOT EXISTS participants_invite_link_idx
      ON participants (invite_link);

    CREATE INDEX IF NOT EXISTS invites_contest_inviter_idx
      ON invites (contest_id, inviter_user_id);
  `);
}

async function createContest(title, durationHours) {
  const result = await query(
    `
      INSERT INTO contests (title, ends_at, status)
      VALUES ($1, NOW() + ($2::text || ' hours')::interval, 'active')
      RETURNING *
    `,
    [title, durationHours],
  );

  return result.rows[0];
}

async function getActiveContest() {
  const result = await query(
    `
      SELECT *
      FROM contests
      WHERE status = 'active' AND ends_at > NOW()
      ORDER BY created_at DESC
      LIMIT 1
    `,
  );

  return result.rows[0] || null;
}

async function completeExpiredContests() {
  await query(`
    UPDATE contests
    SET status = 'completed'
    WHERE status = 'active' AND ends_at <= NOW()
  `);
}

async function endActiveContest() {
  const result = await query(
    `
      UPDATE contests
      SET status = 'completed', ends_at = NOW()
      WHERE id = (
        SELECT id
        FROM contests
        WHERE status = 'active'
        ORDER BY created_at DESC
        LIMIT 1
      )
      RETURNING *
    `,
  );

  return result.rows[0] || null;
}

async function upsertParticipant(contestId, user, inviteLink) {
  const result = await query(
    `
      INSERT INTO participants (contest_id, user_id, username, invite_link)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (contest_id, user_id)
      DO UPDATE SET
        username = EXCLUDED.username,
        invite_link = COALESCE(participants.invite_link, EXCLUDED.invite_link)
      RETURNING *
    `,
    [contestId, user.id, user.username || null, inviteLink],
  );

  return result.rows[0];
}

async function getParticipant(contestId, userId) {
  const result = await query(
    `
      SELECT *
      FROM participants
      WHERE contest_id = $1 AND user_id = $2
      LIMIT 1
    `,
    [contestId, userId],
  );

  return result.rows[0] || null;
}

async function getParticipantByInviteLink(inviteLink) {
  const result = await query(
    `
      SELECT p.*, c.status AS contest_status, c.ends_at
      FROM participants p
      JOIN contests c ON c.id = p.contest_id
      WHERE p.invite_link = $1
      LIMIT 1
    `,
    [inviteLink],
  );

  return result.rows[0] || null;
}

async function updateWallet(contestId, userId, walletAddress) {
  const result = await query(
    `
      UPDATE participants
      SET wallet_address = $3
      WHERE contest_id = $1 AND user_id = $2
      RETURNING *
    `,
    [contestId, userId, walletAddress],
  );

  return result.rows[0] || null;
}

async function recordInvite(contestId, inviterUserId, invitedUser) {
  const result = await query(
    `
      INSERT INTO invites (contest_id, inviter_user_id, invited_user_id, invited_username)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (contest_id, invited_user_id) DO NOTHING
      RETURNING *
    `,
    [contestId, inviterUserId, invitedUser.id, invitedUser.username || null],
  );

  return result.rows[0] || null;
}

async function getInviteCount(contestId, userId) {
  const result = await query(
    `
      SELECT COUNT(*)::int AS count
      FROM invites
      WHERE contest_id = $1 AND inviter_user_id = $2
    `,
    [contestId, userId],
  );

  return result.rows[0].count;
}

async function getLeaderboard(contestId, limit = 10) {
  const result = await query(
    `
      SELECT
        p.user_id,
        p.username,
        p.wallet_address,
        COUNT(i.id)::int AS invite_count
      FROM participants p
      LEFT JOIN invites i
        ON i.contest_id = p.contest_id
        AND i.inviter_user_id = p.user_id
      WHERE p.contest_id = $1
      GROUP BY p.user_id, p.username, p.wallet_address
      ORDER BY invite_count DESC, p.joined_at ASC
      LIMIT $2
    `,
    [contestId, limit],
  );

  return result.rows;
}

async function getContestStats(contestId) {
  const result = await query(
    `
      SELECT
        c.*,
        COUNT(DISTINCT p.user_id)::int AS participant_count,
        COUNT(DISTINCT i.id)::int AS invite_count
      FROM contests c
      LEFT JOIN participants p ON p.contest_id = c.id
      LEFT JOIN invites i ON i.contest_id = c.id
      WHERE c.id = $1
      GROUP BY c.id
    `,
    [contestId],
  );

  return result.rows[0] || null;
}

async function close() {
  await pool.end();
}

module.exports = {
  close,
  completeExpiredContests,
  createContest,
  endActiveContest,
  getActiveContest,
  getContestStats,
  getInviteCount,
  getLeaderboard,
  getParticipant,
  getParticipantByInviteLink,
  initSchema,
  recordInvite,
  updateWallet,
  upsertParticipant,
};
