// Thread `participants` is a free-text address list ("A <a@x>; b@y, C
// <c@z>"). It was historically captured ONCE, at thread creation, from
// the first message's From+To and never touched again. That made it an
// unreliable index of "who is on this thread": anyone who first appears
// on a later message — CC'd in, replying from a second address, or a
// thread that began internally before the client was looped in — never
// landed in `participants`.
//
// Downstream consumers (DelegationDoer's client-health scorer and the
// touchpoint sync) bucket threads to clients purely by matching against
// `participants`, so those late-arriving clients were silently skipped
// and their health/touchpoint values never computed. The fix is to keep
// `participants` current by merging each new message's addresses in on
// ingest — mirroring how `search_text` is already appended per message.

// Pull the set of bare email addresses out of a free-text address list,
// lowercased. Tolerates display names, angle brackets, and "; " / ", "
// separators alike.
function extractAddrs(text) {
  if (!text) return [];
  const re = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[0].toLowerCase());
  return out;
}

// Append any addresses in `additions` that aren't already represented in
// `existing` (compared by bare lowercased address). The original string
// is preserved verbatim so we don't churn display names; only genuinely
// new addresses are appended. Returns the (possibly unchanged) string.
function mergeParticipants(existing, additions) {
  const base = existing || '';
  const have = new Set(extractAddrs(base));
  const toAdd = [];
  for (const a of additions || []) {
    for (const addr of extractAddrs(a)) {
      if (!have.has(addr)) {
        have.add(addr);
        toAdd.push(addr);
      }
    }
  }
  if (toAdd.length === 0) return base;
  return base ? `${base}; ${toAdd.join('; ')}` : toAdd.join('; ');
}

module.exports = { extractAddrs, mergeParticipants };
