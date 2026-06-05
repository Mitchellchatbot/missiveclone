// Read-only diagnostics for the "attachments on DelegationDoer-sent email
// don't appear for recipients" problem. The attachment is confirmed delivered
// (visible in OWA), so the question is purely: when MissiveClone's inbound
// Graph sync sees the message, what does Graph report?
//
//   DATABASE_URL=postgres://... RECIPIENT_EMAIL=user@scaledai.org \
//     SUBJECT="img testing" node backend/scripts/diagnose-attachment-sync.js
//
// Nothing here writes (other than Microsoft's own refresh-token rotation,
// which getAccessTokenForResource persists — same as a normal sync would).
// Every Graph call is a GET.
//
// It distinguishes the two root-cause candidates from the plan:
//   - hasAttachments=false on the synced copy  → candidate 1 (sync skips the
//     fetch because it trusts the stale flag). syncFolderViaGraph must probe
//     regardless of the flag.
//   - hasAttachments=true but the /attachments listing is empty or the type
//     isn't #microsoft.graph.fileAttachment → candidate 2 (fetch drops it).
//     fetchAttachmentsForMessage needs fixing.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const ms = require('../src/oauth/microsoft');
const { one } = require('../src/db');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
// Same scope syncAccountViaGraph uses (graph.js GRAPH_SYNC_SCOPE).
const GRAPH_SYNC_SCOPE = 'https://graph.microsoft.com/Mail.ReadWrite offline_access';

const RECIPIENT_EMAIL = process.env.RECIPIENT_EMAIL || '';
const SUBJECT = process.env.SUBJECT || '';

function bail(msg) {
  console.error(msg);
  process.exit(2);
}

if (!process.env.DATABASE_URL) bail('DATABASE_URL not set. Export it (or put it in backend/.env) and rerun.');
if (!RECIPIENT_EMAIL) bail('RECIPIENT_EMAIL not set. Set it to the mailbox that RECEIVED the DD-sent test email.');
if (!SUBJECT) bail('SUBJECT not set. Set it to (the start of) the test email subject, e.g. SUBJECT="img testing".');

async function graphGet(url, token) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Graph GET ${url.split('?')[0]} → ${res.status}: ${detail.slice(0, 300)}`);
  }
  return res.json();
}

(async () => {
  const account = await one(
    'SELECT * FROM email_accounts WHERE lower(email) = lower($1)',
    [RECIPIENT_EMAIL]
  );
  if (!account) bail(`No email_accounts row for ${RECIPIENT_EMAIL}.`);
  if (account.provider !== 'microsoft') bail(`${RECIPIENT_EMAIL} is provider=${account.provider}; this probe only covers Microsoft/Graph accounts.`);

  const token = await ms.getAccessTokenForResource(account, GRAPH_SYNC_SCOPE);

  // OData single-quote escaping = double the quote. startswith() so the
  // caller can pass a subject prefix without matching "Re:"/"Fwd:" exactly.
  const escaped = SUBJECT.replace(/'/g, "''");
  const filter = `startswith(subject,'${escaped}')`;
  const listUrl =
    `${GRAPH_BASE}/me/messages?$filter=${encodeURIComponent(filter)}` +
    `&$select=id,subject,hasAttachments,internetMessageId,from,receivedDateTime,parentFolderId` +
    `&$top=10&$orderby=receivedDateTime desc`;

  console.log(`\nRecipient mailbox: ${account.email} (account_id=${account.id})`);
  console.log(`Subject filter:    startswith "${SUBJECT}"\n`);

  const list = await graphGet(listUrl, token);
  const messages = Array.isArray(list.value) ? list.value : [];
  if (!messages.length) {
    console.log('(no matching messages in this mailbox — check the subject / recipient)');
    process.exit(0);
  }

  for (const m of messages) {
    const fromAddr = m.from && m.from.emailAddress ? m.from.emailAddress.address : '(unknown)';
    console.log('─'.repeat(72));
    console.log(`  subject:           ${m.subject}`);
    console.log(`  from:              ${fromAddr}`);
    console.log(`  receivedDateTime:  ${m.receivedDateTime}`);
    console.log(`  hasAttachments:    ${m.hasAttachments}   <-- the flag syncFolderViaGraph gates on`);
    console.log(`  graph id:          ${m.id}`);

    // Always list attachments, regardless of the flag — that's the whole
    // point of the probe. No `$select`: `contentId` is fileAttachment-only and
    // `@odata.type` isn't selectable, so selecting them 400s the whole request
    // on the base `attachment` collection (the bug this probe exists to find).
    const attUrl =
      `${GRAPH_BASE}/me/messages/${encodeURIComponent(m.id)}/attachments`;
    let att;
    try {
      att = await graphGet(attUrl, token);
    } catch (e) {
      console.log(`  attachments:       ERROR listing — ${e.message}`);
      continue;
    }
    const rows = Array.isArray(att.value) ? att.value : [];
    if (!rows.length) {
      console.log('  attachments:       (none returned by /attachments)');
      continue;
    }
    console.log(`  attachments:       ${rows.length} returned by /attachments`);
    for (const a of rows) {
      const type = a['@odata.type'];
      const isFile = type === '#microsoft.graph.fileAttachment';
      console.log(
        `    - ${a.name}  (${a.contentType}, ${a.size} bytes)\n` +
        `        @odata.type=${type}${isFile ? '' : '  <-- NOT a fileAttachment: fetchAttachmentsForMessage SKIPS this'}\n` +
        `        isInline=${a.isInline}  contentId=${a.contentId || '(none)'}`
      );
    }
  }

  console.log('─'.repeat(72));
  console.log(`
Reading guide:
  - hasAttachments=false but /attachments returned a fileAttachment
      → CANDIDATE 1. syncFolderViaGraph (graph.js:657) skipped the fetch
        because it trusts the flag. Fix: probe regardless of the flag.
  - hasAttachments=true but /attachments empty, or @odata.type is NOT
    #microsoft.graph.fileAttachment
      → CANDIDATE 2. fetchAttachmentsForMessage (graph.js:544) drops it.
        Fix the filter / byte fetch for the type shown above.
`);
  process.exit(0);
})().catch((e) => {
  console.error('diagnostic run failed:', e.message);
  process.exit(1);
});
