// The Idempotency-Key protocol for the mutating CL2 routes: (token jti, route,
// key) -> the stored response, so a retried request is answered from the record
// instead of running twice, and the same key with a different request is
// refused (422).
//
//   withIdempotency(req, res, { route, isSend, describe? }, run)
//     run() resolves to { status, body, retryAfterSec?, store }
//     describe() (optional) resolves to the registry status of the draft the
//       request names, for the answer to a key that is still in progress
//     resolves to the response the route sends: { status, body, retryAfterSec?, headers? }
//
// It never writes to res itself: routes/outlook_drafts.js sends whatever it
// resolves to, in one place, for a fresh run and a replay alike.
//
// The send route is special: its claim is written with a provisional "in
// progress" answer, every outcome is kept, and a run that throws leaves the
// claim in place. A send key can therefore never run twice, even across a crash
// between the claim and the end of the send.
const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const db = require('../db');

const TTL_MS = 7 * 24 * 60 * 60 * 1000;
// A non-send key in progress for longer than this belongs to a request that
// never finished (a crash, a lost connection); the next request with that key
// takes it over.
const STALE_MS = 5 * 60 * 1000;
const PROVISIONAL_SEND = {
  status: 409,
  body: {
    error: 'already_sending',
    detail: 'a send with this Idempotency-Key is in progress or ended without a recorded outcome; read the draft',
    draftStatus: 'sending'
  }
};
const REPLAY = { 'Idempotent-Replay': 'true' };

function sha256hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

// JSON with object keys sorted at every level (arrays keep their order), so two
// requests that differ only in key order hash the same.
function stableJson(v) {
  if (v === undefined || v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
}

function requestHashOf(req, route) {
  return sha256hex(stableJson({ m: req.method, r: route, p: { ...(req.params || {}) }, b: req.body === undefined ? null : req.body }));
}

function errLabel(e) {
  const s = String((e && (e.code || e.name)) || 'error');
  return /^[A-Za-z0-9_.:-]{1,60}$/.test(s) ? s : 'error';
}

async function inProgress(describe) {
  let draftStatus = null;
  if (describe) {
    try { draftStatus = await describe(); } catch { draftStatus = null; }
  }
  const body = { error: 'throttled', detail: 'a request with this Idempotency-Key is in progress' };
  if (draftStatus) body.draftStatus = draftStatus;
  return { status: 429, body, retryAfterSec: 2 };
}

function replay(row) {
  const out = { status: Number(row.response_status), body: row.response_body, headers: REPLAY };
  if (row.retry_after_sec != null) out.retryAfterSec = Number(row.retry_after_sec);
  return out;
}

async function withIdempotency(req, _res, { route, isSend = false, describe } = {}, run) {
  const jti = req.auth && req.auth.jti;
  const key = req.get('Idempotency-Key');
  if (!jti || !key) {
    return { status: 400, body: { error: 'bad_request', detail: 'Idempotency-Key: header required' } };
  }
  const pk = [jti, route, key];
  const requestHash = requestHashOf(req, route);

  // Runs the handler as the owner of claim `mine`, then keeps or releases the
  // record. Completion is fenced on the claim token: an owner whose stale claim
  // was taken over still answers its caller, but its outcome is not stored.
  async function runAsOwner(mine) {
    let out;
    try {
      out = await run();
    } catch (e) {
      // A send that threw keeps its provisional record: whether it sent is not
      // known here, and the key must not run again.
      if (!isSend) {
        await db.query('DELETE FROM idempotency_keys WHERE jti = $1 AND route = $2 AND idem_key = $3 AND claim_token = $4', [...pk, mine])
          .catch((e2) => console.error(`[idempotency] release failed ${route} ${errLabel(e2)}`));
      }
      throw e;
    }
    const response = { status: out.status, body: out.body };
    if (out.retryAfterSec != null) response.retryAfterSec = out.retryAfterSec;
    try {
      if (isSend || out.store) {
        const u = await db.query(
          `UPDATE idempotency_keys SET status = 'completed', response_status = $5, response_body = $6::jsonb,
                  retry_after_sec = $7, updated_at = $8
            WHERE jti = $1 AND route = $2 AND idem_key = $3 AND claim_token = $4`,
          [...pk, mine, out.status, JSON.stringify(out.body === undefined ? null : out.body),
            out.retryAfterSec != null ? Math.ceil(Number(out.retryAfterSec)) : null, Date.now()]);
        if (!u.rowCount) console.warn(`[idempotency] lost claim ${route}`);
      } else {
        await db.query('DELETE FROM idempotency_keys WHERE jti = $1 AND route = $2 AND idem_key = $3 AND claim_token = $4', [...pk, mine]);
      }
    } catch (e) {
      // The caller still gets the outcome. An unstored non-send claim is taken
      // over after STALE_MS; an unstored send keeps its provisional answer.
      console.error(`[idempotency] record failed ${route} ${errLabel(e)}`);
    }
    return response;
  }

  for (let attempt = 0; attempt < 4; attempt++) {
    const now = Date.now();
    const mine = uuid();
    const claimed = await db.one(
      `INSERT INTO idempotency_keys (jti, route, idem_key, request_hash, status, claim_token,
                                     response_status, response_body, created_at, updated_at, expires_at)
       VALUES ($1, $2, $3, $4, 'in_progress', $5, $6, $7::jsonb, $8, $8, $9)
       ON CONFLICT (jti, route, idem_key) DO NOTHING RETURNING claim_token`,
      [...pk, requestHash, mine, isSend ? PROVISIONAL_SEND.status : null,
        isSend ? JSON.stringify(PROVISIONAL_SEND.body) : null, now, now + TTL_MS]);
    if (claimed) return runAsOwner(mine);

    const row = await db.one('SELECT * FROM idempotency_keys WHERE jti = $1 AND route = $2 AND idem_key = $3', pk);
    if (!row) continue; // released between the two statements: claim again
    if (Number(row.expires_at) <= now) {
      // Past its 7 days and not purged yet: the key is free again.
      await db.query('DELETE FROM idempotency_keys WHERE jti = $1 AND route = $2 AND idem_key = $3 AND claim_token = $4',
        [...pk, row.claim_token]);
      continue;
    }
    if (row.request_hash !== requestHash) {
      return { status: 422, body: { error: 'idempotency_mismatch', detail: 'this Idempotency-Key was used for a different request' } };
    }
    if (row.status === 'completed') return replay(row);
    if (isSend) {
      // Never run a send key twice: answer with the provisional record.
      return row.response_status != null ? replay(row) : { ...PROVISIONAL_SEND, headers: REPLAY };
    }
    if (now - Number(row.updated_at) < STALE_MS) return inProgress(describe);
    const taken = await db.query(
      `UPDATE idempotency_keys SET claim_token = $4, updated_at = $5
        WHERE jti = $1 AND route = $2 AND idem_key = $3 AND claim_token = $6 AND status = 'in_progress'`,
      [...pk, mine, now, row.claim_token]);
    if (taken.rowCount === 1) return runAsOwner(mine);
    // Someone else took it over or finished it: read it again.
  }
  return inProgress(describe);
}

module.exports = { withIdempotency, stableJson };
