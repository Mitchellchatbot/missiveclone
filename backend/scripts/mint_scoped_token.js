// Mints an account-scoped API token: a JWT that may call only the routes the
// allow-list (src/util/allow_list.js) gives its scopes, sees only the listed
// accounts' mail, and is checked on every request against its scoped_tokens row
// (so it can be revoked: revoke_scoped_token.js). There is deliberately no HTTP
// route for this; an operator runs it against the deployment the token is for.
//
//   node backend/scripts/mint_scoped_token.js --workspace <workspace_id> --list-accounts
//   node backend/scripts/mint_scoped_token.js --workspace <workspace_id> --scopes read,draft \
//        --accounts <account_id>[,<account_id>...] [--label "<text>"] [--print]
//   node backend/scripts/mint_scoped_token.js --workspace <workspace_id> --scopes send \
//        --accounts <account_id> [--label "<text>"] [--print]
//
// Env: DATABASE_URL and JWT_SECRET (the server's own), DB_SCHEMA (default
// missive), DATABASE_SSL (read as the server reads it). Only the process
// environment is read, never a .env file, so the database and secret used are
// always the ones the operator passed in.
//
// Without --print it is a dry run: every check below runs and nothing is
// written. With --print, in one transaction, it creates (or reuses) the
// workspace's service user ea-service@<workspace id>, whose password hash no
// password can match, records the token in scoped_tokens, and prints the token
// once on stdout. Everything else goes to stderr. The token itself is never
// stored, logged or written to a file.
//
// Refusals (exit 2, nothing written): a usage error; a missing DATABASE_URL or
// JWT_SECRET; a database without the CL2 schema; an unknown workspace; a scope
// set other than read | read,draft | send; not 1 to 50 distinct accounts of that
// workspace; draft or send for an account that is not a connected Microsoft
// account; a label over 200 characters or with control characters; an
// ea-service user of another workspace, or one that someone could sign in as.
// Exit codes: 0 done (or dry run), 2 refused, 1 unexpected error.
//
// It never loads src/index.js (which starts the sync loop, the watchers and the
// dispatcher) and never runs db.init().
const crypto = require('crypto');
const { Client } = require('pg');
const jwt = require('jsonwebtoken');

const USAGE = [
  'usage:',
  '  node backend/scripts/mint_scoped_token.js --workspace <workspace_id> --list-accounts',
  '  node backend/scripts/mint_scoped_token.js --workspace <workspace_id> --scopes read,draft --accounts <id>[,<id>...] [--label "<text>"] [--print]',
  '  node backend/scripts/mint_scoped_token.js --workspace <workspace_id> --scopes send --accounts <id> [--label "<text>"] [--print]',
  '',
  '  --scopes    exactly one of: read | read,draft | send',
  '  --accounts  1 to 50 email_accounts ids of the workspace (draft and send: connected Microsoft accounts)',
  '  --label     an operator note stored with the token, up to 200 characters',
  '  --print     mint, and print the token once on stdout; without it nothing is written (dry run)',
  '',
  'env: DATABASE_URL, JWT_SECRET (required); DB_SCHEMA (default missive); DATABASE_SSL'
].join('\n');

// The service user every token of a workspace names. Its password_hash is not a
// bcrypt hash, so bcrypt never matches it and nobody can sign in as it.
const SERVICE_NAME = 'EA service';
const NO_LOGIN_HASH = '!service-account-no-login';
const serviceEmail = (ws) => `ea-service@${ws.toLowerCase()}`;

const LIFETIME_DAYS = 365;
const LIFETIME_SEC = LIFETIME_DAYS * 24 * 3600;
// The scope sets a token may carry, each sorted: a reader, a reader that also
// drafts, and a sender that can do nothing else.
const SCOPE_SETS = ['read', 'draft,read', 'send'];
const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const WORKSPACE_ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;
const MAX_ACCOUNTS = 50;
const MAX_LABEL = 200;

// A refusal: printed as is, exit 2, nothing written.
class Refusal extends Error {}

const say = (line) => process.stderr.write(`${line}\n`);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
// For echoing an operator's input back in a message: printable ASCII, short.
const shown = (v) => JSON.stringify(String(v).slice(0, 80).replace(/[^\x20-\x7e]/g, '?'));

const FLAGS = { workspace: 'value', 'list-accounts': 'bool', scopes: 'value', accounts: 'value',
  label: 'value', print: 'bool', help: 'bool' };

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

function parseScopes(v) {
  const list = String(v).split(',').map((s) => s.trim());
  if (list.some((s) => !s)) throw new Refusal('--scopes: an empty entry');
  if (new Set(list).size !== list.length) throw new Refusal('--scopes: a scope is listed twice');
  const sorted = [...list].sort();
  if (!SCOPE_SETS.includes(sorted.join(','))) {
    throw new Refusal(`--scopes must be exactly one of: read | read,draft | send (got ${shown(list.join(','))})`);
  }
  return sorted;
}

function parseAccounts(v) {
  const list = String(v).split(',').map((s) => s.trim());
  if (list.some((s) => !s)) throw new Refusal('--accounts: an empty entry');
  if (list.length > MAX_ACCOUNTS) throw new Refusal(`--accounts: at most ${MAX_ACCOUNTS} accounts`);
  const bad = list.find((id) => !ACCOUNT_ID_RE.test(id));
  if (bad !== undefined) throw new Refusal(`--accounts: not an account id: ${shown(bad)}`);
  if (new Set(list).size !== list.length) throw new Refusal('--accounts: an account is listed twice');
  return [...list].sort();
}

function parseLabel(v) {
  if (v === undefined) return null;
  const s = String(v);
  if ([...s].length > MAX_LABEL) throw new Refusal(`--label: at most ${MAX_LABEL} characters`);
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(s)) throw new Refusal('--label: printable characters only (no control characters or line breaks)');
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

async function requireCl2Schema(client) {
  const { rows } = await client.query(
    'SELECT to_regclass($1) IS NOT NULL AS tokens, to_regclass($2) IS NOT NULL AS drafts',
    [T('scoped_tokens'), T('outlook_drafts')]
  );
  if (!rows[0].tokens || !rows[0].drafts) {
    throw new Refusal('CL2 schema not ready: deploy CL2 and check /api/status cl2.ready');
  }
}

async function requireWorkspace(client, ws) {
  const { rows } = await client.query(`SELECT id FROM ${T('workspaces')} WHERE id = $1`, [ws]);
  if (!rows.length) throw new Refusal(`unknown workspace ${shown(ws)}`);
}

// id  email  provider  connected, for every account of the workspace. Only
// whether a credential is stored is read, never the credential.
async function listAccounts(client, ws) {
  const { rows } = await client.query(
    `SELECT id, email, COALESCE(provider, 'imap') AS provider,
            CASE WHEN provider = 'microsoft' THEN oauth_refresh_token IS NOT NULL
                 ELSE COALESCE(imap_pass, '') <> '' END AS connected
       FROM ${T('email_accounts')} WHERE workspace_id = $1 ORDER BY email, id`,
    [ws]
  );
  say(`accounts of workspace ${ws}:`);
  const table = [['id', 'email', 'provider', 'connected'],
    ...rows.map((r) => [r.id, r.email, r.provider, r.connected ? 'yes' : 'no'])];
  const widths = table[0].map((_, i) => Math.max(...table.map((row) => String(row[i]).length)));
  for (const row of table) say(row.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd());
  if (!rows.length) say('(none)');
}

// Every requested account must be a row of this workspace; draft and send also
// need a connected Microsoft account. All problems are reported at once.
async function checkAccounts(client, ws, ids, scopes) {
  const { rows } = await client.query(
    `SELECT id, workspace_id, email, provider, (oauth_refresh_token IS NOT NULL) AS has_refresh_token
       FROM ${T('email_accounts')} WHERE id = ANY($1::text[])`,
    [ids]
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const needsMicrosoft = scopes.includes('draft') || scopes.includes('send');
  const problems = [];
  for (const id of ids) {
    const a = byId.get(id);
    if (!a) problems.push(`unknown account id ${id}`);
    else if (a.workspace_id !== ws) problems.push(`account ${id} belongs to another workspace`);
    else if (needsMicrosoft && !(a.provider === 'microsoft' && a.has_refresh_token)) {
      problems.push(`account ${id} is not a connected Microsoft account (draft and send need one)`);
    }
  }
  if (problems.length) throw new Refusal(problems.join('\n'));
  return ids.map((id) => byId.get(id));
}

// The service user ea-service@<ws> is reused only when it is this workspace's
// and is the service account itself: the no-login password hash and the
// service name. Any other row with that address (an ordinary user, with a
// password of its own) is never reused, so every token names a user nobody can
// sign in as.
function checkServiceUser(user, ws) {
  if (user.workspace_id !== ws) {
    throw new Refusal(`${serviceEmail(ws)} belongs to another workspace; remove it or pick another workspace`);
  }
  if (!(user.no_login === true && user.name === SERVICE_NAME)) {
    throw new Refusal('ea-service user exists with a usable password; remove it or pick another workspace');
  }
}

async function serviceUserRow(client, ws) {
  const { rows } = await client.query(
    `SELECT id, workspace_id, email, (password_hash = $2) AS no_login, name FROM ${T('users')} WHERE email = $1`,
    [serviceEmail(ws), NO_LOGIN_HASH]
  );
  return rows[0] || null;
}

// The minted token must pass the server's own check for a scoped token's shape
// and carry exactly what was recorded for it, before anything is committed.
function selfCheck(token, want) {
  const auth = require('../src/auth');
  const p = auth.verify(token);
  const rule = auth.scopedReason(p);
  if (rule) throw new Error(`self-check failed: the minted token breaks the scoped-token rule "${rule}"`);
  if (p.jti !== want.jti || p.id !== want.userId || p.workspace_id !== want.ws
      || p.scope.join(',') !== want.scopes.join(',') || p.accounts.join(',') !== want.accounts.join(',')) {
    throw new Error('self-check failed: the minted token does not carry the claims recorded for it');
  }
}

async function mint(client, { ws, scopes, accounts, label }) {
  const now = Date.now();
  await client.query('BEGIN');
  try {
    const ins = await client.query(
      `INSERT INTO ${T('users')} (id, workspace_id, email, password_hash, name, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (email) DO NOTHING
       RETURNING id`,
      [crypto.randomUUID(), ws, serviceEmail(ws), NO_LOGIN_HASH, SERVICE_NAME, now]
    );
    const created = ins.rowCount === 1;
    const user = await serviceUserRow(client, ws);
    if (!user) throw new Error(`${serviceEmail(ws)} not found after the insert`);
    // A row this insert created is the service account by construction; one it
    // found must already be.
    if (!created) checkServiceUser(user, ws);

    const jti = crypto.randomBytes(16).toString('base64url');
    // One expiry for the token and its registry row: the claim's exp (whole
    // seconds) and expires_at name the same instant.
    const iat = Math.floor(now / 1000);
    const exp = iat + LIFETIME_SEC;
    const expiresAt = exp * 1000;
    await client.query(
      `INSERT INTO ${T('scoped_tokens')} (jti, user_id, workspace_id, scopes, accounts, label, created_at, expires_at)
       VALUES ($1, $2, $3, $4::text[], $5::text[], $6, $7, $8)`,
      [jti, user.id, ws, scopes, accounts, label, now, expiresAt]
    );
    const token = jwt.sign(
      { id: user.id, workspace_id: ws, email: user.email, scope: scopes, accounts, jti, iat, exp },
      process.env.JWT_SECRET,
      { algorithm: 'HS256' }
    );
    selfCheck(token, { jti, userId: user.id, ws, scopes, accounts });
    await client.query('COMMIT');
    return { token, jti, user, created, expiresAt };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { say(USAGE); return 0; }
  if (!args.workspace) throw new Refusal(`--workspace is required\n${USAGE}`);
  const listOnly = !!args['list-accounts'];
  if (listOnly && (args.scopes !== undefined || args.accounts !== undefined || args.label !== undefined || args.print)) {
    throw new Refusal('--list-accounts takes only --workspace');
  }
  if (!listOnly && (args.scopes === undefined || args.accounts === undefined)) {
    throw new Refusal(`--scopes and --accounts are required\n${USAGE}`);
  }
  if (!process.env.DATABASE_URL) throw new Refusal('DATABASE_URL is not set');
  if (!process.env.JWT_SECRET) throw new Refusal('JWT_SECRET is not set (it must be the secret of the server the token is for)');
  const ws = String(args.workspace);
  if (!WORKSPACE_ID_RE.test(ws)) throw new Refusal(`--workspace: not a workspace id: ${shown(ws)}`);
  const scopes = listOnly ? null : parseScopes(args.scopes);
  const accountIds = listOnly ? null : parseAccounts(args.accounts);
  const label = listOnly ? null : parseLabel(args.label);

  const client = await connect();
  try {
    await requireCl2Schema(client);
    await requireWorkspace(client, ws);
    if (listOnly) {
      await listAccounts(client, ws);
      return 0;
    }
    const accounts = await checkAccounts(client, ws, accountIds, scopes);
    // The dry run checks the service user too, so it predicts what --print does.
    const existing = await serviceUserRow(client, ws);
    if (existing) checkServiceUser(existing, ws);

    say(`workspace     ${ws}`);
    say(`scopes        ${scopes.join(',')}`);
    say(`accounts      ${accounts.map((a) => `${a.id} (${a.email})`).join(', ')}`);
    say(`label         ${label === null ? '-' : label}`);
    say(`service user  ${serviceEmail(ws)} (${existing ? 'exists; reused' : 'created by --print'})`);
    say(`lifetime      ${LIFETIME_DAYS} days`);
    if (!args.print) {
      say('dry run: nothing written; re-run with --print to mint');
      return 0;
    }

    const m = await mint(client, { ws, scopes, accounts: accountIds, label });
    say(`minted jti=${m.jti} user=${m.user.id} (${m.user.email}) scopes=${scopes.join(',')} `
      + `accounts=${accountIds.join(',')} expires=${new Date(m.expiresAt).toISOString()}`);
    say('check it against the server: curl -s -H "Authorization: Bearer $TOKEN" https://<server>/api/auth/me '
      + 'shows auth.kind "scoped" (a send-only token gets 403 there, as expected)');
    process.stdout.write(`${m.token}\n`);
    return 0;
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
