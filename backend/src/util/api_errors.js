const { routerPath, isCl2RouteKey } = require('./allow_list');

// The error body of the CL2 routes and of the scoped-token checks:
//   { error: '<code>', detail?, draftStatus?, graphStatus?, graphCode? }
// `error` is always one of a fixed set of codes, so a caller branches on it and
// never on text. detail and graphCode are capped, and nothing here ever echoes
// an exception's message, which can carry Graph's or the database's own text.
// The legacy routes keep their own { error: '<message>' } bodies.
function sendApiError(res, status, code, { detail, draftStatus, graphStatus, graphCode, retryAfterSec } = {}) {
  if (retryAfterSec != null) res.set('Retry-After', String(retryAfterSec));
  const body = { error: code };
  if (detail) body.detail = String(detail).slice(0, 200);
  if (draftStatus) body.draftStatus = draftStatus;
  if (graphStatus != null) body.graphStatus = graphStatus;
  if (graphCode) body.graphCode = String(graphCode).slice(0, 100);
  return res.status(status).json(body);
}

// The err.type values body-parser gives a request body it could not read.
const BODY_ERROR_TYPES = new Set([
  'entity.parse.failed', 'entity.too.large', 'entity.verify.failed',
  'encoding.unsupported', 'charset.unsupported',
  'request.aborted', 'request.size.invalid',
  'stream.encoding.set', 'stream.not.readable', 'parameters.too.many'
]);

function isBodyError(err) {
  return !!err && typeof err.type === 'string' && BODY_ERROR_TYPES.has(err.type);
}

// Error middleware: a body the JSON parser could not read, on one of the CL2
// paths or for a request carrying an account-scoped token, is answered 400
// bad_request here and logged by its error type alone. It must not reach the app
// error handler: that one logs the whole error object, and for a parse failure
// body-parser attaches the raw request body to it (recipients, HTML), then
// answers 500 with the parser's own text. Every other request and error passes
// through untouched, so legacy responses stay exactly as they were.
//
// index.js mounts it right after the app-wide JSON parser (which already skips
// the CL2 paths; this is the second line), and the CL2 router uses it for the
// parser it runs itself.
function cl2BodyErrors(err, req, res, next) {
  const scoped = !!(req.auth && req.auth.kind === 'scoped');
  if (!isBodyError(err) || !(scoped || isCl2RouteKey(routerPath(req)))) return next(err);
  console.warn(`[outlook-drafts] bad body ${err.type}`);
  if (res.headersSent) return undefined;
  return sendApiError(res, 400, 'bad_request', { detail: 'body must be a JSON object ≤ 5 MB' });
}

module.exports = { sendApiError, cl2BodyErrors };
