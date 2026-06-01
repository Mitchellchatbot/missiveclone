const express = require('express');
const { v4: uuid } = require('uuid');
const { one, many, query } = require('../db');
const { requireAuth } = require('../auth');
const { emitToWorkspace } = require('../sockets');
const wrap = require('../util/wrap');

const router = express.Router();
router.use(requireAuth);

router.get('/', wrap(async (req, res) => {
  const rows = await many(
    'SELECT id, name, color, created_at FROM labels WHERE workspace_id = $1 ORDER BY name',
    [req.user.workspace_id]
  );
  res.json({ labels: rows });
}));

router.post('/', wrap(async (req, res) => {
  const { name, color } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
  const id = uuid();
  await query(
    'INSERT INTO labels (id, workspace_id, name, color, created_at) VALUES ($1, $2, $3, $4, $5)',
    [id, req.user.workspace_id, name.trim(), color || '#2f6feb', Date.now()]
  );
  res.json({ id });
}));

router.patch('/:id', wrap(async (req, res) => {
  const { name, color } = req.body || {};
  const l = await one(
    'SELECT id FROM labels WHERE id = $1 AND workspace_id = $2',
    [req.params.id, req.user.workspace_id]
  );
  if (!l) return res.status(404).json({ error: 'not found' });
  const sets = [];
  const params = [];
  if (name) { params.push(name.trim()); sets.push(`name = $${params.length}`); }
  if (color) { params.push(color); sets.push(`color = $${params.length}`); }
  if (sets.length) {
    params.push(l.id);
    await query(`UPDATE labels SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
  }
  res.json({ ok: true });
}));

router.delete('/:id', wrap(async (req, res) => {
  const l = await one(
    'SELECT id FROM labels WHERE id = $1 AND workspace_id = $2',
    [req.params.id, req.user.workspace_id]
  );
  if (!l) return res.status(404).json({ error: 'not found' });
  await query('DELETE FROM labels WHERE id = $1', [l.id]);
  res.json({ ok: true });
}));

// Apply / remove on a thread.
router.post('/apply', wrap(async (req, res) => {
  const { thread_id, label_id } = req.body || {};
  const t = await one('SELECT id FROM threads WHERE id = $1 AND workspace_id = $2', [thread_id, req.user.workspace_id]);
  const l = await one('SELECT id FROM labels WHERE id = $1 AND workspace_id = $2', [label_id, req.user.workspace_id]);
  if (!t || !l) return res.status(404).json({ error: 'not found' });
  await query(
    'INSERT INTO thread_labels (thread_id, label_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [t.id, l.id]
  );
  emitToWorkspace(req.user.workspace_id, 'thread:updated', { thread_id: t.id });
  res.json({ ok: true });
}));

router.post('/remove', wrap(async (req, res) => {
  const { thread_id, label_id } = req.body || {};
  const t = await one('SELECT id FROM threads WHERE id = $1 AND workspace_id = $2', [thread_id, req.user.workspace_id]);
  if (!t) return res.status(404).json({ error: 'not found' });
  await query('DELETE FROM thread_labels WHERE thread_id = $1 AND label_id = $2', [t.id, label_id]);
  emitToWorkspace(req.user.workspace_id, 'thread:updated', { thread_id: t.id });
  res.json({ ok: true });
}));

// One-shot backfill: ensure a label per client and apply it to every
// thread whose messages reference that client by any of:
//   - one of the client's contact emails (exact substring)
//   - an address ending in @<client domain>
//   - the contact's display name appearing in from/to/cc as a whole word
//     (matches "John Smith <jsmith@gmail.com>" even when the email
//     doesn't match the client's known domain)
// Cursor-paginated so each call stays inside the 15s per-statement
// timeout — the driver script loops until done.
//
// Body: {
//   clients: [{ name, emails: string[], domains: string[], owner_names: string[] }],
//   cursor?: string,       // last thread id processed
//   limit?: number,        // threads per batch (default 400, max 2000)
//   dry_run?: boolean      // when true, count matches but don't INSERT
// }
//
// Returns: { done, next_cursor, batch_size, labels_created, applied }
router.post('/backfill-clients', wrap(async (req, res) => {
  const { clients, cursor, limit, dry_run } = req.body || {};
  if (!Array.isArray(clients) || clients.length === 0) {
    return res.status(400).json({ error: 'clients[] required' });
  }
  const wsId = req.user.workspace_id;
  const batchSize = Math.min(2000, Math.max(50, Number(limit) || 400));
  const isDry = dry_run === true;

  // 1) Ensure one label per client (idempotent). Match by case-insensitive
  //    name within the workspace so we don't create duplicates if the
  //    operator already hand-made a label with the same name.
  let labelsCreated = 0;
  const prepared = []; // { name, labelId, regex }
  for (const c of clients) {
    if (!c || typeof c.name !== 'string' || !c.name.trim()) continue;
    const name = c.name.trim();
    const emails = Array.isArray(c.emails)
      ? c.emails.map((e) => String(e).trim().toLowerCase()).filter(Boolean)
      : [];
    const domains = Array.isArray(c.domains)
      ? c.domains.map((d) => String(d).trim().toLowerCase()).filter(Boolean)
      : [];
    // Owner names like "John Smith" — only useful when they're at least
    // two characters and contain a letter; single tokens like "Mike" are
    // accepted but log a high false-positive risk. Trimmed lower so the
    // regex stays case-insensitive via ~*.
    const ownerNames = Array.isArray(c.owner_names)
      ? c.owner_names
          .map((n) => String(n).trim())
          .filter((n) => n.length >= 2 && /[A-Za-z]/.test(n))
      : [];
    if (emails.length === 0 && domains.length === 0 && ownerNames.length === 0) continue;

    let row = await one(
      'SELECT id FROM labels WHERE workspace_id = $1 AND lower(name) = lower($2) LIMIT 1',
      [wsId, name]
    );
    if (!row && !isDry) {
      const id = uuid();
      await query(
        'INSERT INTO labels (id, workspace_id, name, color, created_at) VALUES ($1, $2, $3, $4, $5)',
        [id, wsId, name, '#2563eb', Date.now()]
      );
      row = { id };
      labelsCreated += 1;
    }
    const regex = buildClientRegex(emails, domains, ownerNames);
    if (!regex) continue;
    prepared.push({ name, labelId: row ? row.id : null, regex });
  }

  // 2) Pick the next batch of threads (ordered by id for stable cursor).
  const batchParams = [wsId];
  let batchSql = 'SELECT id FROM threads WHERE workspace_id = $1';
  if (cursor) {
    batchParams.push(cursor);
    batchSql += ` AND id > $${batchParams.length}`;
  }
  batchParams.push(batchSize);
  batchSql += ` ORDER BY id ASC LIMIT $${batchParams.length}`;
  const threadRows = await many(batchSql, batchParams);
  if (threadRows.length === 0) {
    return res.json({
      done: true, next_cursor: null,
      batch_size: 0, labels_created: labelsCreated, applied: 0
    });
  }
  const threadIds = threadRows.map((r) => r.id);

  // 3) For each client, INSERT every (thread_id, label_id) where any of
  //    the thread's messages has from/to/cc matching the regex.
  const matchClause = `
    FROM messages m
    WHERE m.workspace_id = $1
      AND m.thread_id = ANY($2::text[])
      AND (
        m.from_addr ~* $3
        OR coalesce(m.to_addrs, '') ~* $3
        OR coalesce(m.cc_addrs, '') ~* $3
      )
  `;
  let totalApplied = 0;
  for (const { labelId, regex } of prepared) {
    if (isDry) {
      const r = await one(
        `SELECT count(DISTINCT m.thread_id)::int AS n ${matchClause}`,
        [wsId, threadIds, regex]
      );
      totalApplied += (r && r.n) || 0;
    } else {
      const r = await query(
        `INSERT INTO thread_labels (thread_id, label_id)
         SELECT DISTINCT m.thread_id, $4::text ${matchClause}
         ON CONFLICT DO NOTHING`,
        [wsId, threadIds, regex, labelId]
      );
      totalApplied += r.rowCount || 0;
    }
  }

  const nextCursor = threadIds[threadIds.length - 1];
  const done = threadIds.length < batchSize;
  res.json({
    done,
    next_cursor: done ? null : nextCursor,
    batch_size: threadIds.length,
    labels_created: labelsCreated,
    applied: totalApplied
  });
}));

// Build a single Postgres-flavored regex that fires when any of:
//   - one of the client's exact contact emails appears as a substring, OR
//   - "@<domain>" appears immediately followed by a non-domain-character
//     (so example.com doesn't bleed into example.com.au), OR
//   - one of the owner names appears as a whole word (\y ... \y) so
//     'John Smith <addr@gmail.com>' still labels even when @gmail.com
//     isn't in the client's domain list.
function buildClientRegex(emails, domains, ownerNames = []) {
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = [];
  for (const e of emails) parts.push(escape(e));
  for (const d of domains) parts.push(`@${escape(d)}(?:[^A-Za-z0-9.-]|$)`);
  for (const n of ownerNames) parts.push(`\\y${escape(n)}\\y`);
  return parts.length > 0 ? `(?:${parts.join('|')})` : null;
}

module.exports = router;
