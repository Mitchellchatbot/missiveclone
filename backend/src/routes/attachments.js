const express = require('express');
const { one } = require('../db');
const { requireAuth } = require('../auth');
const wrap = require('../util/wrap');

const router = express.Router();
router.use(requireAuth);

router.get('/:id', wrap(async (req, res) => {
  const a = await one(
    'SELECT * FROM attachments WHERE id = $1 AND workspace_id = $2',
    [req.params.id, req.user.workspace_id]
  );
  if (!a) return res.status(404).json({ error: 'not found' });

  // HTTP header values must be Latin-1 (ISO-8859-1). Attachment filenames
  // routinely carry characters outside that range — most commonly the U+202F
  // narrow no-break space macOS puts before "AM"/"PM" in screenshot names
  // ("Screenshot … at 10.48.03 AM.png"), plus em-dashes, smart quotes, emoji,
  // accents. Passing the raw name to res.setHeader throws
  // `ERR_INVALID_CHAR: Invalid character in header content` and 500s the
  // download. Per RFC 6266, emit an ASCII-only `filename=` fallback (every byte
  // sanitized into the printable-ASCII range) plus a UTF-8 `filename*` so modern
  // clients still receive the exact original name. content_type is sanitized the
  // same way so a stray header char there can't 500 the response either.
  const rawName = a.filename || 'file';
  const asciiName = rawName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const contentType = String(a.content_type || '').replace(/[^\x20-\x7e]/g, '').trim()
    || 'application/octet-stream';
  res.setHeader('Content-Type', contentType);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(rawName)}`
  );
  res.send(a.data);
}));

module.exports = router;
