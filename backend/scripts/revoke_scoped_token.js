// Revokes an account-scoped API token (see mint_scoped_token.js), or lists the
// minted ones.
//
//   node backend/scripts/revoke_scoped_token.js --jti <jti> [--reason "<text>"]
//   node backend/scripts/revoke_scoped_token.js --list [--workspace <workspace_id>]
//
// Env: DATABASE_URL (required), DB_SCHEMA (default missive), DATABASE_SSL (read
// as the server reads it). Only the process environment is read, never a .env
// file.
//
// Revoking sets scoped_tokens.revoked_at. Every server instance re-reads a
// token's row at least once a minute, so the token is refused everywhere within
// 60 s. The list shows each token's jti, service user, scopes, accounts, label
// and times; tokens themselves are never stored, so they can never be shown.
// Output goes to stderr.
//
// Revoking every token at once, including the ones without a scope claim, is
// still done by rotating JWT_SECRET.
//
// Exit codes: 0 revoked, already revoked, or listed; 2 unknown jti, refused or
// usage error; 1 unexpected error. It never loads src/index.js and never runs
// db.init().
const { Client } = require('pg');

const USAGE = [
  'usage:',
  '  node backend/scripts/revoke_scoped_token.js --jti <jti> [--reason "<text>"]',
  '  node backend/scripts/revoke_scoped_token.js --list [--workspace <workspace_id>]',
  '',
  'env: DATABASE_URL (required); DB_SCHEMA (default missive); DATABASE_SSL'
].join('\n');

const MAX_REASON = 200;

// A refusal: printed as is, exit 2, nothing written.
class Refusal extends Error {}

const say = (line) => process.stderr.write(`${line}\n`);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
// For echoing an operator's input back in a message: printable ASCII, short.
const shown = (v) => JSON.stringify(String(v).slice(0, 80).replace(/[^\x20-\x7e]/g, '?'));
const iso = (ms) => (ms === null || ms === undefined ? '-' : new Date(Number(ms)).toISOString());

const FLAGS = { jti: 'value', reason: 'value', list: 'bool', workspace: 'value', help: 'bool' };

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    let flag = argv[i];
    let value;
    const eq = flag.indexOf('=');
    if (flag.startsWith('--') && eq > 2) { value = flag.slice(eq + 1); flag = flag.slice(0, eq); }
    const name = flag.startsWith('--') ? flag.slice(2) : null;
    if (!name || !hasOwn(FLAGS, name)) {
      throw new Refusal(`unknown argument ${flag.startsWith('--') ? shown(flag) : '(a value without a flag)'}\n${USAGE}`);
    }
    if (hasOwn(out, name)) throw new Refusal(`--${name} given twice`);
    if (FLAGS[name] === 'bool') {
      if (value !== undefined) throw new Refusal(`--${name} takes no value`);
      out[name] = true;
    } else {
      if (value === undefined) {
        value = argv[i + 1];
        i += 1;
      }
      if (value === undefined) throw new Refusal(`--${name} needs a value\n${USAGE}`);
      out[name] = value;
    }
  }
  return out;
}

function parseReason(v) {
  if (v === undefined) return null;
  const s = String(v);
  if ([...s].length > MAX_REASON) throw new Refusal(`--reason: at most ${MAX_REASON} characters`);
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(s)) throw new Refusal('--reason: printable characters only (no control characters or line breaks)');
  return s.trim() ? s : null;
}

// The server's DATABASE_SSL rule (src/db.js).
function sslOption() {
  const flag = (process.env.DATABASE_SSL || '').toLowerCase();
  if (flag === 'true') return { rejectUnauthorized: false };
  if (flag === 'false') return false;
  return process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false;
}

const SCHEMA = process.env.DB_SCHEMA || 'missive';
const QS = `"${SCHEMA.replace(/"/g, '""')}"`;
// Every table is named with its schema, so the statements don't depend on the
// connection's search_path (a transaction-mode pooler may not keep it).
const T = (name) => `${QS}.${name}`;

async function connect() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: sslOption(),
    connectionTimeoutMillis: 10000
  });
  client.on('error', () => { /* a dropped connection fails the query in flight */ });
  await client.connect();
  await client.query(`SET search_path TO ${QS}, public`);
  await client.query(`SET statement_timeout = '15s'`);
  await client.query(`SET lock_timeout = '5s'`);
  return client;
}

async function requireRegistry(client) {
  const { rows } = await client.query('SELECT to_regclass($1) IS NOT NULL AS present', [T('scoped_tokens')]);
  if (!rows[0].present) throw new Refusal('CL2 schema not ready: deploy CL2 and check /api/status cl2.ready');
}

async function revoke(client, jti, reason) {
  const now = Date.now();
  const upd = await client.query(
    `UPDATE ${T('scoped_tokens')} SET revoked_at = $2, revoked_reason = $3
      WHERE jti = $1 AND revoked_at IS NULL`,
    [jti, now, reason]
  );
  if (upd.rowCount === 1) {
    say(`revoked jti=${jti}; effective on every instance within 60 s`);
    return 0;
  }
  const { rows } = await client.query(`SELECT revoked_at FROM ${T('scoped_tokens')} WHERE jti = $1`, [jti]);
  if (rows.length) {
    say(`already revoked at ${iso(rows[0].revoked_at)}`);
    return 0;
  }
  say('unknown jti');
  return 2;
}

async function list(client, ws) {
  const { rows } = await client.query(
    `SELECT t.jti, u.email, t.scopes, t.accounts, t.label, t.created_at, t.expires_at,
            t.revoked_at, t.revoked_reason
       FROM ${T('scoped_tokens')} t
       LEFT JOIN ${T('users')} u ON u.id = t.user_id
      WHERE $1::text IS NULL OR t.workspace_id = $1
      ORDER BY t.created_at, t.jti`,
    [ws]
  );
  const table = [['jti', 'user', 'scopes', 'accounts', 'label', 'created', 'expires', 'revoked'],
    ...rows.map((r) => [
      r.jti,
      r.email || '(user removed)',
      (r.scopes || []).join(','),
      (r.accounts || []).join(','),
      r.label || '-',
      iso(r.created_at),
      iso(r.expires_at),
      r.revoked_at === null ? 'no' : `${iso(r.revoked_at)}${r.revoked_reason ? ` (${r.revoked_reason})` : ''}`
    ])];
  const widths = table[0].map((_, i) => Math.max(...table.map((row) => String(row[i]).length)));
  for (const row of table) say(row.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd());
  if (!rows.length) say('(no scoped tokens)');
  return 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { say(USAGE); return 0; }
  const listing = !!args.list;
  if (listing && (args.jti !== undefined || args.reason !== undefined)) throw new Refusal('--list takes only --workspace');
  if (!listing && args.workspace !== undefined) throw new Refusal('--workspace goes with --list');
  if (!listing && (args.jti === undefined || !String(args.jti).trim())) throw new Refusal(`--jti or --list is required\n${USAGE}`);
  const reason = listing ? null : parseReason(args.reason);
  if (!process.env.DATABASE_URL) throw new Refusal('DATABASE_URL is not set');

  const client = await connect();
  try {
    await requireRegistry(client);
    if (listing) return await list(client, args.workspace === undefined ? null : String(args.workspace));
    return await revoke(client, String(args.jti).trim(), reason);
  } finally {
    await client.end().catch(() => {});
  }
}

main().then(
  (code) => { process.exitCode = code; },
  (e) => {
    if (e instanceof Refusal) {
      say(`refused: ${e.message}`);
      process.exitCode = 2;
    } else {
      say(`error: ${(e && (e.code || e.name)) || 'error'}: ${(e && e.message) || e}`);
      process.exitCode = 1;
    }
  }
);
