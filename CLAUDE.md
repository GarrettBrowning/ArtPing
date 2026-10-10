# ArtPing

Art sharing site: Node.js + Express 5 + MongoDB (Mongoose) + plain HTML/CSS/JS (no framework, no build step).

**Start every session by reading `NOTES.md`** (private, gitignored): current status, deploy checklist, ideas.
Keep `NOTES.md` up to date when work is finished.

## Run
- `npm run server`: dev with auto-restart (nodemon). `rs` + Enter restarts; `.env` changes need a restart.
- Needs local MongoDB at `mongodb://localhost:27017/ArtPing` and `SESSION_SECRET` in `.env` (see `.env.example`).
- App: http://localhost:3000

## Layout
- `server.js`: everything server-side (models, routes, middleware). Models: User, Post, Profile, Like, Follow, Comment, Report.
- `public/*.html`: one page each, with its own inline `<script>`. Shared: `public/nav.js` (sign-in state, logout, `showToast`, `showLoginNeeded`), `public/posts.js` (post cards, post popup with comments, likes, reports, `escapeHtml`, `timeAgo`, `confirmAction`, edit-post form), `public/style.css`.
- Account pages: `register.html`, `login.html`, `forgot-password.html`, `reset-password.html`, `settings.html` (logged-in password change; more settings later). `public/password-rules.js` = live password checklist.
- `public/reports.html`: admin review of reports. Admins = `ADMIN_USERNAMES` env var (comma-separated).
- `public/uploads/`: uploaded images (gitignored).

## Conventions
- **Confirmations:** use `await confirmAction({ title, message, confirmLabel })` from `posts.js`, never the browser's `confirm()`.
- **User-facing messages** start with "Sorry, ..." and never show internal details. Server: use `MSG.*` and `serverError(res, label, error)` (logs the real error, sends a friendly 500). Logged-out actions: `isAuthenticated` sends `MSG.loginRequired`; pages call `showLoginNeeded(res)` instead of redirecting.
- **Password rules** live in two places that must match: `passwordProblem()` in `server.js` and `PASSWORD_RULES` in `public/password-rules.js`.
- **Uploads** go through `receiveImage()` + `saveImage()` (sharp): content-based type check, re-encode (strips EXIF/GPS), random UUID names. Never save `req.file` directly.
- **Password changes** bump `User.sessionVersion`; a middleware logs out sessions with an older version.
- **Escape user content** before inserting HTML: use `escapeHtml` from `posts.js`. Prefer `textContent`.
- Post cards everywhere come from `renderPostCard(post)` in `posts.js`; server adds card fields with `decoratePosts()`.
- **Nav / sign-in state:** `nav.js` sets `<html data-auth="in|out">`; use classes `show-signed-in` / `show-signed-out`. Pages get the username via `await window.authReady`. Logout is handled in `nav.js`.
- **Config** comes from env vars: `SESSION_SECRET` (required), `MONGODB_URI`, `PORT`, `NODE_ENV`, `ADMIN_USERNAMES`, `APP_URL`, `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`/`MAIL_FROM` (without SMTP, reset links print in the terminal).
- Likes, follows and reports are separate collections with unique compound indexes. `Post.likeCount` / `Post.commentCount` are kept in sync with `$inc`.
- Admin "remove" hard-deletes via `deletePostAndRelated()` / `deleteComment()` (also closes their reports, deletes the image file).
- Feed (`/api/feed`): `sort=new` uses a `createdAt_id` cursor; `sort=hot` (shown as "Trending") uses page numbers.
- CSS colors and spacing come from the variables in `:root` in `style.css`.

## Gotchas
- **Never run `npm audit fix --force`**: it downgrades nodemon to v1. The remaining audit warnings are dev-only (nodemon).
- Login, register, uploads, comments, reports and password reset are rate-limited per IP, in memory; restarting the server resets the counters. Register counts only successful sign-ups.
- On Windows, `sharp` keeps files open by default; in scripts that read upload files, read them with `fs.readFileSync` first (or `sharp.cache(false)`), or deleting them fails.
- The user commits and pushes themselves; give them the commands instead of committing.
- The user often has `npm run server` (nodemon) running on port 3000; test on another port (e.g. `PORT=3001`) and never stop their server.
- The user is on Windows. Git Bash mangles args starting with `/` (use `MSYS_NO_PATHCONV=1`).
