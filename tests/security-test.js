// ArtPing security & behavior tests.
//
// Run with:  npm run test:security
//
// What it does:
//   1. Starts a private copy of the server on port 3099 using a separate database (ArtPing_test),
//      so your real data and your own running server are never touched.
//   2. Creates test accounts and runs every check below against the real API.
//   3. Shuts the server down, deletes the test database and the temporary folder its images went to.
//
// Needs MongoDB running locally. Exit code is 0 when everything passes, 1 otherwise.

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const mongoose = require('mongoose');
const sharp = require('sharp');

sharp.cache(false); // don't keep image files open (Windows can't delete open files)

const ROOT = path.join(__dirname, '..');
// Uploads go to a temporary folder outside the app (like a host's persistent disk), never public/uploads
const UPLOADS = fs.mkdtempSync(path.join(os.tmpdir(), 'artping-test-uploads-'));
const PORT = 3099;
const BASE = `http://localhost:${PORT}`;
const TEST_DB = 'ArtPing_test';
const MONGO_URI = `mongodb://localhost:27017/${TEST_DB}`;
const ADMIN = 'sec_admin';
const createdFiles = new Set(); // images this run uploaded, deleted at the end

// ===== Tiny test framework =====
let passed = 0;
const failures = [];
let section = '';
function group(name) {
  section = name;
  console.log(`\n== ${name}`);
}
function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(`[${section}] ${name}${detail ? ` -> ${detail}` : ''}`);
    console.log(`  FAIL  ${name}${detail ? `  -> ${detail}` : ''}`);
  }
}

// ===== HTTP client that keeps its own login cookie =====
function client() {
  let cookie = '';
  async function req(method, url, body, { raw, headers = {} } = {}) {
    const opts = { method, headers: { ...headers }, redirect: 'manual' };
    if (cookie) opts.headers.cookie = cookie;
    if (raw !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = raw;
    } else if (body instanceof FormData) {
      opts.body = body;
    } else if (body !== undefined && body !== null) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(BASE + url, opts);
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (json && json.post && json.post.filename) createdFiles.add(json.post.filename);
    if (json && json.pfp) createdFiles.add(path.basename(json.pfp));
    return { status: res.status, text, json, headers: res.headers, setCookie };
  }
  return {
    req,
    get cookie() { return cookie; },
    login: (username, password) => req('POST', '/api/login', { username, password }),
  };
}

function imageForm(buffer, filename, type, fields = {}, field = 'image') {
  const form = new FormData();
  if (buffer) form.append(field, new Blob([buffer], { type }), filename);
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return form;
}

const solid = (w, h, color) => sharp({ create: { width: w, height: h, channels: 3, background: color } });
const strongPassword = (tag) => `Sec-${tag}-${crypto.randomBytes(3).toString('hex')}9!`;
const fakeId = '000000000000000000000000';

// ===== Server lifecycle =====
let server;
let serverLog = '';

function portIsFree(port) {
  return new Promise(resolve => {
    const tester = net.createServer()
      .once('error', () => resolve(false))
      .once('listening', () => tester.close(() => resolve(true)))
      .listen(port);
  });
}

async function startServer() {
  if (!await portIsFree(PORT)) throw new Error(`Port ${PORT} is busy. Stop whatever is using it and try again.`);
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      MONGODB_URI: MONGO_URI,
      SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
      TRUST_PROXY: 'loopback', // lets the test fake visitor IPs with X-Forwarded-For
      APP_URL: BASE,
      UPLOAD_DIR: UPLOADS,
      NODE_ENV: 'test',
      SMTP_HOST: '', // forces reset links to be printed so the test can read them
    },
  });
  server.stdout.on('data', d => { serverLog += d; });
  server.stderr.on('data', d => { serverLog += d; });
  for (let i = 0; i < 60; i++) {
    if (serverLog.includes('Connected to MongoDB') && serverLog.includes('listening')) return;
    if (server.exitCode !== null) throw new Error(`Server exited early:\n${serverLog}`);
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`Server did not start in time:\n${serverLog}`);
}

function resetLinkFor(username) {
  const lines = serverLog.split('\n');
  const i = lines.map(l => l.includes(`here is ${username}'s reset link`)).lastIndexOf(true);
  return i >= 0 ? lines[i + 1].trim() : null;
}

async function cleanUp() {
  if (server && server.exitCode === null) server.kill();
  for (const file of createdFiles) {
    fs.promises.unlink(path.join(UPLOADS, path.basename(file))).catch(() => {});
  }
  if (server) await new Promise(r => server.exitCode !== null ? r() : server.once('exit', r)); // Windows can't delete a folder the server still uses
  fs.rmSync(UPLOADS, { recursive: true, force: true }); // the whole temporary folder
  if (mongoose.connection.readyState === 1 && mongoose.connection.name === TEST_DB) {
    await mongoose.connection.dropDatabase(); // only ever the _test database
  }
  await mongoose.disconnect().catch(() => {});
}

// ===== The tests =====
async function run() {
  await mongoose.connect(MONGO_URI);
  await mongoose.connection.dropDatabase(); // start from an empty test database
  await startServer();
  const db = mongoose.connection.db;

  const anon = client();
  const owner = client();   // posts art
  const other = client();   // a regular second user
  const admin = client();
  const ownerPhone = client(); // the owner's second device
  const users = {
    owner: { name: 'sec_owner', pw: strongPassword('o') },
    other: { name: 'sec_other', pw: strongPassword('t') },
    admin: { name: ADMIN, pw: strongPassword('a') },
  };

  // ---------------------------------------------------------------
  group('Every state-changing route requires login');
  // Reads server.js so any route added later is checked automatically
  const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const PUBLIC_WRITE_ROUTES = new Set([
    'POST /api/register', 'POST /api/login', 'POST /api/logout',
    'POST /api/password/forgot', 'POST /api/password/reset',
  ]);
  const routes = [...source.matchAll(/app\.(post|put|delete)\(\s*['"]([^'"]+)['"]/g)]
    .map(m => [m[1].toUpperCase(), m[2]]);
  check('found the routes in server.js', routes.length >= 15, `found ${routes.length}`);
  for (const [method, route] of routes) {
    if (PUBLIC_WRITE_ROUTES.has(`${method} ${route}`)) continue;
    const url = route.replace(/:id/g, fakeId).replace(/:username/g, 'sec_owner');
    const r = await anon.req(method, url, method === 'GET' ? undefined : {});
    check(`${method} ${route} rejects logged-out users`, r.status === 401 || r.status === 403, `got ${r.status}`);
  }
  const adminOnly = [['GET', '/api/admin/reports'], ['POST', '/api/admin/reports/resolve']];

  // ---------------------------------------------------------------
  group('Registration and password rules');
  const register = (name, pw, email = `${name}@example.test`) =>
    anon.req('POST', '/api/register', { email, username: name, password: pw });
  const weak = [
    ['Ab1!', 'at least 8 characters'],
    ['alllowercase1!', 'an uppercase letter'],
    ['ALLUPPERCASE1!', 'a lowercase letter'],
    ['NoNumbers!!', 'a number'],
    ['NoSpecial123', 'a special character'],
  ];
  for (const [pw, needs] of weak) {
    const r = await register('sec_weak', pw);
    check(`rejects "${pw}" (needs ${needs})`, r.status === 400 && r.text.includes(needs), r.text);
  }
  check('rejects passwords over 72 bytes', (await register('sec_weak', `Aa1!${'x'.repeat(70)}`)).text.includes('too long'));
  check('rejects invalid email', (await register('sec_weak', users.owner.pw, 'not-an-email')).status === 400);
  check('rejects non-text fields (NoSQL injection)', (await anon.req('POST', '/api/register',
    { email: { $gt: '' }, username: 'x', password: users.owner.pw })).status === 400);
  for (const [key, u] of Object.entries(users)) {
    const r = await register(u.name, u.pw);
    check(`registers ${key} with a strong password`, r.status === 200, r.text);
  }
  check('duplicate username has a friendly message',
    (await register(users.owner.name, users.owner.pw, 'x@example.test')).text.includes('username is already taken'));
  check('duplicate email has a friendly message (case-insensitive)',
    (await register('sec_dupe', users.owner.pw, 'SEC_OWNER@Example.test')).text.includes('email already exists'));
  const ownerDoc = await db.collection('users').findOne({ username: users.owner.name });
  check('passwords are stored hashed (bcrypt), never plain', ownerDoc.password.startsWith('$2') && ownerDoc.password !== users.owner.pw);
  check('server log never contains a password', !serverLog.includes(users.owner.pw) && !serverLog.includes(ownerDoc.password));

  // ---------------------------------------------------------------
  group('Login and sessions');
  const wrongPw = await anon.login(users.owner.name, 'Wrong-pass1!');
  const noUser = await anon.login('nobody_here', 'Wrong-pass1!');
  check('same message for wrong password and unknown user (no account discovery)',
    wrongPw.status === 401 && noUser.status === 401 && wrongPw.text === noUser.text);
  check('rejects object username (NoSQL injection)', (await anon.req('POST', '/api/login',
    { username: { $gt: '' }, password: { $gt: '' } })).status === 400);
  const ownerLogin = await owner.login(users.owner.name, users.owner.pw);
  check('login works', ownerLogin.status === 200);
  const cookieFlags = ownerLogin.setCookie || '';
  check('session cookie is HttpOnly', /HttpOnly/i.test(cookieFlags), cookieFlags);
  check('session cookie is SameSite=Lax or Strict', /SameSite=(Lax|Strict)/i.test(cookieFlags), cookieFlags);
  const firstSession = owner.cookie;
  await owner.login(users.owner.name, users.owner.pw);
  check('logging in issues a new session ID (session fixation)', owner.cookie !== firstSession);
  await other.login(users.other.name, users.other.pw);
  await admin.login(users.admin.name, users.admin.pw);
  check('registering a username never makes you admin', (await admin.req('GET', '/api/me')).json.isAdmin === false);
  await db.collection('users').updateOne({ username: ADMIN }, { $set: { isAdmin: true } }); // what `npm run admin -- grant` does
  await ownerPhone.login(users.owner.name, users.owner.pw);
  check('/api/me reports admin status correctly',
    (await admin.req('GET', '/api/me')).json.isAdmin === true && (await other.req('GET', '/api/me')).json.isAdmin === false);
  for (const [method, url] of adminOnly) {
    check(`${method} ${url} refuses non-admins`, (await other.req(method, url, method === 'POST' ? {} : undefined)).status === 403);
  }
  const logoutClient = client();
  await logoutClient.login(users.other.name, users.other.pw);
  await logoutClient.req('POST', '/api/logout');
  check('logout ends the session', (await logoutClient.req('GET', '/api/me')).json.username === null);

  // ---------------------------------------------------------------
  group('Friendly errors and safe responses');
  const r401 = await anon.req('POST', '/api/posts/' + fakeId + '/like');
  check('logged-out message is friendly', r401.text === 'Sorry, you must be logged in to use this feature.', r401.text);
  const badJson = await anon.req('POST', '/api/login', null, { raw: '{broken' });
  check('broken JSON gets a friendly 400, no stack trace', badJson.status === 400 && badJson.text.startsWith('Sorry') && !/\n\s+at /.test(badJson.text));
  check('unknown API route gets a friendly 404', (await anon.req('GET', '/api/does-not-exist')).text.startsWith('Sorry'));
  const page404 = await anon.req('GET', '/no-such-page');
  check('unknown page gets the 404 page', page404.status === 404 && page404.text.includes("couldn't find that page"));
  check('X-Content-Type-Options: nosniff on every response', page404.headers.get('x-content-type-options') === 'nosniff'
    && (await anon.req('GET', '/style.css')).headers.get('x-content-type-options') === 'nosniff');
  check('malformed ids give 404, not a crash', (await anon.req('GET', '/api/posts/not-an-id/comments')).status === 404);
  check('huge JSON body is refused', (await anon.req('POST', '/api/login', null, { raw: JSON.stringify({ username: 'x'.repeat(200000), password: 'y' }) })).status === 413);
  check('path traversal cannot read server files', !(await anon.req('GET', '/..%2fserver.js')).text.includes('require('));
  check('.env is not served', !(await anon.req('GET', '/.env')).text.includes('SESSION_SECRET'));

  // ---------------------------------------------------------------
  group('Uploads');
  const jpgWithGps = await solid(320, 200, '#c33').jpeg()
    .withExif({ IFD0: { Artist: 'Secret Name' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '40/1 26/1 46/1' } }).toBuffer();
  const png = await solid(64, 64, '#36c').png().toBuffer();
  const upload = (c, buffer, filename, type, fields = { title: 'Sec test' }) =>
    c.req('POST', '/api/upload', imageForm(buffer, filename, type, fields));

  const up = await upload(owner, jpgWithGps, 'photo.jpg', 'image/jpeg', { title: '  Sec post  ', description: ' about it ' });
  check('JPEG upload works', up.status === 200, up.text.slice(0, 100));
  const post = up.json && up.json.post;
  check('stored under a random name', post && /^[0-9a-f-]{36}\.jpg$/.test(post.filename), post && post.filename);
  const savedMeta = await sharp(fs.readFileSync(path.join(UPLOADS, post.filename))).metadata();
  check('hidden data (EXIF / GPS location) is removed', !savedMeta.exif);
  const served = await fetch(BASE + post.filepath);
  check('images saved in UPLOAD_DIR are served at /uploads/ with the AI opt-out header', served.status === 200
    && /image\/jpeg/.test(served.headers.get('content-type') || '') && served.headers.get('x-robots-tag') === 'noai, noimageai');
  check('uploads go to UPLOAD_DIR, not the app folder', !fs.existsSync(path.join(ROOT, 'public', 'uploads', post.filename)));
  check('title and description are trimmed', post.title === 'Sec post' && post.description === 'about it');
  const renamed = await upload(owner, png, 'sneaky.jpg', 'image/jpeg');
  check('real format wins over the file name (PNG named .jpg saved as .png)', renamed.json && renamed.json.post.filename.endsWith('.png'));
  const frame = c => solid(20, 20, c).png().toBuffer();
  const gif = await sharp([await frame('#f00'), await frame('#0f0')], { join: { animated: true } }).gif().toBuffer();
  const gifUp = await upload(owner, gif, 'a.gif', 'image/gif');
  const gifPages = gifUp.json ? (await sharp(fs.readFileSync(path.join(UPLOADS, gifUp.json.post.filename)), { animated: true }).metadata()).pages : 0;
  check('animated GIFs stay animated', gifPages === 2, `pages=${gifPages}`);
  check('rejects a text file renamed .png', (await upload(owner, Buffer.from('<script>alert(1)</script>'), 'x.png', 'image/png')).text.includes("isn't a valid image"));
  check('rejects HTML disguised as an image', (await upload(owner, Buffer.from('<!DOCTYPE html><html><script>alert(1)</script></html>'), 'x.jpg', 'image/jpeg')).status === 400);
  // SVGs can contain scripts. A readable SVG is refused by format; an unreadable one as "not a valid image".
  check('rejects SVG (can contain scripts)', (await upload(owner, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script><rect width="10" height="10"/></svg>'), 'x.svg', 'image/svg+xml')).text.includes('only JPG'));
  check('rejects SVG without a size', (await upload(owner, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'x.svg', 'image/svg+xml')).status === 400);
  check('rejects TIFF', (await upload(owner, await solid(8, 8, '#000').tiff().toBuffer(), 'x.tif', 'image/tiff')).text.includes('only JPG'));
  const huge = await solid(10000, 6000, '#fff').png({ compressionLevel: 9 }).toBuffer();
  check('rejects images over 50 megapixels', (await upload(owner, huge, 'big.png', 'image/png')).text.includes('50 megapixels'));
  check('rejects files over 10 MB', (await upload(owner, Buffer.concat([png, Buffer.alloc(11 * 1024 * 1024)]), 'big.png', 'image/png')).status === 413);
  check('requires a title', (await upload(owner, png, 'a.png', 'image/png', { title: '   ' })).status === 400);
  check('limits title to 100 characters', (await upload(owner, png, 'a.png', 'image/png', { title: 'x'.repeat(101) })).status === 400);
  check('limits description to 1000 characters', (await upload(owner, png, 'a.png', 'image/png', { title: 't', description: 'x'.repeat(1001) })).status === 400);
  check('rejects two files in one upload', await (async () => {
    const form = imageForm(png, 'a.png', 'image/png', { title: 't' });
    form.append('image', new Blob([png], { type: 'image/png' }), 'b.png');
    return (await owner.req('POST', '/api/upload', form)).status === 400;
  })());
  const pfp1 = await owner.req('POST', '/api/profile/pfp', imageForm(jpgWithGps, 'me.jpg', 'image/jpeg', {}, 'pfp'));
  const pfpMeta = pfp1.json ? await sharp(fs.readFileSync(path.join(UPLOADS, path.basename(pfp1.json.pfp)))).metadata() : {};
  check('profile picture becomes a 512x512 WebP without hidden data', pfpMeta.format === 'webp' && pfpMeta.width === 512 && pfpMeta.height === 512 && !pfpMeta.exif);
  const pfp2 = await owner.req('POST', '/api/profile/pfp', imageForm(png, 'me2.png', 'image/png', {}, 'pfp'));
  await new Promise(r => setTimeout(r, 300));
  check('replacing a profile picture deletes the old file', pfp2.status === 200 && !fs.existsSync(path.join(UPLOADS, path.basename(pfp1.json.pfp))));

  // ---------------------------------------------------------------
  group('Posts: edit and delete permissions');
  const edit = (c, id, body) => c.req('PUT', `/api/posts/${id}`, body);
  check('owner can edit title and description', (await edit(owner, post._id, { title: 'Edited', description: 'New' })).json.title === 'Edited');
  check('other users cannot edit (403)', (await edit(other, post._id, { title: 'hacked' })).status === 403);
  check('admins cannot edit other people\'s posts', (await edit(admin, post._id, { title: 'hacked' })).status === 403);
  await edit(owner, post._id, { title: 'Edited', filepath: '/evil.png', userId: fakeId, likeCount: 999, username: 'someone' });
  const afterEdit = await db.collection('posts').findOne({ _id: new mongoose.Types.ObjectId(post._id) });
  check('edit cannot change any other field (mass assignment)', afterEdit.filepath === post.filepath && afterEdit.likeCount === 0
    && afterEdit.username === users.owner.name && String(afterEdit.userId) === String(ownerDoc._id));
  check('edit rejects object title (NoSQL injection)', (await edit(owner, post._id, { title: { $gt: '' } })).status === 400);
  check('other users cannot delete (403)', (await other.req('DELETE', `/api/posts/${renamed.json.post._id}`)).status === 403);
  const ownerFeedView = (await owner.req('GET', '/api/posts/sec_owner')).json.posts;
  const otherFeedView = (await other.req('GET', '/api/posts/sec_owner')).json.posts;
  check('canDelete is only true for the owner (and admins)', ownerFeedView.every(p => p.canDelete) && otherFeedView.every(p => !p.canDelete)
    && (await admin.req('GET', '/api/posts/sec_owner')).json.posts.every(p => p.canDelete));

  // ---------------------------------------------------------------
  group('Likes');
  const likeUrl = `/api/posts/${post._id}/like`;
  await Promise.all(Array.from({ length: 10 }, () => other.req('POST', likeUrl)));
  check('10 simultaneous likes from one user count once (race condition)', (await other.req('POST', likeUrl)).json.likeCount === 1);
  await other.req('DELETE', likeUrl);
  check('unliking twice never goes below zero', (await other.req('DELETE', likeUrl)).json.likeCount === 0);
  await other.req('POST', likeUrl);
  check('likedByMe is per user', (await other.req('GET', '/api/posts/sec_owner')).json.posts.find(p => p._id === post._id).likedByMe === true
    && (await owner.req('GET', '/api/posts/sec_owner')).json.posts.find(p => p._id === post._id).likedByMe === false);

  // ---------------------------------------------------------------
  group('Comments');
  const commentsUrl = `/api/posts/${post._id}/comments`;
  check('rejects empty comments', (await other.req('POST', commentsUrl, { text: '   ' })).status === 400);
  check('rejects comments over 500 characters', (await other.req('POST', commentsUrl, { text: 'x'.repeat(501) })).status === 400);
  check('rejects non-text comments', (await other.req('POST', commentsUrl, { text: { $gt: '' } })).status === 400);
  const xss = '<img src=x onerror=alert(1)>';
  const c1 = await other.req('POST', commentsUrl, { text: xss });
  check('stores comment text as-is (pages escape it when showing)', c1.json && c1.json.comment.text === xss);
  const c2 = await admin.req('POST', commentsUrl, { text: 'admin says hi' });
  check('comment count stays in sync', c2.json.commentCount === 2);
  check('cannot delete someone else\'s comment', (await other.req('DELETE', `/api/comments/${c2.json.comment._id}`)).status === 403);
  check('post owner can delete any comment on their post', (await owner.req('DELETE', `/api/comments/${c2.json.comment._id}`)).json.commentCount === 1);
  const pageIds = [];
  for (let i = 0; i < 3; i++) await other.req('POST', commentsUrl, { text: `page test ${i}` });
  let cursor = null;
  do {
    const r = (await anon.req('GET', `${commentsUrl}?limit=1${cursor ? `&cursor=${cursor}` : ''}`)).json;
    pageIds.push(...r.comments.map(c => c._id));
    cursor = r.nextCursor;
  } while (cursor);
  check('comment paging returns each comment once', pageIds.length === 4 && new Set(pageIds).size === 4);

  // ---------------------------------------------------------------
  group('Follows');
  check('cannot follow yourself', (await owner.req('POST', '/api/users/sec_owner/follow')).status === 400);
  await Promise.all(Array.from({ length: 5 }, () => other.req('POST', '/api/users/sec_owner/follow')));
  check('simultaneous follows count once', (await other.req('POST', '/api/users/sec_owner/follow')).json.followerCount === 1);
  check('following feed only shows followed users', (await other.req('GET', '/api/feed?scope=following')).json.posts.every(p => p.username === 'sec_owner'));
  check('following feed requires login', (await anon.req('GET', '/api/feed?scope=following')).status === 401);

  // ---------------------------------------------------------------
  group('Feed');
  for (let i = 0; i < 4; i++) await upload(owner, png, `f${i}.png`, 'image/png', { title: `feed ${i}` });
  for (const sort of ['new', 'hot']) {
    const ids = [];
    let next = null;
    do {
      const r = (await anon.req('GET', `/api/feed?sort=${sort}&limit=2${next ? `&cursor=${encodeURIComponent(next)}` : ''}`)).json;
      ids.push(...r.posts.map(p => p._id));
      next = r.nextCursor;
    } while (next);
    check(`${sort} feed paging returns each post once`, ids.length >= 7 && new Set(ids).size === ids.length, `${ids.length} posts`);
  }
  check('bad feed cursor gets a friendly 400', (await anon.req('GET', '/api/feed?cursor=garbage')).status === 400);
  const feedPost = (await anon.req('GET', '/api/feed')).json.posts[0];
  check('feed never exposes private fields', !('password' in feedPost) && !('email' in feedPost) && !('filename' in feedPost));
  check('profile never exposes email or password', !/email|password/.test((await anon.req('GET', '/api/profile/sec_owner')).text));

  // ---------------------------------------------------------------
  group('Reports and admin');
  const report = (c, body) => c.req('POST', '/api/reports', body);
  check('cannot report your own post', (await report(owner, { targetType: 'post', targetId: post._id, reason: 'spam' })).status === 400);
  check('rejects unknown reasons', (await report(other, { targetType: 'post', targetId: post._id, reason: 'nope' })).status === 400);
  check('rejects unknown target types', (await report(other, { targetType: 'user', targetId: post._id, reason: 'spam' })).status === 400);
  check('rejects object target ids', (await report(other, { targetType: 'post', targetId: { $gt: '' }, reason: 'spam' })).status === 400);
  check('report works', (await report(other, { targetType: 'post', targetId: post._id, reason: 'stolen', details: '<b>mine</b>' })).status === 200);
  check('one report per person per item', (await report(other, { targetType: 'post', targetId: post._id, reason: 'spam' })).status === 409);
  check('admin sees the report', (await admin.req('GET', '/api/admin/reports')).json.some(g => g.targetId === post._id));
  const fileBefore = path.join(UPLOADS, post.filename);
  check('admin can remove reported content',
    (await admin.req('POST', '/api/admin/reports/resolve', { targetType: 'post', targetId: post._id, action: 'remove' })).status === 200);
  await new Promise(r => setTimeout(r, 300));
  const postId = new mongoose.Types.ObjectId(post._id);
  check('removal deletes the post, its likes, comments and image', !await db.collection('posts').findOne({ _id: postId })
    && !await db.collection('likes').findOne({ postId }) && !await db.collection('comments').findOne({ postId }) && !fs.existsSync(fileBefore));
  check('removal closes the reports', !(await admin.req('GET', '/api/admin/reports')).json.some(g => g.targetId === post._id));

  // ---------------------------------------------------------------
  group('Changing your password (Settings)');
  const change = (c, cur, next) => c.req('POST', '/api/account/password', { currentPassword: cur, newPassword: next });
  const newOwnerPw = strongPassword('n');
  check('requires the current password', (await change(owner, 'Wrong-pass1!', newOwnerPw)).status === 401);
  check('new password must follow the rules', (await change(owner, users.owner.pw, 'weak')).status === 400);
  check('new password must be different', (await change(owner, users.owner.pw, users.owner.pw)).status === 400);
  check('change works', (await change(owner, users.owner.pw, newOwnerPw)).status === 200);
  check('this device stays logged in', (await owner.req('GET', '/api/me')).json.username === users.owner.name);
  check('other devices are logged out', (await ownerPhone.req('GET', '/api/me')).json.username === null);
  check('old password stops working', (await anon.login(users.owner.name, users.owner.pw)).status === 401);
  users.owner.pw = newOwnerPw;

  // ---------------------------------------------------------------
  group('Password reset by email');
  const forgot = email => anon.req('POST', '/api/password/forgot', { email });
  const unknown = await forgot('nobody@example.test');
  const known = await forgot('SEC_OWNER@example.test');
  check('same answer whether or not the email has an account', unknown.status === 200 && known.status === 200 && unknown.json.message === known.json.message);
  await new Promise(r => setTimeout(r, 300));
  const link = resetLinkFor(users.owner.name);
  const token = link && new URL(link).searchParams.get('token');
  check('reset link is created (printed when email is not set up)', !!token);
  const stored = await db.collection('users').findOne({ username: users.owner.name });
  check('only a hash of the reset token is stored', stored.resetTokenHash && !JSON.stringify(stored).includes(token));
  const resetPw = (t, pw) => anon.req('POST', '/api/password/reset', { token: t, password: pw });
  check('rejects a made-up token', (await resetPw('f'.repeat(64), strongPassword('x'))).status === 400);
  check('rejects a non-text token', (await anon.req('POST', '/api/password/reset', { token: { $ne: null }, password: strongPassword('x') })).status === 400);
  check('reset still enforces password rules', (await resetPw(token, 'weak')).status === 400);
  const resetTo = strongPassword('r');
  check('reset works with the emailed link', (await resetPw(token, resetTo)).status === 200);
  check('the link works only once', (await resetPw(token, strongPassword('y'))).status === 400);
  check('reset logs out every session', (await owner.req('GET', '/api/me')).json.username === null);
  check('can log in with the new password', (await owner.login(users.owner.name, resetTo)).status === 200);
  await forgot('sec_owner@example.test');
  await new Promise(r => setTimeout(r, 300));
  const token2 = new URL(resetLinkFor(users.owner.name)).searchParams.get('token');
  await db.collection('users').updateOne({ username: users.owner.name }, { $set: { resetTokenExpires: new Date(Date.now() - 1000) } });
  check('expired links are rejected', (await resetPw(token2, strongPassword('z'))).status === 400);

  // ---------------------------------------------------------------
  group('Audit fixes: headers, scripts and cross-site requests');
  const pageRes = await anon.req('GET', '/feed.html');
  const csp = pageRes.headers.get('content-security-policy') || '';
  check('Content-Security-Policy blocks inline scripts', /script-src 'self'(;|$)/.test(csp) && !/script-src[^;]*unsafe-inline/.test(csp), csp);
  check('CSP forbids other sites from framing pages', csp.includes("frame-ancestors 'none'"));
  check('X-Frame-Options: DENY', pageRes.headers.get('x-frame-options') === 'DENY');
  check('Referrer-Policy is set', !!pageRes.headers.get('referrer-policy'));
  check('X-Powered-By is not sent', !pageRes.headers.get('x-powered-by'));
  const htmlFiles = fs.readdirSync(path.join(ROOT, 'public')).filter(f => f.endsWith('.html'));
  const inlineProblems = htmlFiles.filter(f => {
    const html = fs.readFileSync(path.join(ROOT, 'public', f), 'utf8');
    return /<script(?![^>]*\ssrc=)[^>]*>/i.test(html) || /\son[a-z]+\s*=\s*["']/i.test(html);
  });
  check('no page has inline scripts or onclick-style handlers (CSP compatible)', inlineProblems.length === 0, inlineProblems.join(', '));
  for (const f of fs.readdirSync(path.join(ROOT, 'public', 'js'))) {
    check(`page script js/${f} is served`, (await anon.req('GET', `/js/${f}`)).status === 200);
  }
  const formLogin = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `username=${users.other.name}&password=${encodeURIComponent(users.other.pw)}`,
  });
  check('classic HTML form posts are not accepted (login CSRF)', formLogin.status === 400 && !formLogin.headers.get('set-cookie'));
  const crossSite = await anon.req('POST', '/api/login', { username: users.other.name, password: users.other.pw }, { headers: { Origin: 'https://evil.example' } });
  check('API changes from another website are blocked (CSRF)', crossSite.status === 403 && !crossSite.setCookie);
  const sameSite = await client().req('POST', '/api/login', { username: users.other.name, password: users.other.pw }, { headers: { Origin: BASE } });
  check('requests from ArtPing itself still work', sameSite.status === 200);
  check('leftover /secret test route is gone', (await other.req('GET', '/secret')).status === 404);

  group('Audit fixes: input limits and safe failures');
  const longEmail = `a@${'.'.repeat(60000)}@`;
  let t0 = Date.now();
  const redos = await anon.req('POST', '/api/register', { email: longEmail, username: 'sec_redos', password: strongPassword('d') });
  check('a crafted 60,000-character email is rejected instantly (no server freeze)', redos.status === 400 && Date.now() - t0 < 500, `${Date.now() - t0} ms`);
  t0 = Date.now();
  const redos2 = await anon.req('POST', '/api/password/forgot', { email: `a@${'a.'.repeat(30000)}` });
  check('forgot-password rejects a crafted email instantly', redos2.status === 400 && Date.now() - t0 < 500, `${Date.now() - t0} ms`);
  for (const [name, why] of [['ab', 'too short'], ['x'.repeat(31), 'too long'], ['<b>hi</b>', 'HTML'], ['..', 'dots'], ['has space', 'spaces']]) {
    check(`username rejected: ${why}`, (await register(name, strongPassword('u'), 'valid@example.test')).text.includes('usernames must be'));
  }
  const looksAlike = await register(users.other.name.toUpperCase(), strongPassword('l'), 'lookalike@example.test');
  check('usernames differing only by capitals are refused (no look-alikes)', looksAlike.status === 409, looksAlike.text);
  check('login ignores capital letters in the username', (await client().login(users.other.name.toUpperCase(), users.other.pw)).status === 200);
  const trimmed = await register('  sec_trim  ', strongPassword('t'), 'trim@example.test');
  check('spaces around a username are trimmed', trimmed.json && trimmed.json.username === 'sec_trim');
  const bio = (body) => other.req('PUT', '/api/profile', body);
  check('bio over 500 characters rejected', (await bio({ bio: 'x'.repeat(501) })).status === 400);
  check('pronouns over 40 characters rejected', (await bio({ pronouns: 'x'.repeat(41) })).status === 400);
  check('non-text bio gets 400, not a crash', (await bio({ bio: { $gt: '' } })).status === 400);
  check('valid bio is saved trimmed', (await bio({ bio: '  I paint.  ', pronouns: ' they/them ' })).json.profile.bio === 'I paint.');
  for (const url of [`/api/posts/${renamed.json.post._id}/comments`, '/api/reports']) {
    const r = await other.req('POST', url);
    check(`empty request to ${url} gets a friendly 4xx, not a 500`, r.status >= 400 && r.status < 500, `got ${r.status}`);
  }
  check('empty profile update changes nothing and does not crash', (await other.req('PUT', '/api/profile')).status === 200);
  check('empty forgot-password request gets 400, not a 500', (await anon.req('POST', '/api/password/forgot')).status === 400);
  for (let i = 0; i < 5; i++) await upload(owner, png, `page${i}.png`, 'image/png', { title: `page ${i}` });
  const pagedIds = [];
  let pc = null;
  do {
    const r = (await anon.req('GET', `/api/posts/sec_owner?limit=2${pc ? `&cursor=${encodeURIComponent(pc)}` : ''}`)).json;
    pagedIds.push(...r.posts.map(p => p._id));
    pc = r.nextCursor;
  } while (pc);
  check('profile posts come in pages, each post once', pagedIds.length >= 9 && new Set(pagedIds).size === pagedIds.length, `${pagedIds.length} posts`);
  check('profile posts reject a bad cursor', (await anon.req('GET', '/api/posts/sec_owner?cursor=nope')).status === 400);

  group('Audit fixes: reset links work exactly once, even at the same instant');
  await anon.req('POST', '/api/password/forgot', { email: 'sec_other@example.test' }, { headers: { 'X-Forwarded-For': '10.7.7.7' } });
  await new Promise(r => setTimeout(r, 300));
  const raceToken = new URL(resetLinkFor(users.other.name)).searchParams.get('token');
  const otherNewPw = strongPassword('q');
  const raceReset = () => anon.req('POST', '/api/password/reset', { token: raceToken, password: otherNewPw }, { headers: { 'X-Forwarded-For': '10.7.7.7' } });
  const raceResults = await Promise.all([raceReset(), raceReset(), raceReset()]);
  check('3 simultaneous uses of one reset link: exactly one succeeds', raceResults.filter(r => r.status === 200).length === 1,
    raceResults.map(r => r.status).join(','));
  users.other.pw = otherNewPw;
  await other.login(users.other.name, users.other.pw);

  group('Audit fixes: admin is a setting on the account');
  await db.collection('users').updateOne({ username: ADMIN }, { $set: { isAdmin: false } });
  check('removing admin takes effect immediately', (await admin.req('GET', '/api/admin/reports')).status === 403
    && (await admin.req('GET', '/api/me')).json.isAdmin === false);
  await db.collection('users').updateOne({ username: ADMIN }, { $set: { isAdmin: true } });
  check('granting admin takes effect immediately', (await admin.req('GET', '/api/admin/reports')).status === 200);

  group('Your data and account deletion');
  check('data download requires login', (await anon.req('GET', '/api/account/export')).status === 401);
  const exported = await other.req('GET', '/api/account/export');
  check('data download works and is offered as a file', exported.status === 200 && /attachment/.test(exported.headers.get('content-disposition') || ''));
  check('data download includes your account and profile', exported.json && exported.json.account.username === users.other.name && exported.json.profile.bio === 'I paint.');
  check('data download never includes password hashes or reset tokens', !/\$2[aby]\$|resetToken|sessionVersion/.test(exported.text));
  // Give the user something to delete: a post (liked + commented by others), a comment, a like and follows
  const victimPost = (await upload(other, png, 'mine.png', 'image/png', { title: 'to be deleted' })).json.post;
  await owner.req('POST', `/api/posts/${victimPost._id}/like`);
  await owner.req('POST', `/api/posts/${victimPost._id}/comments`, { text: 'nice' });
  const ownersPost = renamed.json.post._id;
  await other.req('POST', `/api/posts/${ownersPost}/like`);
  await other.req('POST', `/api/posts/${ownersPost}/comments`, { text: 'from other' });
  const before = await db.collection('posts').findOne({ _id: new mongoose.Types.ObjectId(ownersPost) });
  const otherPfp = await other.req('POST', '/api/profile/pfp', imageForm(png, 'p.png', 'image/png', {}, 'pfp'));
  check('account deletion requires the right password', (await other.req('POST', '/api/account/delete', { password: 'Wrong-pass1!' })).status === 401);
  const del = await other.req('POST', '/api/account/delete', { password: users.other.pw });
  check('account deletion works', del.status === 200, del.text);
  await new Promise(r => setTimeout(r, 300));
  const otherId = (await db.collection('users').findOne({ username: users.other.name }));
  const after = await db.collection('posts').findOne({ _id: new mongoose.Types.ObjectId(ownersPost) });
  check('the account is gone', !otherId);
  check('their posts and post images are gone', !await db.collection('posts').findOne({ username: users.other.name })
    && !fs.existsSync(path.join(UPLOADS, victimPost.filename)));
  check('their profile and profile picture are gone', !await db.collection('profiles').findOne({ username: users.other.name })
    && !fs.existsSync(path.join(UPLOADS, path.basename(otherPfp.json.pfp))));
  check('their likes and comments on others\' posts are removed, counts corrected',
    after.likeCount === before.likeCount - 1 && after.commentCount === before.commentCount - 1);
  check('their follows are removed', (await anon.req('GET', '/api/profile/sec_owner')).json.followerCount === 0);
  check('they are logged out and cannot log back in', (await other.req('GET', '/api/me')).json.username === null
    && (await client().login(users.other.name, users.other.pw)).status === 401);

  group('Launch basics: page info, icons, footer, links and search engines');
  const PUBLIC = path.join(ROOT, 'public');
  const NO_INDEX = new Set(['upload', 'settings', 'reports', 'forgot-password', 'reset-password', '404']);
  const FIXED_ADDRESS = { index: '/', feed: '/feed.html', about: '/about.html', login: '/login.html', register: '/register.html' };
  const thisYear = String(new Date().getFullYear());
  const pageNames = fs.readdirSync(PUBLIC).filter(f => f.endsWith('.html')).map(f => f.replace(/\.html$/, ''));
  check('found the site pages', pageNames.length >= 12, `found ${pageNames.length}`);
  for (const name of pageNames) {
    const r = await anon.req('GET', name === 'index' ? '/' : `/${name}.html`);
    const html = r.text;
    const grab = (re) => (re.exec(html) || [])[1] || '';
    const title = grab(/<title>([^<]*)<\/title>/);
    const description = grab(/<meta name="description" content="([^"]*)"/);
    const problems = [];
    if (r.status !== 200) problems.push(`status ${r.status}`);
    if (title.length < 10 || title.length > 70) problems.push(`title length ${title.length}`);
    if (description.length < 30 || description.length > 200) problems.push(`description length ${description.length}`);
    if (!/<meta name="viewport"/.test(html)) problems.push('no viewport tag');
    if (!html.includes('href="/favicon.svg"') || !html.includes('rel="apple-touch-icon"')) problems.push('missing icons');
    if (!html.includes('href="#main-content"') || !html.includes('id="main-content"')) problems.push('no skip link / main landmark');
    if (!html.includes(`&copy; ${thisYear} ArtPing`)) problems.push('footer missing or wrong year');
    if (!html.includes('href="/about.html"')) problems.push('footer has no About link');
    if (/%APP_URL%|%YEAR%/.test(html)) problems.push('placeholder left unfilled');
    if (/<img(?![^>]*\salt=)[^>]*>/i.test(html)) problems.push('image without alt text');
    const noindex = /<meta name="robots" content="noindex"/.test(html);
    if (NO_INDEX.has(name) !== noindex) problems.push(noindex ? 'wrongly hidden from search' : 'private page not hidden from search');
    if (!NO_INDEX.has(name)) {
      if (grab(/<meta property="og:title" content="([^"]*)"/) !== title) problems.push('share title missing or different');
      if (grab(/<meta property="og:image" content="([^"]*)"/) !== `${BASE}/images/og-image.png`) problems.push('share image address wrong');
      if (FIXED_ADDRESS[name]) {
        const want = BASE + FIXED_ADDRESS[name];
        if (grab(/<link rel="canonical" href="([^"]*)"/) !== want) problems.push('canonical address wrong');
        if (grab(/<meta property="og:url" content="([^"]*)"/) !== want) problems.push('share address wrong');
      }
    }
    check(`${name}.html has complete page info (title, description, icons, footer, share tags)`, problems.length === 0, problems.join('; '));
  }
  check('page names work in any capitalization, placeholders filled', !/%APP_URL%|%YEAR%/.test((await anon.req('GET', '/FEED.HTML')).text));

  const binary = async (url) => {
    const res = await fetch(BASE + url);
    return { status: res.status, type: res.headers.get('content-type') || '', buffer: Buffer.from(await res.arrayBuffer()) };
  };
  const svgIcon = await binary('/favicon.svg');
  check('favicon.svg is served as an image', svgIcon.status === 200 && /image\/svg\+xml/.test(svgIcon.type));
  for (const [url, w, h] of [['/favicon-32.png', 32, 32], ['/apple-touch-icon.png', 180, 180], ['/images/og-image.png', 1200, 630]]) {
    const img = await binary(url);
    const meta = img.status === 200 ? await sharp(img.buffer).metadata() : {};
    check(`${url} is a ${w}x${h} PNG`, meta.format === 'png' && meta.width === w && meta.height === h, `${meta.format} ${meta.width}x${meta.height}`);
  }
  const ico = await anon.req('GET', '/favicon.ico');
  check('/favicon.ico points browsers at the icon', ico.status === 301 && ico.headers.get('location') === '/favicon-32.png');

  const robots = await anon.req('GET', '/robots.txt');
  check('robots.txt is served as plain text', robots.status === 200 && /text\/plain/.test(robots.headers.get('content-type') || ''));
  check('robots.txt keeps crawlers out of /api/ and private pages', robots.text.includes('Disallow: /api/') && robots.text.includes('Disallow: /settings.html'));
  // robots.txt groups are separated by blank lines; the AI-training group blocks everything, the general one must not
  const robotsGroups = robots.text.split(/\n\s*\n/);
  const generalGroup = robotsGroups.find(g => /^User-agent: \*$/m.test(g)) || '';
  const aiGroup = robotsGroups.find(g => /^User-agent: GPTBot$/m.test(g)) || '';
  check('robots.txt does not block the whole site for ordinary crawlers', generalGroup !== '' && !/^Disallow:\s*\/\s*$/m.test(generalGroup));
  check('robots.txt blocks AI training crawlers from the whole site', ['GPTBot', 'ClaudeBot', 'Google-Extended', 'CCBot'].every(bot => aiGroup.includes(`User-agent: ${bot}\n`))
    && /^Disallow: \/$/m.test(aiGroup) && !/^User-agent: \*$/m.test(aiGroup));
  const optOut = (res) => res.headers.get('x-robots-tag') === 'noai, noimageai' && res.headers.get('tdm-reservation') === '1';
  check('pages and image files ask AI tools not to train on them', optOut(await anon.req('GET', '/feed.html')) && optOut(await fetch(BASE + '/images/og-image.png')));
  check('the AI opt-out does not hide pages from search engines', !/noindex/i.test((await anon.req('GET', '/')).headers.get('x-robots-tag') || ''));
  check('robots.txt points to the sitemap', robots.text.includes(`Sitemap: ${BASE}/sitemap.xml`));
  const sitemap = await anon.req('GET', '/sitemap.xml');
  const locs = [...sitemap.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  check('sitemap.xml is served as XML with the public pages', sitemap.status === 200 && /xml/.test(sitemap.headers.get('content-type') || '') && locs.includes(`${BASE}/`) && locs.includes(`${BASE}/feed.html`));
  check('sitemap lists only addresses on this site, never private pages', locs.every(u => u.startsWith(BASE)) && !locs.some(u => /settings|reports|upload|reset|forgot/.test(u)));
  let sitemapBroken = [];
  for (const loc of locs) if ((await anon.req('GET', loc.replace(BASE, ''))).status !== 200) sitemapBroken.push(loc);
  check('every sitemap address works', sitemapBroken.length === 0, sitemapBroken.join(', '));

  // Every link and image address written in the pages and scripts must point at something that exists
  const brokenLinks = [];
  let linksChecked = 0;
  const exists = (address) => {
    const clean = address.split('#')[0].split('?')[0];
    if (!clean) return true;
    const relative = (clean === '/' ? '/index.html' : clean).replace(/^\//, '');
    return fs.existsSync(path.join(PUBLIC, relative));
  };
  const scripts = ['nav.js', 'posts.js', 'password-rules.js', ...fs.readdirSync(path.join(PUBLIC, 'js')).map(f => `js/${f}`)];
  for (const name of pageNames) {
    const html = fs.readFileSync(path.join(PUBLIC, `${name}.html`), 'utf8');
    for (const [, address] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      if (/^(https?:|mailto:|tel:|data:|#)/.test(address) || address.includes('%') || address.startsWith('/api/')) continue;
      linksChecked++;
      if (!exists(address.startsWith('/') ? address : `/${address}`)) brokenLinks.push(`${name}.html -> ${address}`);
    }
  }
  for (const script of scripts) {
    const code = fs.readFileSync(path.join(PUBLIC, script), 'utf8');
    for (const [, address] of code.matchAll(/['"`]\/?([a-z0-9-]+\.html)(?:[?#][^'"`]*)?['"`]/g)) {
      linksChecked++;
      if (!exists(`/${address}`)) brokenLinks.push(`${script} -> ${address}`);
    }
  }
  check(`no broken links (checked ${linksChecked})`, brokenLinks.length === 0 && linksChecked > 40, brokenLinks.join('; '));

  group('Rate limits (run last; they lock this test server out)');
  let limited = null;
  for (let i = 0; i < 8 && !limited; i++) {
    const r = await forgot(`x${i}@example.test`);
    if (r.status === 429) limited = r;
  }
  check('password reset requests are rate limited', limited && limited.text.startsWith('Sorry'));
  let loginLimited = null;
  for (let i = 0; i < 12 && !loginLimited; i++) {
    const r = await anon.login(users.other.name, 'Wrong-pass1!');
    if (r.status === 429) loginLimited = r;
  }
  check('failed logins are rate limited', loginLimited && loginLimited.text.startsWith('Sorry'));
  check('the correct password is also blocked while limited', (await client().login(users.other.name, users.other.pw)).status === 429);
  let regLimited = null;
  for (let i = 0; i < 6 && !regLimited; i++) {
    const r = await register(`sec_bulk${i}`, strongPassword('b'));
    if (r.status === 429) regLimited = r;
  }
  check('account creation is rate limited', !!regLimited);

  // ---------------------------------------------------------------
  let accountLimited = null;
  for (let i = 0; i < 25 && !accountLimited; i++) {
    const r = await anon.req('POST', '/api/login', { username: users.admin.name, password: 'Wrong-pass1!' },
      { headers: { 'X-Forwarded-For': `10.0.${i}.1` } });
    if (r.status === 429) accountLimited = r;
  }
  check('one account is protected even when guesses come from many IPs', !!accountLimited);
  let attemptLimited = null;
  for (let i = 0; i < 35 && !attemptLimited; i++) {
    const r = await anon.req('POST', '/api/register', { email: 'bad', username: 'x', password: 'y' },
      { headers: { 'X-Forwarded-For': '10.9.9.9' } });
    if (r.status === 429) attemptLimited = r;
  }
  check('failed sign-up attempts are rate limited too', !!attemptLimited);
  check('rate-limit hits are logged', serverLog.includes('[rate limit]'));
  check('failed logins are logged without the password', serverLog.includes('[security] Failed login') && !serverLog.includes('Wrong-pass1!'));

  group('Server health');
  check('no unexpected server errors were logged', !/Unhandled error|Uncaught exception|Unhandled Rejection/.test(serverLog),
    (serverLog.match(/(Unhandled error|Uncaught exception|Unhandled Rejection)[^\n]*/) || [''])[0]);
}

(async () => {
  const started = Date.now();
  try {
    await run();
  } catch (error) {
    failures.push(`Test run crashed: ${error.stack || error}`);
    console.error('\nTEST RUN CRASHED:', error);
  } finally {
    await cleanUp();
  }
  console.log(`\n${passed} passed, ${failures.length} failed (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(`  - ${f}`));
  }
  process.exit(failures.length ? 1 : 0);
})();
