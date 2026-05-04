const jwt = require('jsonwebtoken');

function sign(user) {
  return jwt.sign(
    { id: user.id, workspace_id: user.workspace_id, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
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
