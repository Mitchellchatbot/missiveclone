const { query } = require('../db');

// Re-link messages orphaned by a previous connection of this mailbox. When a
// mailbox is disconnected its messages keep their rows but get account_id =
// NULL (ON DELETE SET NULL), and the per-user inbox filters need a non-null
// account_id — so reconnecting would otherwise show an empty inbox until a full
// re-sync re-imported everything.
//
// Relinks at most ONE row per (workspace_id, direction, message_id), and skips
// keys this account already holds. Orphans can include several copies of one
// email (legacy duplicate rows, or the same message stored for two mailboxes
// that were both disconnected), and relinking them all onto one account would
// recreate the duplicate rows that uq_messages_acct_dir_msgid forbids — once
// that index exists, a 23505 here. Rows with no Message-ID (NULL or '') have no
// dedup identity and relink unconditionally, as before; they are kept out of the
// DISTINCT ON because it treats every NULL key as one group.
//
// It must not overlap a sync walk of the same account. The NOT EXISTS below
// reads the statement's snapshot, so a copy the walk is inserting right now is
// invisible to it (and the walk's own dedup only looks at this account's rows,
// not orphans): together they would store the key twice — or, once the index
// exists, one 23505 would abort the whole UPDATE and relink nothing. So wait
// for the running walk first (only a re-auth of an existing mailbox can have
// one; a new account id never does), and if a walk still slips in between, a
// 23505 is retried once — by then the conflicting row is committed and the
// NOT EXISTS skips that key.
const WALK_WAIT_MS = 30_000;

// Best-effort by design: relinking is a convenience, and a failure here must
// not 500 the OAuth callback or add-account request before the initial sync is
// kicked off. Returns the number of rows relinked, or null if it failed or a
// walk was still running after waitMs (both logged). Never throws. A caller
// that doesn't await it (the OAuth callback) can afford a much longer waitMs.
async function relinkOrphanMessages(accountId, workspaceId, email, { waitMs = WALK_WAIT_MS } = {}) {
  // Lazy: imap.js pulls in the whole sync stack.
  const { waitForIdle } = require('../email/imap');
  if (!(await waitForIdle(accountId, waitMs))) {
    console.warn(`[relink] skipped for ${email} (${accountId}): a sync walk is still running — retry via /relink-orphans`);
    return null;
  }
  for (let attempt = 1; ; attempt++) {
    try {
      return await relinkOnce(accountId, workspaceId, email);
    } catch (e) {
      if (e && e.code === '23505' && attempt === 1) continue;
      console.warn(`[relink] orphan relink failed for ${email} (${accountId}): ${e.message}`);
      return null;
    }
  }
}

async function relinkOnce(accountId, workspaceId, email) {
  const r = await query(
    `UPDATE messages m SET account_id = $1
      WHERE m.workspace_id = $2 AND m.account_id IS NULL
        AND (m.to_addrs ILIKE $3 OR m.from_addr ILIKE $3 OR m.cc_addrs ILIKE $3)
        AND (
          NULLIF(m.message_id, '') IS NULL
          OR (
            m.id IN (
              SELECT DISTINCT ON (x.workspace_id, x.direction, x.message_id) x.id
                FROM messages x
               WHERE x.workspace_id = $2 AND x.account_id IS NULL
                 AND NULLIF(x.message_id, '') IS NOT NULL
                 AND (x.to_addrs ILIKE $3 OR x.from_addr ILIKE $3 OR x.cc_addrs ILIKE $3)
               ORDER BY x.workspace_id, x.direction, x.message_id, x.sent_at, x.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM messages y
               WHERE y.account_id = $1
                 AND y.direction = m.direction
                 AND y.message_id = m.message_id
            )
          )
        )`,
    [accountId, workspaceId, `%${email}%`]
  );
  return r.rowCount || 0;
}

module.exports = { relinkOrphanMessages };
