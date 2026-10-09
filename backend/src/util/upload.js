const multer = require('multer');

// Shared multipart config for every route that accepts attachments. It used to
// be copy-pasted into compose.js and threads.js, which is how the cap below and
// the message the sender is shown drifted apart — see index.js.

// How many files one send may carry.
//
// Raised from 10 after senders hit it attaching a batch of photos to a single
// email. memoryStorage keeps every file in RAM for the life of the request, so
// MAX_ATTACHMENTS * MAX_FILE_BYTES is the worst case one request can pin —
// weigh that product against the dyno's memory before raising it again.
const MAX_ATTACHMENTS = 25;

// Caps a single attachment; 150 MB matches Graph's upload-session ceiling —
// files over the ~3 MB inline limit get chunked (see graph.js
// uploadAttachmentViaSession).
const MAX_FILE_BYTES = 150 * 1024 * 1024;

// The multipart field every send path puts its attachments on. Exported
// because the error handler needs it to tell "too many files on the field we
// do accept" apart from "a file on a field we don't" — multer reports both as
// LIMIT_UNEXPECTED_FILE.
const FILES_FIELD = 'files';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, fieldSize: 10 * 1024 * 1024 }
});

// Mount this on any route that takes attachments, so one cap governs them all.
const attachments = upload.array(FILES_FIELD, MAX_ATTACHMENTS);

module.exports = { upload, attachments, MAX_ATTACHMENTS, MAX_FILE_BYTES, FILES_FIELD };
