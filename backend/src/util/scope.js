// Helpers for code that serves account-scoped tokens: which accounts a request
// may see, and whether sending is switched on.

// The account ids a scoped request is limited to, or null for every other
// request (a session or service token without a scope claim), whose queries
// then stay exactly as they are. Set only by the auth checks (req.auth), never
// from anything the request itself carries.
function scopedAccounts(req) {
  return req.auth && req.auth.kind === 'scoped' ? req.auth.accounts : null;
}

// EA_SEND_ENABLED, read on every call so a changed value applies after a
// restart without a code change:
//   unset, '', false, 0, off, no   -> sending is off everywhere (the default)
//   true                           -> on for every account
//   <id>,<id>,...                  -> on only for these account ids
// Anything else is read as an account-id list, so a typo can only narrow it.
function sendSetting() {
  const v = String(process.env.EA_SEND_ENABLED || '').trim();
  if (!v || /^(false|0|off|no)$/i.test(v)) return { mode: 'off' };
  if (/^true$/i.test(v)) return { mode: 'all' };
  const allow = new Set(v.split(',').map((s) => s.trim()).filter(Boolean));
  return allow.size ? { mode: 'some', allow } : { mode: 'off' };
}

// True only when sending is on for every one of these account ids (one id or
// an array); an empty list is never enabled.
function sendEnabledFor(accountIds) {
  const s = sendSetting();
  if (s.mode === 'off') return false;
  if (s.mode === 'all') return true;
  const ids = Array.isArray(accountIds) ? accountIds : [accountIds];
  return ids.length > 0 && ids.every((id) => s.allow.has(id));
}

// 'off' | 'all' | 'some', for /api/status. Never the account ids themselves.
function sendFlagSummary() {
  return sendSetting().mode;
}

module.exports = { scopedAccounts, sendEnabledFor, sendFlagSummary };
