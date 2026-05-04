# Missive Clone — MVP

A Missive-inspired shared inbox for teams. Connect any IMAP/SMTP email
account, see all team mail in one place, reply with a rich-text editor and
attachments, assign conversations, change status (open / pending / closed),
add internal comments with @mentions, invite teammates, save canned
responses, and search across your inbox. Updates broadcast in real-time
over WebSockets.

> Independent clone — no Missive code is used. Implements the major
> shared-inbox features Missive describes; see *Limitations* for the gap.

---

## Stack

- **Frontend** — React 18 + Vite + react-router + socket.io-client + DOMPurify
- **Backend** — Node.js + Express + Socket.io, serves the built frontend in
  production (single-service deploy)
- **Database** — Postgres (`pg` node driver)
- **Email** — `imapflow` (IMAP sync + IDLE + Sent-folder append),
  `nodemailer` (SMTP), `mailparser` (MIME)
- **Auth** — bcrypt + JWT, plus token-based team invite links
- **File uploads** — `multer`, stored as `bytea` in Postgres
- **Optional encryption** — AES-256-GCM for stored email passwords

---

## Features in this build

| Feature                                   | Status |
| ----------------------------------------- | ------ |
| Email/password auth + JWT                 | ✅ |
| Workspace per signup                      | ✅ |
| Team invite links (`/invite/:token`)      | ✅ |
| Connect IMAP+SMTP mailboxes (any provider)| ✅ |
| INBOX sync                                | ✅ |
| Sent-folder sync (auto-detected)          | ✅ |
| Append outbound replies to IMAP Sent      | ✅ (skipped for Gmail/M365 — they auto-save) |
| RFC-correct threading (In-Reply-To/Refs)  | ✅ |
| Reply with **rich text** (B/I/U, lists, links) | ✅ |
| Reply with **attachments** (up to 25 MB)  | ✅ |
| Inbound HTML sanitized via DOMPurify      | ✅ |
| Open / Pending / Closed status            | ✅ |
| Assign threads to teammates               | ✅ |
| Internal comments with @mentions          | ✅ |
| Real-time updates via Socket.io           | ✅ |
| Full-text search (Postgres tsvector)      | ✅ |
| Canned responses                          | ✅ |
| Sidebar views (Inbox, Assigned, Pending, Closed, Sent, All) | ✅ |
| **Drafts autosave** (per user, per thread, debounced ~700ms) | ✅ |
| **Team chat** (workspace-wide, real-time, @mentions) | ✅ |
| **Polished UI** (avatars, refined palette, transitions, SVG icons) | ✅ |
| OAuth (Google/Microsoft)                  | ❌ — see *OAuth notes* below |
| SMS, calendar, tasks, automations, mobile apps, integrations | ❌ — out of MVP scope |

---

## Folder structure

```
missive-clone/
├── package.json              # root: orchestrates install/build/start
├── railway.json              # Railway build/start/healthcheck
├── README.md
├── backend/
│   ├── package.json
│   ├── .env.example
│   └── src/
│       ├── index.js          # express + socket.io entry; serves frontend dist
│       ├── db.js             # pg pool + schema + migrations
│       ├── auth.js           # JWT helpers + requireAuth
│       ├── crypto.js         # AES-GCM for stored email passwords
│       ├── sockets.js        # socket.io setup + emitToWorkspace()
│       ├── util/wrap.js      # async route handler wrapper
│       ├── email/
│       │   ├── imap.js       # multi-folder sync, Sent append, IDLE watching
│       │   └── smtp.js       # outbound send (with attachments)
│       └── routes/
│           ├── auth.js
│           ├── invites.js    # create/accept team invites
│           ├── accounts.js
│           ├── threads.js    # list/get/patch/reply/comments + multipart upload
│           ├── attachments.js# auth-protected download
│           └── canned.js     # canned responses CRUD
└── frontend/
    ├── package.json
    ├── vite.config.js        # dev proxy /api + /socket.io to :4000
    ├── .env.example          # VITE_API_URL (only for split-origin deploys)
    ├── index.html
    └── src/
        ├── main.jsx
        ├── App.jsx           # router (incl. /invite/:token)
        ├── api.js
        ├── socket.js
        ├── styles.css
        ├── pages/
        │   ├── Login.jsx
        │   ├── Signup.jsx
        │   ├── AcceptInvite.jsx
        │   └── Dashboard.jsx
        └── components/
            ├── Sidebar.jsx
            ├── ThreadList.jsx
            ├── ThreadView.jsx          # DOMPurify, attachments
            ├── ComposeReply.jsx        # rich editor + uploads + canned
            ├── RichEditor.jsx
            ├── Comments.jsx
            ├── ConnectAccount.jsx
            ├── InviteModal.jsx
            └── CannedModal.jsx
```

---

## Local dev

Requires Node 18+ and a local Postgres.

```powershell
# 1. DB
createdb missive_clone   # or: docker run -d --name pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16

# 2. Backend env
cd C:\Users\PMY\Downloads\missive-clone\backend
copy .env.example .env
# Edit .env:
#   DATABASE_URL=postgres://user:pass@localhost:5432/missive_clone
#   DATABASE_SSL=false
#   JWT_SECRET=any-random-string

# 3. Install + run
cd ..
npm install            # installs root + backend + frontend
npm run dev:backend    # http://localhost:4000
```

Second terminal:

```powershell
cd C:\Users\PMY\Downloads\missive-clone
npm run dev:frontend   # http://localhost:5173
```

---

## Deploying to Railway (single service)

This repo deploys as **one Railway service**. Express serves both the API and
the built React app on the same domain — no CORS, simple WebSockets.

### Steps

1. Push to GitHub.

2. Railway → *New → Deploy from GitHub Repo* → pick the repo. Railway reads
   [railway.json](railway.json) and runs:
   - Build: `npm install && npm run build`
   - Start: `npm start`
   - Healthcheck: `GET /api/health`

3. *+ New → Database → Postgres*. `DATABASE_URL` is wired automatically.

4. On the web service, *Variables* tab:

   | Key              | Value                                                  |
   | ---------------- | ------------------------------------------------------ |
   | `JWT_SECRET`     | any 32+ char random string                             |
   | `NODE_ENV`       | `production`                                           |
   | `DATABASE_SSL`   | `true`                                                 |
   | `ENCRYPTION_KEY` | (recommended) 32-byte hex; encrypts stored email passwords |

5. *Settings → Networking → Generate Domain*. Open it, sign up, connect a
   mailbox, invite teammates from the sidebar.

### Inviting teammates

1. Sidebar → *Invite teammate* → enter email → copy the generated link.
2. Send the link any way you like (Slack, email, SMS).
3. Recipient opens it, sets a name + password, lands in your workspace.

### Free-tier caveat

Railway free tier sleeps idle services. IMAP IDLE drops while sleeping; the
2-minute polling loop in [backend/src/index.js](backend/src/index.js) catches
up on wake. For continuous push email, use a paid plan.

### Split-origin deploy (advanced)

Frontend on Vercel/Netlify, backend on Railway:

1. Backend env: `CLIENT_ORIGIN=https://your-frontend.example.com`
2. Frontend build: `VITE_API_URL=https://api.example.com` (both `api.js` and
   `socket.js` honor it)

---

## API routes

| Method | Path                                | Notes |
| ------ | ----------------------------------- | ----- |
| GET    | `/api/health`                       | Healthcheck |
| POST   | `/api/auth/signup`                  | New user + workspace |
| POST   | `/api/auth/login`                   | JWT |
| GET    | `/api/auth/me`                      | Current user + workspace |
| GET    | `/api/auth/team`                    | Workspace members |
| GET    | `/api/invites`                      | List pending invites |
| POST   | `/api/invites`                      | `{ email }` → token |
| DELETE | `/api/invites/:id`                  | Revoke |
| GET    | `/api/invites/by-token/:token`      | Public — for the accept page |
| POST   | `/api/invites/accept`               | Public — `{ token, name, password }` |
| GET    | `/api/accounts`                     | List connected mailboxes |
| POST   | `/api/accounts`                     | Connect IMAP+SMTP |
| DELETE | `/api/accounts/:id`                 | Disconnect |
| POST   | `/api/accounts/:id/sync`            | Force sync |
| GET    | `/api/threads?status=&assignee=&q=&folder=` | tsvector full-text via `q`; `folder=SENT` filters to outbound-touched threads |
| GET    | `/api/threads/:id`                  | Thread + messages (with attachments) + comments |
| PATCH  | `/api/threads/:id`                  | Status / assignee |
| POST   | `/api/threads/:id/reply`            | **multipart/form-data**: `payload` (JSON) + `files[]` |
| POST   | `/api/threads/:id/comments`         | Internal comment |
| GET    | `/api/attachments/:id`              | Auth-protected binary download |
| GET    | `/api/canned`                       | List canned responses |
| POST   | `/api/canned`                       | Create |
| DELETE | `/api/canned/:id`                   | Delete |
| GET    | `/api/drafts/:threadId`             | Load this user's draft for a thread |
| PUT    | `/api/drafts/:threadId`             | Save (or delete if empty) draft |
| DELETE | `/api/drafts/:threadId`             | Discard draft |
| GET    | `/api/chat?before=<ts>`             | List recent team-chat messages (paginated) |
| POST   | `/api/chat`                         | Post a team-chat message |

### Socket.io events (server → client, room = `ws:<workspace_id>`)

- `thread:updated` — `{ thread_id }`
- `message:new` — `{ thread_id, message_id }`
- `comment:new` — `{ thread_id, id }`
- `chat:new` — `{ id, user_id, user_name, body, created_at, ... }` (full row)

---

## Database schema

Defined in [backend/src/db.js](backend/src/db.js) — `CREATE TABLE IF NOT
EXISTS`, plus idempotent `ALTER TABLE` migrations. All tables run once on
boot.

- **workspaces** `(id, name, created_at)`
- **users** `(id, workspace_id, email UNIQUE, password_hash, name, created_at)`
- **invites** `(id, workspace_id, invited_by, email, token UNIQUE,
  accepted_at, created_at, expires_at)`
- **email_accounts** `(id, workspace_id, user_id, email, display_name,
  imap_*, smtp_*, sent_folder, last_synced_at, created_at)`
- **folder_sync_state** `(account_id, folder, last_sync_uid)` — per-folder
  UID watermark; INBOX and Sent are tracked separately.
- **threads** `(id, workspace_id, subject, participants, last_message_at,
  status, assignee_id, message_id_root, search_text, created_at)` — the
  GIN-indexed `to_tsvector('simple', search_text)` powers `?q=` full-text
  search.
- **messages** `(id, thread_id, account_id, workspace_id, direction
  (inbound|outbound), folder, message_id, in_reply_to, subject, from_addr,
  to_addrs, cc_addrs, body_text, body_html, sent_at, imap_uid,
  has_attachments, created_at)`
- **attachments** `(id, message_id, workspace_id, filename, content_type,
  size_bytes, content_id, data BYTEA, created_at)`
- **comments** `(id, thread_id, workspace_id, user_id, body, mentions JSON,
  created_at)`
- **canned_responses** `(id, workspace_id, user_id, title, body_text,
  body_html, created_at)`
- **drafts** `(user_id, thread_id PK, workspace_id, account_id, body_text,
  body_html, to_addrs, cc_addrs, subject, updated_at)` — composer autosaves
  debounced 700ms; cleared on successful send.
- **chat_messages** `(id, workspace_id, user_id, body, mentions JSON,
  created_at)` — workspace-wide team chat.

---

## OAuth notes (deliberately not implemented)

Google/Microsoft OAuth needs setup that only **you** can do — registering an
OAuth app in Google Cloud Console / Azure AD, copying the client ID and
secret, configuring authorized redirect URIs, and (for Google) going through
verification if the app is public. Putting half-working OAuth code in the
repo would just break the moment someone tried to use it.

If you want to add it later, the path is:

1. Register an OAuth client. Scopes you need:
   - Google: `https://mail.google.com/`
   - Microsoft: `IMAP.AccessAsUser.All`, `SMTP.Send`
2. Implement an `/api/oauth/<provider>/start` redirect and `/callback`
   exchange. Store `refresh_token` on the `email_accounts` row.
3. Replace the `auth: { user, pass }` field in
   [backend/src/email/imap.js](backend/src/email/imap.js) and
   [backend/src/email/smtp.js](backend/src/email/smtp.js) with
   `auth: { user, accessToken }` (XOAUTH2). Refresh the token before each
   sync if expired.

For now: **users connect with App Passwords** (Gmail and Outlook with 2FA on
both support this) or any provider that supports plain IMAP login.

---

## Limitations still in this MVP

1. **One workspace per signup.** New signups create a new workspace; to
   join an existing one, use the invite flow.
2. **Drafts and Spam folders** are not synced (only INBOX + Sent).
3. **No labels / Gmail labels.** Folder is a flat string per message.
4. **No per-user read state.** Status is whole-thread.
5. **@mentions are recorded but not yet notified** (the `mentions` array is
   stored on each comment; sending notifications is not wired up).
6. **No rate limiting / CSRF.** The API trusts the bearer token; behind a
   single-origin deploy this is fine, but for a public product you'd add
   rate limits.
7. **Attachments stored as `bytea`** in Postgres. Fine up to a few GB total;
   if you grow past that, move to S3 / Cloudflare R2.
8. **Inbound HTML is sanitized with DOMPurify** but still rendered inline.
   For maximum isolation, render in a sandboxed iframe with `srcdoc`.
9. **In-process IMAP IDLE** — fine for one Railway instance. To scale,
   move sync to a worker behind a queue (BullMQ + Redis).
10. **No OAuth** — see above. Use App Passwords.

---

## What to build next

1. OAuth for Google and Microsoft (replaces App Passwords).
2. Notify mentioned users (in-app toast + optional email).
3. Drafts folder + autosave drafts in the composer.
4. Labels / categories.
5. Iframe sandbox for inbound HTML.
6. S3/R2 attachment storage with signed URLs.
7. Worker-based sync (BullMQ + Redis) for horizontal scaling.
8. Per-user read state.
9. Snooze, scheduled send, follow-up reminders.
