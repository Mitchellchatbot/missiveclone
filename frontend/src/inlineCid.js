// Helpers for inline-image (`cid:<content-id>`) references in email HTML.
//
// Emails embed images by referencing them from the HTML body as
// `<img src="cid:<content-id>">`, with the bytes carried as a separate MIME
// part whose Content-ID matches. A browser can't resolve `cid:` URLs, so the
// thread view swaps them for blob URLs of the fetched parts and hides those
// parts from the attachment chip row (they're already visible in the body).
//
// Ported from DelegationDoer's src/lib/inline-cid.ts so both UIs apply the same
// rule. Note that content_id on its own is NOT an "inline" signal: Outlook
// stamps a Content-ID on ordinary PDFs and .ics files too. Only a `cid:`
// reference from the message's own body makes a part inline.
//
// Both helpers expect SANITIZED html (the string that actually gets rendered):
// classifying against the raw body would hide a part whose only reference the
// sanitizer then drops, leaving it with neither a chip nor an image.

// Raster types we're willing to render inline. SVG is deliberately excluded: an
// SVG blob URL carries this page's origin, so a scripted SVG opened in a new tab
// ("open image in new tab", or a link to it) would run with access to the
// service token. Anything outside this list keeps its download chip.
const INLINE_IMAGE_TYPES = {
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/gif': 'image/gif',
  'image/webp': 'image/webp',
  'image/bmp': 'image/bmp'
};

// The safe MIME type to render a part inline as, or null if it must stay a
// chip. Callers force the fetched blob to this type rather than trusting the
// response's Content-Type, which is just whatever the sender declared.
export function inlineImageType(contentType) {
  const base = String(contentType || '').split(';')[0].trim().toLowerCase();
  return INLINE_IMAGE_TYPES[base] || null;
}

// A whole <img> start tag, stepping over quoted attribute values so a `>`
// inside one (older serializers don't escape it) doesn't end the tag early.
const IMG_TAG_RE = /<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
// One attribute inside a start tag: name, then an optional quoted/bare value.
const ATTR_RE = /(\s)([^\s"'>\/=]+)(?:(\s*=\s*)("[^"]*"|'[^']*'|[^\s"'>]+))?/g;

// The content-id an <img src> value points at, or null if it isn't a `cid:`
// URL. The whole value is compared (not a substring match), so `cid:image1`
// can never be mistaken for a reference to `image10`. The clone stores
// content_id without angle brackets, but real bodies sometimes wrap them
// (`cid:<id>`) — raw, or entity-escaped as `&lt;`/`&gt;` by the DOM serializer.
// Lower-cased because the old matcher was case-insensitive and mail clients
// aren't consistent about case.
function cidOf(rawValue) {
  let v = rawValue.replace(/^["']|["']$/g, '').trim();
  if (!/^cid:/i.test(v)) return null;
  v = v.slice(4).replace(/^(?:<|&lt;)/i, '').replace(/(?:>|&gt;)$/i, '').replace(/&amp;/gi, '&');
  // RFC 2392 cid URLs are percent-encoded; tolerate a malformed escape.
  try { v = decodeURIComponent(v); } catch {}
  return v.toLowerCase();
}

// Call `fn(cid, name, value)` for each <img src> in `html` and splice in the
// attribute text it returns (or leave the attribute as-is if it returns null).
// Only <img src> is touched — never <a href> or anything else — so a blob URL
// can only ever be loaded as an image, not navigated to.
function mapImgSrcs(html, fn) {
  return html.replace(IMG_TAG_RE, tag => tag.replace(ATTR_RE, (attr, sp, name, eq, value) => {
    if (!value || name.toLowerCase() !== 'src') return attr;
    const cid = cidOf(value);
    if (cid == null) return attr;
    const next = fn(cid);
    return next == null ? attr : `${sp}${name}${eq}"${next}"`;
  }));
}

// Ids of the attachments that render inline in `html`: raster image parts
// whose content_id is referenced by an `<img src="cid:...">` in the body.
// Callers hide these from the chip row. Guards that keep a real file from ever
// disappearing:
//   - an unreferenced content_id part (e.g. an Outlook PDF) is not included;
//   - a part referenced only from somewhere we don't render (an <a href>, CSS)
//     is not included, since it would never show;
//   - a referenced part that isn't an allowlisted raster type (a PDF, an .ics,
//     an SVG, an image stored as octet-stream) is not included either.
// With no html (text-only body) nothing is inline, so everything chips.
export function referencedInlineIds(html, attachments) {
  const ids = new Set();
  if (!html) return ids;
  const referenced = new Set();
  mapImgSrcs(html, cid => { referenced.add(cid); return null; });
  for (const a of attachments || []) {
    if (!a.content_id || !inlineImageType(a.content_type)) continue;
    if (referenced.has(a.content_id.toLowerCase())) ids.add(a.id);
  }
  return ids;
}

// Point each `<img src="cid:...">` whose content_id has an entry in `cidMap`
// ({ content_id -> url }) at that url. References with no entry (still
// loading, or the fetch failed) are left alone rather than pointed at a broken
// URL.
export function replaceCids(html, cidMap) {
  if (!html || !cidMap) return html;
  const byCid = new Map();
  for (const cid of Object.keys(cidMap)) byCid.set(cid.toLowerCase(), cidMap[cid]);
  if (!byCid.size) return html;
  return mapImgSrcs(html, cid => byCid.get(cid) ?? null);
}
