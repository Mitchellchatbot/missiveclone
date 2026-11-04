// Extra Graph folders a Microsoft account syncs besides the three built-in ones
// (inbox, sentitems, junkemail). Stored in email_accounts.extra_sync_folders as
// [{ id, label }]: `id` is the folder's canonical Graph id (PATCH
// /api/accounts/:id/sync-folders resolves whatever the caller passed), `label` is
// what goes into messages.folder for mail found there.
//
// The label is not cosmetic. DD's INBOX view is an exact `folder = 'INBOX'`
// match, its Spam view is `ILIKE '%junk%' OR '%spam%'`, and ingest suppresses
// the inbound webhook for /spam|junk/i. A label that collides with any of those
// would move mail between DD's views or push junk into DD's intake, so the rules
// below keep extra-folder labels clear of all of them.

const MAX_EXTRA_FOLDERS = 10;
const MAX_LABEL_LENGTH = 60;

// Graph REST folder ids are URL-safe base64 ('-', '_', '=' padding); well-known
// names are lowercase letters. Anything else is refused before it can reach a
// URL or a cursor key.
const FOLDER_ID_RE = /^[A-Za-z0-9_=-]{1,512}$/;

// Labels the built-in walks, DD sends and DD's views already use (compared
// lower-cased).
const RESERVED_LABELS = new Set([
  'inbox', 'sent', 'sent items', 'sentitems', 'junk email', 'junkemail',
  'drafts', 'outbox', 'deleted items', 'deleteditems'
]);

// Well-known folder names that must never be walked as an extra folder: the
// three already synced (walking one twice relabels its mail, and Sent Items or
// Junk walked as an extra folder would turn sent mail into inbound twins or push
// junk through the webhook), drafts/outbox (not mail yet), and system folders.
// The PATCH route also compares the RESOLVED id against the built-in folders'
// real ids, which catches the same folders passed by id.
const DENIED_FOLDER_NAMES = new Set([
  'inbox', 'sentitems', 'junkemail', 'drafts', 'outbox', 'deleteditems',
  'msgfolderroot', 'searchfolders', 'syncissues', 'conflicts', 'localfailures',
  'serverfailures'
]);

function isDeniedFolderName(id) {
  const s = String(id).toLowerCase();
  return DENIED_FOLDER_NAMES.has(s) || s.startsWith('recoverableitems');
}

function labelError(label) {
  if (typeof label !== 'string' || !label.length) return 'is required';
  if (label.length > MAX_LABEL_LENGTH) return `must be at most ${MAX_LABEL_LENGTH} characters`;
  if (/[\u0000-\u001f\u007f]/.test(label)) return 'must not contain control characters';
  if (RESERVED_LABELS.has(label.toLowerCase())) return 'is reserved for a built-in folder';
  if (/junk|spam/i.test(label)) return 'must not contain "junk" or "spam"';
  return null;
}

// Validate a PATCH body's `folders`. Returns { folders } (labels trimmed) or
// { error } naming the first problem. Ids are checked for shape and denied names
// only; the route then resolves them against Graph.
function validateExtraFolders(input) {
  if (!Array.isArray(input)) return { error: 'folders must be an array' };
  if (input.length > MAX_EXTRA_FOLDERS) return { error: `at most ${MAX_EXTRA_FOLDERS} extra folders are allowed` };
  const out = [];
  const ids = new Set();
  const labels = new Set();
  for (let i = 0; i < input.length; i++) {
    const f = input[i];
    if (!f || typeof f !== 'object' || Array.isArray(f)) return { error: `folders[${i}] must be an object` };
    if (typeof f.id !== 'string' || !FOLDER_ID_RE.test(f.id)) {
      return { error: `folders[${i}].id is not a valid Graph folder id` };
    }
    if (isDeniedFolderName(f.id)) {
      return { error: `folders[${i}].id "${f.id}" is a built-in or system folder and cannot be an extra folder` };
    }
    if (ids.has(f.id)) return { error: `folders[${i}].id is listed twice` };
    ids.add(f.id);
    const label = typeof f.label === 'string' ? f.label.trim() : f.label;
    const err = labelError(label);
    if (err) return { error: `folders[${i}].label ${err}` };
    if (labels.has(label.toLowerCase())) return { error: `folders[${i}].label duplicates another folder's label` };
    labels.add(label.toLowerCase());
    out.push({ id: f.id, label });
  }
  return { folders: out };
}

// The stored config, read defensively at walk time: the PATCH route validated it,
// but this is a jsonb column anyone with SQL access can edit. Bad entries are
// skipped (not walked), never guessed at.
function parseStoredExtraFolders(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const ids = new Set();
  const labels = new Set();
  for (const f of value) {
    if (out.length >= MAX_EXTRA_FOLDERS) break;
    if (!f || typeof f !== 'object') continue;
    if (typeof f.id !== 'string' || !FOLDER_ID_RE.test(f.id) || isDeniedFolderName(f.id)) continue;
    if (typeof f.label !== 'string' || labelError(f.label)) continue;
    if (ids.has(f.id) || labels.has(f.label.toLowerCase())) continue;
    ids.add(f.id);
    labels.add(f.label.toLowerCase());
    out.push({ id: f.id, label: f.label });
  }
  return out;
}

// folder_sync_state key for an extra folder's delta cursor. The built-in walks
// use 'inbox' / 'sentitems' / 'junkemail' and IMAP uses raw provider paths; the
// 'x:' prefix keeps extra folders clear of both.
//
// The label is part of the key on purpose. Relabelling a folder must re-walk it
// from scratch (only a fresh walk re-delivers the mail already stored under the
// old label), and a key that changes with the label gives exactly that — with no
// race against a walk that is running when the label changes: that walk saves
// its cursor under the OLD key, which nothing reads any more. (Graph ids contain
// no '|', so the first '|' always ends the id.)
function extraFolderKey(f) {
  return `x:${f.id}|${f.label}`;
}

module.exports = {
  MAX_EXTRA_FOLDERS, FOLDER_ID_RE,
  validateExtraFolders, parseStoredExtraFolders, extraFolderKey, isDeniedFolderName
};
