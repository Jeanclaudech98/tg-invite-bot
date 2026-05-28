const { Pool } = require("pg");
const config = require("./config");

const QUERY_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 5_000;

const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  query_timeout: QUERY_TIMEOUT_MS,
  statement_timeout: QUERY_TIMEOUT_MS,
});

pool.on("error", (error) => {
  logDatabaseError("pool_error", error);
});

/**
 * @typedef {import("pg").QueryResult} QueryResult
 * @typedef {import("pg").QueryResultRow} QueryResultRow
 */

/**
 * @param {string} event
 * @param {unknown} error
 * @param {Record<string, unknown>} [extra]
 */
function logDatabaseError(event, error, extra = {}) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    component: "database",
    event,
    error: message,
    ...extra,
  }));
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isConnectionFailure(error) {
  if (!error || typeof error !== "object") return false;

  const code = "code" in error ? String(error.code) : "";
  const message = "message" in error ? String(error.message).toLowerCase() : "";

  return [
    "08000",
    "08003",
    "08006",
    "57P01",
    "57P02",
    "57P03",
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EPIPE",
  ].includes(code) || message.includes("connection terminated") || message.includes("timeout");
}

/**
 * @template {QueryResultRow} T
 * @param {string} text
 * @param {unknown[]} [params]
 * @returns {Promise<QueryResult<T>>}
 */
async function query(text, params = []) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await pool.query({ text, values: params, query_timeout: QUERY_TIMEOUT_MS });
    } catch (error) {
      const retryable = attempt === 0 && isConnectionFailure(error);
      logDatabaseError("query_failed", error, { retryable });

      if (!retryable) {
        throw error;
      }
    }
  }

  throw new Error("Database query failed after retry");
}

async function assertReachable() {
  await query("SELECT 1");
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
      inviter_username TEXT,
      invited_user_id BIGINT NOT NULL,
      invited_username TEXT,
      invited_at TIMESTAMPTZ DEFAULT NOW()
    );

    ALTER TABLE invites
      ADD COLUMN IF NOT EXISTS inviter_username TEXT;

    CREATE UNIQUE INDEX IF NOT EXISTS invites_unique_invited_per_contest
      ON invites (contest_id, invited_user_id);

    CREATE INDEX IF NOT EXISTS participants_contest_user_idx
      ON participants (contest_id, user_id);

    CREATE INDEX IF NOT EXISTS participants_invite_link_idx
      ON participants (invite_link)
      WHERE invite_link IS NOT NULL;

    CREATE INDEX IF NOT EXISTS contests_active_ends_idx
      ON contests (ends_at, created_at DESC)
      WHERE status = 'active';

    CREATE INDEX IF NOT EXISTS invites_contest_inviter_idx
      ON invites (contest_id, inviter_user_id);

    CREATE INDEX IF NOT EXISTS invites_active_leaderboard_idx
      ON invites (contest_id, inviter_user_id, invited_at)
      WHERE inviter_user_id IS NOT NULL;
  `);
}

/**
 * @param {string} title
 * @param {number} durationHours
 */
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
  const result = await query(`
    WITH completed AS (
      UPDATE contests
      SET status = 'completed'
      WHERE status = 'active' AND ends_at <= NOW()
      RETURNING id
    )
    SELECT *
    FROM contests
    WHERE status = 'active' AND ends_at > NOW()
    ORDER BY created_at DESC
    LIMIT 1
  `);

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
  const result = await query(`
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
  `);

  return result.rows[0] || null;
}

/**
 * @param {number} contestId
 * @param {{ id: number, username?: string }} user
 * @param {string} inviteLink
 */
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

/**
 * @param {number} contestId
 * @param {number} userId
 */
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

/**
 * @param {string} inviteLink
 */
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

/**
 * @param {number} contestId
 * @param {number} userId
 * @param {string} walletAddress
 */
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

/**
 * @param {number} contestId
 * @param {number} inviterUserId
 * @param {string | null} inviterUsername
 * @param {{ id: number, username?: string }} invitedUser
 */
async function recordInvite(contestId, inviterUserId, inviterUsername, invitedUser) {
  const result = await query(
    `
      INSERT INTO invites (contest_id, inviter_user_id, inviter_username, invited_user_id, invited_username)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (contest_id, invited_user_id) DO NOTHING
      RETURNING *
    `,
    [contestId, inviterUserId, inviterUsername, invitedUser.id, invitedUser.username || null],
  );

  return result.rows[0] || null;
}

/**
 * @param {number} contestId
 * @param {number} userId
 */
async function getParticipantWithInviteCount(contestId, userId) {
  const result = await query(
    `
      SELECT
        p.*,
        COUNT(i.id)::int AS invite_count
      FROM participants p
      LEFT JOIN invites i
        ON i.contest_id = p.contest_id
        AND i.inviter_user_id = p.user_id
      WHERE p.contest_id = $1 AND p.user_id = $2
      GROUP BY p.id
      LIMIT 1
    `,
    [contestId, userId],
  );

  return result.rows[0] || null;
}

/**
 * @param {number} contestId
 * @param {number} limit
 */
async function getLeaderboard(contestId, limit = 10) {
  const result = await query(
    `
      SELECT
        p.user_id,
        p.username,
        p.wallet_address,
        COALESCE(invite_counts.invite_count, 0)::int AS invite_count
      FROM participants p
      LEFT JOIN (
        SELECT inviter_user_id, COUNT(*)::int AS invite_count
        FROM invites
        WHERE contest_id = $1
        GROUP BY inviter_user_id
      ) invite_counts ON invite_counts.inviter_user_id = p.user_id
      WHERE p.contest_id = $1
      ORDER BY invite_count DESC, p.joined_at ASC
      LIMIT $2
    `,
    [contestId, limit],
  );

  return result.rows;
}

/**
 * @param {number} contestId
 */
async function getContestStats(contestId) {
  const result = await query(
    `
      SELECT
        c.*,
        COALESCE(participants.participant_count, 0)::int AS participant_count,
        COALESCE(invites.invite_count, 0)::int AS invite_count
      FROM contests c
      LEFT JOIN (
        SELECT contest_id, COUNT(*)::int AS participant_count
        FROM participants
        WHERE contest_id = $1
        GROUP BY contest_id
      ) participants ON participants.contest_id = c.id
      LEFT JOIN (
        SELECT contest_id, COUNT(*)::int AS invite_count
        FROM invites
        WHERE contest_id = $1
        GROUP BY contest_id
      ) invites ON invites.contest_id = c.id
      WHERE c.id = $1
    `,
    [contestId],
  );

  return result.rows[0] || null;
}

/**
 * @param {number} [timeoutMs]
 */
async function close(timeoutMs = CLOSE_TIMEOUT_MS) {
  await Promise.race([
    pool.end(),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Timed out closing database pool after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

module.exports = {
  assertReachable,
  close,
  completeExpiredContests,
  createContest,
  endActiveContest,
  getActiveContest,
  getContestStats,
  getLeaderboard,
  getParticipant,
  getParticipantByInviteLink,
  getParticipantWithInviteCount,
  initSchema,
  recordInvite,
  updateWallet,
  upsertParticipant,
};
