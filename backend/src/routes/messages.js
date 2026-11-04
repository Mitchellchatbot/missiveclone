const express = require('express');
const { one, many, isSchemaReady } = require('../db');
const { requireAuth } = require('../auth');
const wrap = require('../util/wrap');

const router = express.Router();
router.use(requireAuth);

// GET /api/messages — one account's messages as a metadata feed, for consumers
// that reconcile against it (DD's assistant) instead of trusting live events.
//
// Query:
//   account_id       required; must belong to the caller's workspace (else 404).
//   order            'created' (default): keyset on (created_at, id), the ingest
//                    time — the append feed, new rows only.
//                    'changed': keyset on (COALESCE(signals_updated_at,
//                    created_at), id) — new rows AND rows whose read signals,
//                    folder, sender or removal changed since (an update never
//                    moves created_at, so the append feed can't show those: a
//                    read/flag change, a Junk → Inbox rescue, a removal).
//                    Consumers upsert by id.
//   since            ISO 8601 with Z or an offset; inclusive. Optional.
//   cursor           next_cursor of a previous page (opaque; overrides since).
//   direction        'inbound' | 'outbound'.
//   include_removed  'true' (default) | 'false'.
//   limit            1..200, default 100; larger values are capped.
// Bad values answer 400.
//
// Response: { messages, next_cursor, has_more, settled_through }.
//   next_cursor is never null — the last row's position, or the position the
//   request started from when the page is empty — so a tailing client always
//   has somewhere to resume. settled_through is the settle horizon below.
//
// HOW TO CONSUME IT — this differs from the CL1 contract draft
// ({ messages, next_cursor: string | null }), so build clients from this text:
//   - Page while has_more is true. has_more = false is the end of the data
//     available now. Then keep next_cursor and poll again later from it.
//   - Never loop on the cursor itself: next_cursor is never null, so a client
//     written as `while (next_cursor) fetch(next_cursor)` never stops — an empty
//     page with the same cursor, forever, against production.
//   - Rows appear about FEED_SETTLE_MS (120s) after they are stamped, not at
//     once: `since` is inclusive but only up to settled_through.
//   - The default order=created shows each row once, when it is new. To see
//     later changes (read/flag/category edits, a relabel, a removal), also
//     follow order=changed and upsert by id.
//
// Rows are metadata only: no bodies, no snippet. Every time is BIGINT epoch-ms,
// which pg returns as a digit string (like sent_at and created_at elsewhere).
// removed_at / removed_reason mean "left the folders this clone syncs" — deleted
// or moved to an unsynced folder; Graph's per-folder delta doesn't tell those
// apart. graph_id NULL means presence was never verified by a walk that stores
// graph ids (rows stored before they existed). Mail backfilled from an extra
// folder carries its original (old) sent_at.
//
// THE SETTLE HORIZON. created_at (and signals_updated_at) are stamped in JS
// before the row's transaction commits, and the commit can lag: ingest waits up
// to 5s for its lock plus its statement, compose/reply/scheduled up to 20s for
// the lock, 30s of statement, then a plain-transaction fallback. A row with a
// later stamp can commit first; a client that read it and moved its cursor past
// would never see the slower row (typically an outbound reply with attachments
// — exactly the "answered" signal). So the feed only returns rows stamped at
// least FEED_SETTLE_MS ago, and next_cursor never passes a row that may still
// commit. Poll with that lag in mind.
const FEED_DEFAULT_LIMIT = 100;
// Rows cross an ocean between this service and its database; a few hundred
// metadata rows already hold a pool slot for a long time.
const FEED_MAX_LIMIT = 200;
const FEED_SETTLE_MS_DEFAULT = 120_000;

function feedSettleMs() {
  const v = Number(process.env.FEED_SETTLE_MS);
  return Number.isFinite(v) && v >= 0 ? v : FEED_SETTLE_MS_DEFAULT;
}

const FEED_COLUMNS = `m.id, m.thread_id, m.account_id, m.direction, m.folder, m.message_id,
  m.in_reply_to, m.from_addr, m.to_addrs, m.cc_addrs, m.subject, m.sent_at, m.created_at,
  m.has_attachments, m.graph_id, m.web_link, m.is_read, m.importance, m.flag_status,
  m.categories, m.parent_folder_id, m.inference_classification, m.change_key,
  m.removed_at, m.removed_reason, m.signals_updated_at`;

// ISO 8601 date-time with an explicit zone. A zoneless date-time would parse as
// server-local time, and a bare date is ambiguous about the day boundary.
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/i;
const CURSOR_RE = /^[A-Za-z0-9_-]{1,256}$/;
// "<epoch ms>|<message id>". The id may be empty: that is a `since` position
// (every real id sorts after '').
const POSITION_RE = /^(\d{1,16})\|([A-Za-z0-9-]{0,64})$/;
// The changed-order cursor is tagged, so a cursor can't be replayed in the other
// order (both are epoch-ms positions; mixing them would silently skip rows).
const CHANGED_TAG = 'u:';

function encodeCursor(order, ms, id) {
  const raw = `${order === 'changed' ? CHANGED_TAG : ''}${ms}|${id}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

function decodeCursor(order, s) {
  if (typeof s !== 'string' || !CURSOR_RE.test(s)) return null;
  const raw = Buffer.from(s, 'base64url').toString('utf8');
  // Node's base64url decoder skips characters it doesn't know; only accept a
  // cursor that is exactly what encodeCursor would have produced.
  if (Buffer.from(raw, 'utf8').toString('base64url') !== s) return null;
  let body = raw;
  if (order === 'changed') {
    if (!raw.startsWith(CHANGED_TAG)) return null;
    body = raw.slice(CHANGED_TAG.length);
  } else if (raw.startsWith(CHANGED_TAG)) {
    return null;
  }
  const m = POSITION_RE.exec(body);
  if (!m) return null;
  const ms = Number(m[1]);
  return Number.isSafeInteger(ms) ? { ms, id: m[2] } : null;
}

router.get('/', wrap(async (req, res) => {
  const q = req.query;
  const bad = (error) => res.status(400).json({ error });

  if (typeof q.account_id !== 'string' || !q.account_id) return bad('account_id is required');
  const order = q.order === undefined ? 'created' : q.order;
  if (order !== 'created' && order !== 'changed') return bad("order must be 'created' or 'changed'");
  if (q.direction !== undefined && q.direction !== 'inbound' && q.direction !== 'outbound') {
    return bad("direction must be 'inbound' or 'outbound'");
  }
  if (q.include_removed !== undefined && q.include_removed !== 'true' && q.include_removed !== 'false') {
    return bad("include_removed must be 'true' or 'false'");
  }
  const includeRemoved = q.include_removed !== 'false';
  let limit = FEED_DEFAULT_LIMIT;
  if (q.limit !== undefined) {
    if (typeof q.limit !== 'string' || !/^\d{1,9}$/.test(q.limit) || Number(q.limit) < 1) {
      return bad('limit must be a positive integer');
    }
    limit = Math.min(FEED_MAX_LIMIT, Number(q.limit));
  }
  let sinceMs = null;
  if (q.since !== undefined) {
    const t = typeof q.since === 'string' && ISO_RE.test(q.since) ? Date.parse(q.since) : NaN;
    if (!Number.isFinite(t) || t < 0) return bad('since must be an ISO 8601 date-time with Z or an offset');
    sinceMs = t;
  }
  let after = null;
  if (q.cursor !== undefined) {
    after = decodeCursor(order, q.cursor);
    if (!after) return bad('cursor is malformed (or belongs to the other order)');
  }
  // A cursor carries its own position and wins over since.
  if (!after) after = { ms: sinceMs != null ? sinceMs : 0, id: '' };

  // The feed reads columns the boot adds; until init has confirmed them, a query
  // would only fail with "column does not exist".
  if (!isSchemaReady()) return res.status(503).json({ error: 'database not ready yet; retry shortly' });

  const acc = await one(
    'SELECT id FROM email_accounts WHERE id = $1 AND workspace_id = $2',
    [q.account_id, req.user.workspace_id]
  );
  if (!acc) return res.status(404).json({ error: 'not found' });

  const horizon = Date.now() - feedSettleMs();
  // The position expression must match the feed indexes exactly
  // (scripts/create_message_feed_index.sql) for them to be used.
  const pos = order === 'changed' ? 'COALESCE(m.signals_updated_at, m.created_at)' : 'm.created_at';
  const params = [acc.id, String(after.ms), after.id, String(horizon)];
  let where = `m.account_id = $1 AND (${pos}, m.id) > ($2::bigint, $3::text) AND ${pos} <= $4::bigint`;
  if (q.direction) {
    params.push(q.direction);
    where += ` AND m.direction = $${params.length}`;
  }
  if (!includeRemoved) where += ' AND m.removed_at IS NULL';
  params.push(limit + 1);
  const rows = await many(
    `SELECT ${FEED_COLUMNS} FROM messages m
      WHERE ${where}
      ORDER BY ${pos}, m.id
      LIMIT $${params.length}`,
    params
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const next = last
    ? { ms: order === 'changed' ? (last.signals_updated_at != null ? last.signals_updated_at : last.created_at) : last.created_at, id: last.id }
    : after;
  res.json({
    messages: page,
    next_cursor: encodeCursor(order, next.ms, next.id),
    has_more: hasMore,
    settled_through: String(horizon)
  });
}));

// GET /api/messages/:id/body — the HTML/text body of a single message.
//
// Split out from GET /api/threads/:id so the thread-detail response can defer
// non-latest bodies (?defer_bodies=1) and clients fetch each one on demand when
// the user expands that message. Workspace-scoped exactly like the attachment
// route: the service token is workspace-wide, so the id is filtered by
// req.user.workspace_id. The DD proxy layers the per-user thread-visibility
// check on top before ever calling this.
router.get('/:id/body', wrap(async (req, res) => {
  const m = await one(
    'SELECT id, body_html, body_text FROM messages WHERE id = $1 AND workspace_id = $2',
    [req.params.id, req.user.workspace_id]
  );
  if (!m) return res.status(404).json({ error: 'not found' });
  res.json({ id: m.id, body_html: m.body_html, body_text: m.body_text });
}));

module.exports = router;
