const jwt = require('jsonwebtoken');

function sign(user) {
  return jwt.sign(
    { id: user.id, workspace_id: user.workspace_id, email: user.email },
    process.env.JWT_SECRET,
    // 10y instead of a typical session lifetime because this token is
    // used as a service-to-service credential (DelegationDoer holds it
    // in MISSIVE_API_TOKEN and replays it to call us). Rotating that
    // every 30 days meant operators had to log back in, copy the
    // token, and update Railway env — a chore that doesn't buy any
    // real security since the token already lives only in trusted
    // infra. JWT_SECRET rotation remains the actual kill switch.
    { expiresIn: '10y' }
  );
}

function verify(token) {
  return jwt.verify(token, process.env.JWT_SECRET);
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing token' });
  try {
    req.user = verify(token);
    next();
  } catch {
    res.status(401).json({ error: 'invalid token' });
  }
}

module.exports = { sign, verify, requireAuth };
