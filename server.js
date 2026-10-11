require('dotenv').config();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const app = express();
const session = require('express-session');
const MongoStore = require('connect-mongo');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const sharp = require('sharp');
const nodemailer = require('nodemailer');

// Settings come from environment variables (.env locally, the host's settings in production).
// See .env.example for the full list.
const port = process.env.PORT || 3000;
const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/ArtPing';
const isProduction = process.env.NODE_ENV === 'production';
// The site's public address (no trailing slash). Used in password reset emails, share previews, robots.txt and the sitemap.
const APP_URL = (process.env.APP_URL || `http://localhost:${port}`).replace(/\/$/, '');
if (isProduction && !process.env.APP_URL) {
  console.warn('WARNING: APP_URL is not set. Link previews, canonical links, the sitemap and password reset emails will all use http://localhost. Set it to your real https:// address.');
}
// Folder for uploaded images. On a host, point it at a persistent disk (the app's own folder is
// wiped on every redeploy). Images are always served at /uploads/... whichever folder holds them.
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, 'public', 'uploads'));
if (isProduction && !process.env.UPLOAD_DIR) {
  console.warn('WARNING: UPLOAD_DIR is not set. Uploaded images are saved inside the app folder and will be lost on the next deploy. Point it at your persistent disk.');
}

// Without a real secret anyone could forge login sessions, so refuse to start
if (!process.env.SESSION_SECRET) {
  console.error('SESSION_SECRET is not set. Add it to .env (see .env.example) and restart.');
  process.exit(1);
}

// Which proxies to trust for the visitor's real IP (used by rate limits) and for HTTPS detection.
// Default 'loopback' trusts nothing from the internet, so visitors can't fake their IP with an
// X-Forwarded-For header. On a host, set TRUST_PROXY to what the host documents (often 1).
const trustProxy = process.env.TRUST_PROXY || 'loopback';
if (isProduction && !process.env.TRUST_PROXY) {
  console.warn('WARNING: TRUST_PROXY is not set. Behind a host\'s proxy, logins (secure cookies) and rate limits will not work correctly. Set it to what your host documents (often 1).');
}
app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);
app.disable('x-powered-by'); // don't advertise the framework

// Security headers on every response
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",                     // only our own .js files; no inline scripts
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",            // blob: = image preview on the upload page
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",                // no other site may embed ArtPing (clickjacking)
].join('; ');
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',   // browsers must use the type we send, never guess it
    'X-Frame-Options': 'DENY',             // older browsers' version of frame-ancestors
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    // Ask AI tools not to train on pages or art. Sent as a header (not a <meta> tag) so it also covers
    // the image files themselves; image dataset tools like img2dataset check it. Search indexing is unaffected.
    'X-Robots-Tag': 'noai, noimageai',
    'tdm-reservation': '1',                // W3C TDMRep: text and data mining rights are reserved
  });
  if (isProduction) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains'); // HTTPS only
  next();
});

// ===== AI training crawlers =====
// Blocked from the whole site in robots.txt, and turned away with a 403 below when they announce
// themselves (some ignore robots.txt). Scrapers that pretend to be a browser get past this; Cloudflare's
// bot blocking catches more. AI *search* crawlers (OAI-SearchBot, Claude-SearchBot, PerplexityBot),
// search engines and link-preview bots (Discord, Slack, X, facebookexternalhit) are left allowed.
// Google-Extended and Applebot-Extended are robots.txt names only (they never visit), so they only
// matter there; Google-Extended blocks Gemini training, not Google Search.
const AI_TRAINING_CRAWLERS = [
  'GPTBot', 'ClaudeBot', 'anthropic-ai', 'Google-Extended', 'Applebot-Extended', 'CCBot',
  'meta-externalagent', 'Bytespider', 'Amazonbot', 'cohere-training-data-crawler', 'Diffbot',
  'ImagesiftBot', 'Omgilibot',
];
const AI_CRAWLER_NAMES = AI_TRAINING_CRAWLERS.map(bot => bot.toLowerCase());

app.use((req, res, next) => {
  if (req.path === '/robots.txt') return next(); // let them read the rules
  const userAgent = String(req.get('user-agent') || '').toLowerCase();
  if (AI_CRAWLER_NAMES.some(bot => userAgent.includes(bot))) {
    return res.status(403).type('text/plain').send('Sorry, AI training crawlers are not allowed on ArtPing. See /robots.txt.');
  }
  next();
});

// ===== Pages =====
const PUBLIC_DIR = path.join(__dirname, 'public');

// HTML pages hold two placeholders that are filled in as the page is sent:
//   %APP_URL% = the site's full address (share previews and search engines need absolute links)
//   %YEAR%    = the current year (footer copyright)
// The replacement is a function so special characters in APP_URL can never be misread.
function fillPage(html) {
  return html
    .replaceAll('%APP_URL%', () => APP_URL)
    .replaceAll('%YEAR%', () => String(new Date().getFullYear()));
}

app.use(async (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  // Only plain page names like /feed.html (or / for the home page), so no path tricks are possible
  const page = req.path === '/' ? 'index' : (/^\/([a-z0-9-]+)\.html$/i.exec(req.path) || [])[1];
  if (!page) return next();
  try {
    const html = await fs.promises.readFile(path.join(PUBLIC_DIR, `${page.toLowerCase()}.html`), 'utf8');
    res.type('html').set('Cache-Control', 'no-cache').send(fillPage(html));
  } catch (error) {
    if (error.code === 'ENOENT') return next();
    next(error);
  }
});

// Pages search engines should list (private pages like Settings are left out)
const SITEMAP_PATHS = ['/', '/feed.html', '/about.html', '/register.html', '/login.html'];

app.get('/robots.txt', (req, res) => {
  // robots.txt only asks well-behaved crawlers to stay away; it is not a security measure
  res.type('text/plain').send([
    ...AI_TRAINING_CRAWLERS.map(bot => `User-agent: ${bot}`),
    'Disallow: /',
    '',
    'User-agent: *',
    'Disallow: /api/',
    'Disallow: /settings.html',
    'Disallow: /reports.html',
    'Disallow: /upload.html',
    'Disallow: /forgot-password.html',
    'Disallow: /reset-password.html',
    '',
    `Sitemap: ${APP_URL}/sitemap.xml`,
    '',
  ].join('\n'));
});

app.get('/sitemap.xml', (req, res) => {
  const urls = SITEMAP_PATHS.map(p => `  <url><loc>${APP_URL}${p}</loc></url>`).join('\n');
  res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`
  );
});

// Browsers ask for /favicon.ico on their own; point them at our icon
app.get('/favicon.ico', (req, res) => res.redirect(301, '/favicon-32.png'));

// Uploaded images (UPLOAD_DIR may be outside the app, e.g. a persistent disk), then everything in 'public'
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(PUBLIC_DIR));
// JSON only: the pages never send classic HTML forms, so other sites can't submit forms to the API
app.use(express.json({ limit: '100kb' }));
// Requests without a body still get an empty object, so handlers can always read req.body
app.use((req, res, next) => {
  if (req.body === undefined) req.body = {};
  next();
});
// Connect to MongoDB
mongoose.connect(mongoUri)
.then(() => console.log('Connected to MongoDB'))
.catch((err) => console.error('MongoDB connection error:', err));
app.use(session({
  name: 'artping.sid',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,             // each visit restarts the 7 days, so inactive logins expire
  store: MongoStore.create({ mongoUrl: mongoUri }),
  cookie: {
    httpOnly: true,          // page scripts can't read the cookie
    sameSite: 'lax',         // other sites can't send requests with it
    secure: isProduction,    // HTTPS only in production (localhost uses plain HTTP)
    maxAge: 1000 * 60 * 60 * 24 * 7, // stay logged in for 7 days
  },
}));

// Refuse API changes sent from other websites (cross-site request forgery).
// Browsers always say which site a request came from in the Origin header.
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin) {
    let sameSite = false;
    try { sameSite = new URL(origin).host === req.get('host'); } catch { /* malformed */ }
    if (!sameSite) return res.status(403).send('Sorry, that request came from another website and was blocked.');
  }
  next();
});

// Messages shown to users. Keep them friendly and never reveal internal details.
const MSG = {
  loginRequired: 'Sorry, you must be logged in to use this feature.',
  serverError: 'Sorry, something went wrong on our end. Please try again in a moment.',
  postNotFound: 'Sorry, we couldn\'t find that post. It may have been deleted.',
  commentNotFound: 'Sorry, we couldn\'t find that comment. It may have been deleted.',
  userNotFound: 'Sorry, we couldn\'t find that user.',
  profileNotFound: 'Sorry, we couldn\'t find that profile.',
  adminsOnly: 'Sorry, only admins can do that.',
  badRequest: 'Sorry, something about that request wasn\'t right. Please refresh the page and try again.',
};

// Logs the real error for you, sends a friendly message to the user
function serverError(res, label, error) {
  console.error(`${label}:`, error);
  res.status(500).send(MSG.serverError);
}

// Slow down password guessing and mass account creation (limits are per IP address)
function limiter(windowMinutes, limit, message, options = {}) {
  return rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message,
    // Log every time a limit is hit, so attacks show up in the server log
    handler: (req, res, next, opts) => {
      console.warn(`[rate limit] ${req.method} ${req.originalUrl} blocked for ${req.ip}`
        + (req.session && req.session.username ? ` (user ${req.session.username})` : ''));
      res.status(opts.statusCode).send(opts.message);
    },
    ...options,
  });
}
const loginLimiter = limiter(15, 10,
  'Sorry, too many login attempts. Please wait 15 minutes and try again.',
  { skipSuccessfulRequests: true }); // only failed logins count toward the limit
// Also limit failed logins per account, so guessing one person's password from many IPs is slow too
const accountLoginLimiter = limiter(60, 20,
  'Sorry, too many login attempts for this account. Please wait a while and try again, or reset your password.',
  {
    skipSuccessfulRequests: true,
    keyGenerator: req => `user:${String(req.body.username || '').trim().toLowerCase()}`,
  });
const registerLimiter = limiter(60, 5,
  'Sorry, too many accounts have been created from here. Please try again in an hour.',
  { skipFailedRequests: true }); // only accounts actually created count, so typos don't lock people out
// Caps all sign-up attempts (including failed ones), so the form can't be used to probe or overload the server
const registerAttemptLimiter = limiter(15, 30, 'Sorry, too many sign-up attempts. Please wait 15 minutes and try again.');
const commentLimiter = limiter(10, 30, "Sorry, you're commenting too fast. Please wait a few minutes.");
const reportLimiter = limiter(60, 20, "Sorry, you've sent too many reports. Please try again later.");
const uploadLimiter = limiter(60, 30, "Sorry, you've uploaded a lot recently. Please try again in an hour.");
const forgotPasswordLimiter = limiter(15, 5, 'Sorry, too many password reset requests. Please wait 15 minutes and try again.');
const resetPasswordLimiter = limiter(15, 10, 'Sorry, too many attempts. Please wait 15 minutes and try again.');
const passwordChangeLimiter = limiter(15, 10,
  'Sorry, too many attempts. Please wait 15 minutes and try again.',
  { skipSuccessfulRequests: true });
// Everyday actions (likes, follows, edits, deletes): generous, but stops bots and scripts
const actionLimiter = limiter(1, 120,
  "Sorry, you're doing that too fast. Please slow down for a minute.",
  { keyGenerator: req => (req.session && req.session.userId ? `user:${req.session.userId}` : `ip:${req.ip}`) });

function isAuthenticated(req, res, next) {
  if (req.session && req.session.userId) {
    req.user = { id: req.session.userId, username: req.session.username };
    return next();
  }
  return res.status(401).send(MSG.loginRequired);
}

// Password rules. public/password-rules.js shows the same rules on the page; keep them in sync.
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_BYTES = 72; // bcrypt ignores anything past 72 bytes
function passwordProblem(password) {
  if (typeof password !== 'string') return 'Please enter a password.';
  const missing = [];
  if (password.length < PASSWORD_MIN_LENGTH) missing.push(`at least ${PASSWORD_MIN_LENGTH} characters`);
  if (!/[A-Z]/.test(password)) missing.push('an uppercase letter');
  if (!/[a-z]/.test(password)) missing.push('a lowercase letter');
  if (!/[0-9]/.test(password)) missing.push('a number');
  if (!/[^A-Za-z0-9]/.test(password)) missing.push('a special character (like ! @ # $)');
  if (missing.length) return `Sorry, your password needs ${missing.join(', ')}.`;
  if (Buffer.byteLength(password) > PASSWORD_MAX_BYTES) return 'Sorry, that password is too long. Please use 72 characters or fewer.';
  return null;
}

// Simple Mongoose User schema/model (used by register/login)
const userSchema = new mongoose.Schema({
  email: { type: String, unique: true, required: true },
  username: { type: String, unique: true, required: true },
  // Lower-case copy of the username, so "Alice" and "alice" can't both exist (no look-alike accounts)
  usernameLower: { type: String, unique: true, sparse: true },
  password: { type: String, required: true },
  // Admin rights live on the account and are granted with `npm run admin -- grant <username>`.
  // Never based on the username alone, so nobody can become admin by registering a name first.
  isAdmin: { type: Boolean, default: false },
  // Goes up whenever the password changes; sessions from before that are logged out
  sessionVersion: { type: Number, default: 0 },
  // Password reset: only a hash of the emailed token is stored, so a database leak can't be used to reset passwords
  resetTokenHash: { type: String, default: null },
  resetTokenExpires: { type: Date, default: null },
}, { timestamps: true });
userSchema.pre('validate', function () {
  if (this.username) this.usernameLower = this.username.toLowerCase();
});
const User = mongoose.model('User', userSchema);

// One-time upgrade for accounts created before usernameLower existed
mongoose.connection.once('open', async () => {
  try {
    const old = await User.find({ usernameLower: { $exists: false } }).select('username');
    for (const user of old) {
      try {
        await User.updateOne({ _id: user._id }, { $set: { usernameLower: user.username.toLowerCase() } });
      } catch (error) {
        console.warn(`Username "${user.username}" differs from another only by capital letters; it can still log in by exact name.`);
      }
    }
  } catch (error) {
    console.error('Username upgrade error:', error);
  }
});

// Runs on every request from a logged-in visitor:
//  - logs out sessions from before the user's last password change (or whose account is gone)
//  - loads admin status fresh from the database, so granting or removing admin applies right away
app.use(async (req, res, next) => {
  req.isAdmin = false;
  if (!req.session || !req.session.userId) return next();
  try {
    const user = await User.findById(req.session.userId).select('sessionVersion isAdmin').lean();
    if (!user || (user.sessionVersion || 0) !== (req.session.sessionVersion || 0)) {
      delete req.session.userId;
      delete req.session.username;
      delete req.session.sessionVersion;
    } else {
      req.isAdmin = !!user.isAdmin;
    }
    next();
  } catch (error) {
    next(error);
  }
});

// Uploaded images schema for users art.
const postSchema = new mongoose.Schema({
  username: { type: String, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true },
  description: { type: String },
  filename: { type: String, required: true },
  filepath: { type: String, required: true },
  // Kept in sync with the Like collection so the feed doesn't have to count likes per request
  likeCount: { type: Number, default: 0 },
  // Kept in sync with the Comment collection, same reason
  commentCount: { type: Number, default: 0 },
}, { timestamps: true });

// Index for the feed so sorting by newest doesn't scan the whole collection
postSchema.index({ createdAt: -1, _id: -1 });

const Post = mongoose.model('Post', postSchema);

//Profile schema for user profiles with custom details about their art or themselves
const profileSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  username: { type: String, required: true },
  bio: { type: String, default: '', maxlength: 500 },
  pronouns: { type: String, default: '', maxlength: 40 },
  pfp: { type: String, default: '' },
}, { timestamps: true });

const Profile = mongoose.model('Profile', profileSchema);

// One document per (user, post) like. The unique index stops double-likes.
const likeSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  postId: { type: mongoose.Schema.Types.ObjectId, ref: 'Post', required: true },
}, { timestamps: true });
likeSchema.index({ userId: 1, postId: 1 }, { unique: true });

const Like = mongoose.model('Like', likeSchema);

// One document per (follower, followed) pair. The unique index stops double-follows.
const followSchema = new mongoose.Schema({
  followerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  followingId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });
followSchema.index({ followerId: 1, followingId: 1 }, { unique: true });
followSchema.index({ followingId: 1 }); // for counting a user's followers

const Follow = mongoose.model('Follow', followSchema);

// Comments on posts. username is stored like on Post, since usernames can't change.
const COMMENT_MAX_LENGTH = 500;
const commentSchema = new mongoose.Schema({
  postId: { type: mongoose.Schema.Types.ObjectId, ref: 'Post', required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  username: { type: String, required: true },
  text: { type: String, required: true, maxlength: COMMENT_MAX_LENGTH },
}, { timestamps: true });
commentSchema.index({ postId: 1, _id: 1 }); // a post's comments, oldest first

const Comment = mongoose.model('Comment', commentSchema);

// Reports of inappropriate posts or comments, reviewed by admins on reports.html.
// The unique index means each user can report a given post/comment only once.
const REPORT_REASONS = {
  spam: 'Spam',
  harassment: 'Harassment or bullying',
  sexual: 'Nudity or sexual content',
  hate: 'Hate speech or violence',
  stolen: 'Stolen artwork',
  other: 'Something else',
};
const reportSchema = new mongoose.Schema({
  targetType: { type: String, enum: ['post', 'comment'], required: true },
  targetId: { type: mongoose.Schema.Types.ObjectId, required: true },
  reporterId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  reporterUsername: { type: String, required: true },
  reason: { type: String, enum: Object.keys(REPORT_REASONS), required: true },
  details: { type: String, default: '', maxlength: 500 },
  status: { type: String, enum: ['open', 'dismissed', 'removed'], default: 'open' },
}, { timestamps: true });
reportSchema.index({ reporterId: 1, targetType: 1, targetId: 1 }, { unique: true });
reportSchema.index({ status: 1, createdAt: -1 });

const Report = mongoose.model('Report', reportSchema);

// Admins can review reports. Admin status is the isAdmin flag on the account (loaded above);
// grant it with `npm run admin -- grant <username>`.
function isAdmin(req) {
  return !!(req.session && req.session.userId && req.isAdmin);
}
function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) return res.status(401).send(MSG.loginRequired);
  if (!isAdmin(req)) return res.status(403).send(MSG.adminsOnly);
  next();
}

// Adds what the page needs to show each post card: like/comment counts, whether the
// viewer liked it, and the author's profile picture. Works on plain objects (.lean()).
async function decoratePosts(posts, viewerId, viewerIsAdmin = false) {
  if (!posts.length) return posts;

  const [likes, profiles] = await Promise.all([
    viewerId
      ? Like.find({ userId: viewerId, postId: { $in: posts.map(p => p._id) } }).select('postId').lean()
      : [],
    Profile.find({ userId: { $in: posts.map(p => p.userId) } }).select('userId pfp').lean(),
  ]);
  const likedIds = new Set(likes.map(l => l.postId.toString()));
  const pfps = new Map(profiles.map(p => [p.userId.toString(), p.pfp]));

  posts.forEach(p => {
    p.likeCount = p.likeCount || 0;
    p.commentCount = p.commentCount || 0;
    p.likedByMe = likedIds.has(p._id.toString());
    p.pfp = pfps.get(String(p.userId)) || '';
    p.isMine = !!viewerId && String(p.userId) === viewerId;
    p.canDelete = p.isMine || viewerIsAdmin; // owners delete their posts; admins can delete any
  });
  return posts;
}

// Deletes a post and everything attached to it (owner deleting their post, or an admin removing it)
async function deletePostAndRelated(post) {
  const commentIds = (await Comment.find({ postId: post._id }).select('_id').lean()).map(c => c._id);
  await Promise.all([
    Post.deleteOne({ _id: post._id }),
    Like.deleteMany({ postId: post._id }),
    Comment.deleteMany({ postId: post._id }),
    // Close any open reports on the post or its comments
    Report.updateMany(
      { status: 'open', $or: [
        { targetType: 'post', targetId: post._id },
        { targetType: 'comment', targetId: { $in: commentIds } },
      ] },
      { status: 'removed' }
    ),
  ]);
  deleteUpload(post.filename);
}

// Deletes a comment and keeps the post's commentCount in sync
async function deleteComment(comment) {
  const result = await Comment.deleteOne({ _id: comment._id });
  if (result.deletedCount) {
    await Post.updateOne({ _id: comment.postId, commentCount: { $gt: 0 } }, { $inc: { commentCount: -1 } });
  }
  await Report.updateMany({ status: 'open', targetType: 'comment', targetId: comment._id }, { status: 'removed' });
}

// ===== Image uploads =====
// Industry-standard handling for user images:
//  1. Size limit while receiving (in memory, never written to disk unchecked)
//  2. The real format is detected from the file's contents, not its name or claimed type
//  3. Only JPG, PNG, WebP and GIF are accepted, with a cap on image dimensions
//  4. The image is re-encoded, which strips hidden data (like GPS location in phone photos)
//     and anything smuggled inside the file
//  5. Saved under a random name with an extension that matches the real format
//     (in UPLOAD_DIR, set near the top of this file)
const POST_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const PFP_MAX_BYTES = 5 * 1024 * 1024;   // 5 MB
const MAX_IMAGE_PIXELS = 50 * 1000 * 1000; // 50 megapixels
const IMAGE_FORMATS = { jpeg: 'jpg', png: 'png', webp: 'webp', gif: 'gif' };
const TITLE_MAX_LENGTH = 100;
const DESCRIPTION_MAX_LENGTH = 1000;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

class UploadError extends Error {} // problems the user can fix; the message is shown to them

// Accepts one image field; puts friendly errors on req.uploadError instead of crashing
function receiveImage(field, maxBytes) {
  const receiver = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1, fields: 10 },
  }).single(field);

  return (req, res, next) => {
    receiver(req, res, (error) => {
      if (!error) return next();
      if (error.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).send(`Sorry, that image is too big. The limit is ${Math.round(maxBytes / 1024 / 1024)} MB.`);
      }
      if (error instanceof multer.MulterError) return res.status(400).send(MSG.badRequest);
      next(error);
    });
  };
}

// Checks and re-encodes an uploaded image, saves it, and returns the new file name
async function saveImage(buffer, { square } = {}) {
  let metadata;
  try {
    metadata = await sharp(buffer, { limitInputPixels: MAX_IMAGE_PIXELS }).metadata();
  } catch (error) {
    if (/pixel limit/i.test(error.message)) {
      throw new UploadError('Sorry, that image is too large. Please use one under 50 megapixels (about 8000 × 6000).');
    }
    throw new UploadError('Sorry, that file isn\'t a valid image. Please upload a JPG, PNG, WebP or GIF.');
  }
  if (!IMAGE_FORMATS[metadata.format]) {
    throw new UploadError('Sorry, only JPG, PNG, WebP and GIF images can be uploaded.');
  }

  const animated = (metadata.pages || 1) > 1;
  let image = sharp(buffer, { limitInputPixels: MAX_IMAGE_PIXELS, animated: animated && !square });
  let ext;

  if (square) {
    // Profile pictures: a 512×512 square, saved as WebP
    image = image.rotate().resize(512, 512, { fit: 'cover' }).webp({ quality: 88 });
    ext = 'webp';
  } else {
    if (!animated) image = image.rotate(); // turn phone photos the right way up before the orientation data is dropped
    ext = IMAGE_FORMATS[metadata.format];
    if (ext === 'jpg') image = image.jpeg({ quality: 92, mozjpeg: true });
    else if (ext === 'png') image = image.png();
    else if (ext === 'webp') image = image.webp({ quality: 92 });
    else image = image.gif();
  }

  // sharp leaves out metadata (EXIF, GPS, comments) unless asked to keep it
  let output;
  try {
    output = await image.toBuffer();
  } catch (error) {
    throw new UploadError('Sorry, that image couldn\'t be processed. It may be damaged. Please try a different file.');
  }

  const filename = `${crypto.randomUUID()}.${ext}`;
  await fs.promises.writeFile(path.join(UPLOAD_DIR, filename), output);
  return filename;
}

// Deletes an uploaded file; ignores errors (e.g. it was already deleted)
function deleteUpload(filename) {
  if (!filename) return;
  fs.promises.unlink(path.join(UPLOAD_DIR, path.basename(filename))).catch(() => {});
}

// Validates a post's title and description; returns an error message or null
function postTextProblem(title, description) {
  if (typeof title !== 'string' || !title.trim()) return 'Please give your post a title.';
  if (title.trim().length > TITLE_MAX_LENGTH) return `Sorry, titles can be at most ${TITLE_MAX_LENGTH} characters.`;
  if (description !== undefined && description !== null && typeof description !== 'string') return MSG.badRequest;
  if ((description || '').trim().length > DESCRIPTION_MAX_LENGTH) {
    return `Sorry, descriptions can be at most ${DESCRIPTION_MAX_LENGTH} characters.`;
  }
  return null;
}

//upload route
app.post('/api/upload', isAuthenticated, uploadLimiter, receiveImage('image', POST_MAX_BYTES), async (req, res) => {
  if (!req.file) return res.status(400).send('Please choose an image to upload.');
  const textProblem = postTextProblem(req.body.title, req.body.description);
  if (textProblem) return res.status(400).send(textProblem);

  let filename;
  try {
    filename = await saveImage(req.file.buffer);
    const newPost = new Post({
      username: req.session.username,
      userId: req.session.userId,
      title: req.body.title.trim(),
      description: (req.body.description || '').trim(),
      filename,
      filepath: '/uploads/' + filename,
    });

    await newPost.save();
    res.json({ success: true, post: newPost });
  } catch (error) {
    deleteUpload(filename); // don't leave an orphaned file behind
    if (error instanceof UploadError) return res.status(400).send(error.message);
    serverError(res, 'Upload error', error);
  }
});

//Edit your own post's title and description
app.put('/api/posts/:id', isAuthenticated, actionLimiter, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).send(MSG.postNotFound);
    const { title, description } = req.body || {};
    const textProblem = postTextProblem(title, description);
    if (textProblem) return res.status(400).send(textProblem);

    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).send(MSG.postNotFound);
    if (post.userId.toString() !== req.session.userId) {
      return res.status(403).send('Sorry, you can only edit your own posts.');
    }

    post.title = title.trim();
    post.description = (description || '').trim();
    await post.save();
    res.json({ title: post.title, description: post.description });
  } catch (error) {
    serverError(res, 'Post edit error', error);
  }
});

// console log to show server.js is running
console.log("Server file started");
// global error handlers to surface why process may be exiting
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason && reason.stack ? reason.stack : reason);
});

//View profile route
app.get('/api/profile/:username', async (req, res) => {
  try {
    const profile = await Profile.findOne({ username: req.params.username });
    if (!profile) return res.status(404).send(MSG.profileNotFound);

    const [followerCount, followingCount, isFollowing] = await Promise.all([
      Follow.countDocuments({ followingId: profile.userId }),
      Follow.countDocuments({ followerId: profile.userId }),
      req.session.userId
        ? Follow.exists({ followerId: req.session.userId, followingId: profile.userId })
        : null,
    ]);

    res.json({ ...profile.toObject(), followerCount, followingCount, isFollowing: !!isFollowing });
  } catch (error) {
    serverError(res, 'Profile fetch error', error);
  }
});

//Follow a user
app.post('/api/users/:username/follow', isAuthenticated, actionLimiter, async (req, res) => {
  try {
    const target = await User.findOne({ username: req.params.username }).select('_id');
    if (!target) return res.status(404).send(MSG.userNotFound);
    if (target._id.toString() === req.session.userId) return res.status(400).send("Sorry, you can't follow yourself.");

    try {
      await Follow.create({ followerId: req.session.userId, followingId: target._id });
    } catch (error) {
      if (error.code !== 11000) throw error; // already following is fine
    }

    const followerCount = await Follow.countDocuments({ followingId: target._id });
    res.json({ following: true, followerCount });
  } catch (error) {
    serverError(res, 'Follow error', error);
  }
});

//Unfollow a user
app.delete('/api/users/:username/follow', isAuthenticated, actionLimiter, async (req, res) => {
  try {
    const target = await User.findOne({ username: req.params.username }).select('_id');
    if (!target) return res.status(404).send(MSG.userNotFound);

    await Follow.deleteOne({ followerId: req.session.userId, followingId: target._id });

    const followerCount = await Follow.countDocuments({ followingId: target._id });
    res.json({ following: false, followerCount });
  } catch (error) {
    serverError(res, 'Unfollow error', error);
  }
});

//List a user's followers or who they follow, most recent first
// GET /api/users/:username/followers?cursor=<nextCursor>
// GET /api/users/:username/following?cursor=<nextCursor>
async function listFollows(req, res, which) {
  try {
    const user = await User.findOne({ username: req.params.username }).select('_id');
    if (!user) return res.status(404).send(MSG.userNotFound);

    const limit = Math.min(Math.max(parseInt(req.query.limit) || 30, 1), 100);
    const filter = which === 'followers' ? { followingId: user._id } : { followerId: user._id };
    if (req.query.cursor) {
      if (!mongoose.Types.ObjectId.isValid(req.query.cursor)) return res.status(400).send(MSG.badRequest);
      filter._id = { $lt: new mongoose.Types.ObjectId(req.query.cursor) };
    }

    // Fetch one extra to know whether there's another page
    const follows = await Follow.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
    const hasMore = follows.length > limit;
    if (hasMore) follows.pop();

    // The "other" person in each follow: who follows them, or who they follow
    const otherIds = follows.map(f => which === 'followers' ? f.followerId : f.followingId);
    const viewerId = req.session.userId;
    const [users, profiles, viewerFollows] = await Promise.all([
      User.find({ _id: { $in: otherIds } }).select('username').lean(),
      Profile.find({ userId: { $in: otherIds } }).select('userId pfp').lean(),
      // Which of these people the logged-in viewer follows, for the Follow buttons
      viewerId
        ? Follow.find({ followerId: viewerId, followingId: { $in: otherIds } }).select('followingId').lean()
        : [],
    ]);
    const usernames = new Map(users.map(u => [u._id.toString(), u.username]));
    const pfps = new Map(profiles.map(p => [p.userId.toString(), p.pfp]));
    const followedByViewer = new Set(viewerFollows.map(f => f.followingId.toString()));

    const list = otherIds
      .filter(id => usernames.has(id.toString())) // skip deleted accounts
      .map(id => ({
        username: usernames.get(id.toString()),
        pfp: pfps.get(id.toString()) || '',
        isFollowing: followedByViewer.has(id.toString()),
        isMe: id.toString() === viewerId,
      }));

    res.json({ users: list, nextCursor: hasMore ? follows[follows.length - 1]._id.toString() : null });
  } catch (error) {
    serverError(res, `List ${which} error`, error);
  }
}

app.get('/api/users/:username/followers', (req, res) => listFollows(req, res, 'followers'));
app.get('/api/users/:username/following', (req, res) => listFollows(req, res, 'following'));

//Like a post
app.post('/api/posts/:id/like', isAuthenticated, actionLimiter, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).send(MSG.postNotFound);
    if (!await Post.exists({ _id: req.params.id })) return res.status(404).send(MSG.postNotFound);

    try {
      await Like.create({ userId: req.session.userId, postId: req.params.id });
      // Only bump the count if the like was actually new
      await Post.updateOne({ _id: req.params.id }, { $inc: { likeCount: 1 } });
    } catch (error) {
      if (error.code !== 11000) throw error; // already liked is fine
    }

    const post = await Post.findById(req.params.id).select('likeCount').lean();
    res.json({ liked: true, likeCount: post.likeCount || 0 });
  } catch (error) {
    serverError(res, 'Like error', error);
  }
});

//Unlike a post
app.delete('/api/posts/:id/like', isAuthenticated, actionLimiter, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).send(MSG.postNotFound);

    const result = await Like.deleteOne({ userId: req.session.userId, postId: req.params.id });
    // Only lower the count if a like was actually removed
    if (result.deletedCount) {
      await Post.updateOne({ _id: req.params.id }, { $inc: { likeCount: -1 } });
    }

    const post = await Post.findById(req.params.id).select('likeCount').lean();
    if (!post) return res.status(404).send(MSG.postNotFound);
    res.json({ liked: false, likeCount: post.likeCount || 0 });
  } catch (error) {
    serverError(res, 'Unlike error', error);
  }
});

//Delete a post (its owner, or an admin). Also removes its likes, comments, reports and image file.
app.delete('/api/posts/:id', isAuthenticated, actionLimiter, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).send(MSG.postNotFound);
    const post = await Post.findById(req.params.id).lean();
    if (!post) return res.status(404).send(MSG.postNotFound);
    if (post.userId.toString() !== req.session.userId && !isAdmin(req)) {
      return res.status(403).send('Sorry, you can only delete your own posts.');
    }

    await deletePostAndRelated(post);
    res.json({ deleted: true });
  } catch (error) {
    serverError(res, 'Post delete error', error);
  }
});

// Shape a comment for the page: author's picture, and whether the viewer may delete it
// (the comment's author, the post's owner, or an admin)
async function formatComments(comments, post, req) {
  const profiles = await Profile.find({ userId: { $in: comments.map(c => c.userId) } }).select('userId pfp').lean();
  const pfps = new Map(profiles.map(p => [p.userId.toString(), p.pfp]));
  const viewerId = req.session.userId;
  const ownsPost = !!viewerId && post.userId.toString() === viewerId;

  return comments.map(c => ({
    _id: c._id,
    username: c.username,
    pfp: pfps.get(c.userId.toString()) || '',
    text: c.text,
    createdAt: c.createdAt,
    isMine: !!viewerId && c.userId.toString() === viewerId,
    canDelete: !!viewerId && (c.userId.toString() === viewerId || ownsPost || isAdmin(req)),
  }));
}

//List a post's comments, oldest first
// GET /api/posts/:id/comments?cursor=<nextCursor>
app.get('/api/posts/:id/comments', async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).send(MSG.postNotFound);
    const post = await Post.findById(req.params.id).select('userId').lean();
    if (!post) return res.status(404).send(MSG.postNotFound);

    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 50);
    const filter = { postId: post._id };
    if (req.query.cursor) {
      if (!mongoose.Types.ObjectId.isValid(req.query.cursor)) return res.status(400).send(MSG.badRequest);
      filter._id = { $gt: new mongoose.Types.ObjectId(req.query.cursor) };
    }

    // Fetch one extra to know whether there's another page
    const comments = await Comment.find(filter).sort({ _id: 1 }).limit(limit + 1).lean();
    const hasMore = comments.length > limit;
    if (hasMore) comments.pop();

    res.json({
      comments: await formatComments(comments, post, req),
      nextCursor: hasMore ? comments[comments.length - 1]._id.toString() : null,
    });
  } catch (error) {
    serverError(res, 'Comments fetch error', error);
  }
});

//Add a comment
app.post('/api/posts/:id/comments', isAuthenticated, commentLimiter, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).send(MSG.postNotFound);
    const text = typeof req.body.text === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).send('Please write something before posting your comment.');
    if (text.length > COMMENT_MAX_LENGTH) {
      return res.status(400).send(`Sorry, comments can be at most ${COMMENT_MAX_LENGTH} characters.`);
    }

    const post = await Post.findById(req.params.id).select('userId').lean();
    if (!post) return res.status(404).send(MSG.postNotFound);

    const comment = await Comment.create({
      postId: post._id,
      userId: req.session.userId,
      username: req.session.username,
      text,
    });
    const updated = await Post.findByIdAndUpdate(post._id, { $inc: { commentCount: 1 } }, { new: true })
      .select('commentCount').lean();

    const [formatted] = await formatComments([comment.toObject()], post, req);
    res.json({ comment: formatted, commentCount: updated ? updated.commentCount : 1 });
  } catch (error) {
    serverError(res, 'Comment error', error);
  }
});

//Delete a comment (its author, the post's owner, or an admin)
app.delete('/api/comments/:id', isAuthenticated, actionLimiter, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).send(MSG.commentNotFound);
    const comment = await Comment.findById(req.params.id).lean();
    if (!comment) return res.status(404).send(MSG.commentNotFound);

    const post = await Post.findById(comment.postId).select('userId').lean();
    const allowed = comment.userId.toString() === req.session.userId
      || (post && post.userId.toString() === req.session.userId)
      || isAdmin(req);
    if (!allowed) return res.status(403).send('Sorry, you can only delete your own comments.');

    await deleteComment(comment);
    const updated = await Post.findById(comment.postId).select('commentCount').lean();
    res.json({ deleted: true, commentCount: updated ? updated.commentCount : 0 });
  } catch (error) {
    serverError(res, 'Comment delete error', error);
  }
});

//Report a post or comment
// POST /api/reports { targetType: 'post'|'comment', targetId, reason, details? }
app.get('/api/report-reasons', (req, res) => res.json(REPORT_REASONS));

app.post('/api/reports', isAuthenticated, reportLimiter, async (req, res) => {
  try {
    const { targetType, targetId, reason } = req.body || {};
    const details = typeof req.body.details === 'string' ? req.body.details.trim() : '';
    if (!['post', 'comment'].includes(targetType)) return res.status(400).send(MSG.badRequest);
    if (typeof targetId !== 'string' || !mongoose.Types.ObjectId.isValid(targetId)) {
      return res.status(400).send(MSG.badRequest);
    }
    if (typeof reason !== 'string' || !REPORT_REASONS[reason]) return res.status(400).send('Please choose a reason for your report.');
    if (details.length > 500) return res.status(400).send('Sorry, report details can be at most 500 characters.');

    const Model = targetType === 'post' ? Post : Comment;
    const target = await Model.findById(targetId).select('userId').lean();
    if (!target) return res.status(404).send(targetType === 'post' ? MSG.postNotFound : MSG.commentNotFound);
    if (target.userId.toString() === req.session.userId) {
      return res.status(400).send(`Sorry, you can't report your own ${targetType}.`);
    }

    try {
      await Report.create({
        targetType,
        targetId,
        reporterId: req.session.userId,
        reporterUsername: req.session.username,
        reason,
        details,
      });
    } catch (error) {
      if (error.code === 11000) return res.status(409).send(`You've already reported this ${targetType}. Thanks, our team will review it.`);
      throw error;
    }
    res.json({ reported: true });
  } catch (error) {
    serverError(res, 'Report error', error);
  }
});

//Admin: open reports, grouped so each reported post/comment appears once
app.get('/api/admin/reports', requireAdmin, async (req, res) => {
  try {
    const groups = await Report.aggregate([
      { $match: { status: 'open' } },
      { $sort: { createdAt: -1 } },
      { $group: {
        _id: { targetType: '$targetType', targetId: '$targetId' },
        count: { $sum: 1 },
        lastReportedAt: { $first: '$createdAt' },
        reports: { $push: { reason: '$reason', details: '$details', reporter: '$reporterUsername', createdAt: '$createdAt' } },
      } },
      { $sort: { count: -1, lastReportedAt: -1 } },
      { $limit: 100 },
    ]);

    const postIds = groups.filter(g => g._id.targetType === 'post').map(g => g._id.targetId);
    const commentIds = groups.filter(g => g._id.targetType === 'comment').map(g => g._id.targetId);
    const [posts, comments] = await Promise.all([
      Post.find({ _id: { $in: postIds } }).select('username title description filepath createdAt').lean(),
      Comment.find({ _id: { $in: commentIds } }).select('username text postId createdAt').lean(),
    ]);
    const targets = new Map([...posts, ...comments].map(t => [t._id.toString(), t]));

    res.json(groups.map(g => ({
      targetType: g._id.targetType,
      targetId: g._id.targetId,
      target: targets.get(g._id.targetId.toString()) || null, // null if already deleted
      count: g.count,
      lastReportedAt: g.lastReportedAt,
      reports: g.reports.slice(0, 10).map(r => ({ ...r, reasonLabel: REPORT_REASONS[r.reason] })),
    })));
  } catch (error) {
    serverError(res, 'Admin reports error', error);
  }
});

//Admin: resolve all open reports on a post/comment
// POST /api/admin/reports/resolve { targetType, targetId, action: 'dismiss' | 'remove' }
app.post('/api/admin/reports/resolve', requireAdmin, async (req, res) => {
  try {
    const { targetType, targetId, action } = req.body || {};
    if (!['post', 'comment'].includes(targetType)) return res.status(400).send(MSG.badRequest);
    if (typeof targetId !== 'string' || !mongoose.Types.ObjectId.isValid(targetId)) {
      return res.status(400).send(MSG.badRequest);
    }
    if (!['dismiss', 'remove'].includes(action)) return res.status(400).send(MSG.badRequest);

    if (action === 'remove') {
      if (targetType === 'post') {
        const post = await Post.findById(targetId).lean();
        if (post) await deletePostAndRelated(post);
      } else {
        const comment = await Comment.findById(targetId).lean();
        if (comment) await deleteComment(comment);
      }
    }

    // Covers 'dismiss', and 'remove' on content that was already deleted
    await Report.updateMany(
      { status: 'open', targetType, targetId },
      { status: action === 'remove' ? 'removed' : 'dismissed' }
    );
    console.log(`Admin ${req.session.username} ${action === 'remove' ? 'removed' : 'dismissed reports on'} ${targetType} ${targetId}`);
    res.json({ ok: true });
  } catch (error) {
    serverError(res, 'Resolve report error', error);
  }
});

// Bio and pronouns: plain text with a length limit; returns an error message or null
const BIO_MAX_LENGTH = 500;
const PRONOUNS_MAX_LENGTH = 40;
function profileTextProblem(bio, pronouns) {
  for (const [value, max, label] of [[bio, BIO_MAX_LENGTH, 'bios'], [pronouns, PRONOUNS_MAX_LENGTH, 'pronouns']]) {
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') return MSG.badRequest;
    if (value.trim().length > max) return `Sorry, ${label} can be at most ${max} characters.`;
  }
  return null;
}

//Creating profile route
app.post('/api/profile', isAuthenticated, actionLimiter, async (req, res) => {
  const textProblem = profileTextProblem(req.body.bio, req.body.pronouns);
  if (textProblem) return res.status(400).send(textProblem);
  try {
    const existing = await Profile.findOne({ userId: req.session.userId });
    if (existing) return res.status(409).send('You already have a profile.');

    const newProfile = new Profile({
      userId: req.session.userId,
      username: req.session.username,
      bio: (req.body.bio || '').trim(),
      pronouns: (req.body.pronouns || '').trim(),
      pfp: '',
    });

    await newProfile.save();
    res.json({ success: true, profile: newProfile });

  } catch (error) {
    serverError(res, 'Profile create error', error);
  }
});

//Update profile route
app.put('/api/profile', isAuthenticated, actionLimiter, async (req, res) => {
  const textProblem = profileTextProblem(req.body.bio, req.body.pronouns);
  if (textProblem) return res.status(400).send(textProblem);
  try {
    const profile = await Profile.findOne({ userId: req.session.userId });
    if (!profile) return res.status(404).send(MSG.profileNotFound);

    if (typeof req.body.bio === 'string') profile.bio = req.body.bio.trim();
    if (typeof req.body.pronouns === 'string') profile.pronouns = req.body.pronouns.trim();

    await profile.save();
    res.json({ success: true, profile });

  } catch (error) {
    serverError(res, 'Profile update error', error);
  }
});

//PFP upload route
app.post('/api/profile/pfp', isAuthenticated, uploadLimiter, receiveImage('pfp', PFP_MAX_BYTES), async (req, res) => {
  let filename;
  try {
    if (!req.file) return res.status(400).send('Please choose an image to upload.');

    const profile = await Profile.findOne({ userId: req.session.userId });
    if (!profile) return res.status(404).send(MSG.profileNotFound);

    filename = await saveImage(req.file.buffer, { square: true });
    const oldPfp = profile.pfp;
    profile.pfp = '/uploads/' + filename;
    await profile.save();
    if (oldPfp && oldPfp.startsWith('/uploads/')) deleteUpload(oldPfp); // don't keep the replaced picture

    res.json({ success: true, pfp: profile.pfp });
  } catch (error) {
    deleteUpload(filename);
    if (error instanceof UploadError) return res.status(400).send(error.message);
    serverError(res, 'Profile picture upload error', error);
  }
});

//Feed route
// GET /api/feed?sort=new|hot&scope=all|following&limit=20&cursor=<nextCursor from previous response>
//   sort=new (default): newest first
//   sort=hot ("Trending" tab): likes weighted by recency, so new popular posts rise and old ones sink
//   scope=following: only posts from users the logged-in user follows
const FEED_FIELDS = {
  username: 1, userId: 1, title: 1, description: 1, filepath: 1, createdAt: 1, likeCount: 1, commentCount: 1,
};

const TRENDING_CANDIDATES = 1000; // Trending ranks the newest 1000 posts

app.get('/api/feed', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 50);
    const sort = req.query.sort === 'hot' ? 'hot' : 'new';
    const cursor = req.query.cursor ? String(req.query.cursor) : null;
    const filter = {};

    if (req.query.scope === 'following') {
      if (!req.session.userId) return res.status(401).send('Sorry, you must be logged in to see posts from artists you follow.');
      const follows = await Follow.find({ followerId: req.session.userId }).select('followingId').lean();
      filter.userId = { $in: follows.map(f => f.followingId) };
    }

    let posts;
    let nextCursor = null;

    if (sort === 'new') {
      // Cursor is "<createdAt ISO>_<postId>" of the last post on the previous page.
      // Using _id as a tiebreaker keeps posts with identical timestamps from being skipped.
      if (cursor) {
        const [time, id] = cursor.split('_');
        const date = new Date(time);
        if (isNaN(date) || !mongoose.Types.ObjectId.isValid(id)) {
          return res.status(400).send(MSG.badRequest);
        }
        filter.$or = [
          { createdAt: { $lt: date } },
          { createdAt: date, _id: { $lt: new mongoose.Types.ObjectId(id) } },
        ];
      }

      // Fetch one extra to know whether there's another page
      posts = await Post.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .limit(limit + 1)
        .select(FEED_FIELDS)
        .lean();

      const hasMore = posts.length > limit;
      if (hasMore) posts.pop();
      const last = posts[posts.length - 1];
      if (hasMore) nextCursor = `${last.createdAt.toISOString()}_${last._id}`;
    } else {
      // Trending scores change over time, so a time-based cursor doesn't work here; use page numbers.
      const page = cursor ? parseInt(cursor) : 1;
      if (!(page >= 1)) return res.status(400).send(MSG.badRequest);

      // score = likes / (hoursOld + 2) ^ 1.5
      const ageHours = { $divide: [{ $subtract: [new Date(), '$createdAt'] }, 1000 * 60 * 60] };
      posts = await Post.aggregate([
        { $match: filter },
        { $sort: { createdAt: -1 } },
        { $limit: TRENDING_CANDIDATES },
        { $addFields: { score: { $divide: [
          { $ifNull: ['$likeCount', 0] },
          { $pow: [{ $add: [ageHours, 2] }, 1.5] },
        ] } } },
        { $sort: { score: -1, createdAt: -1, _id: -1 } },
        { $skip: (page - 1) * limit },
        { $limit: limit + 1 },
        { $project: FEED_FIELDS },
      ]);

      if (posts.length > limit) {
        posts.pop();
        nextCursor = String(page + 1);
      }
    }

    await decoratePosts(posts, req.session.userId, isAdmin(req));
    res.json({ posts, nextCursor });
  } catch (error) {
    serverError(res, 'Feed fetch error', error);
  }
});

//Get posts by username
// GET /api/posts/:username?limit=24&cursor=<nextCursor>  ->  { posts, nextCursor }
app.get('/api/posts/:username', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 24, 1), 50);
    const filter = { username: req.params.username };
    if (req.query.cursor) {
      const [time, id] = String(req.query.cursor).split('_');
      const date = new Date(time);
      if (isNaN(date) || !mongoose.Types.ObjectId.isValid(id)) return res.status(400).send(MSG.badRequest);
      filter.$or = [
        { createdAt: { $lt: date } },
        { createdAt: date, _id: { $lt: new mongoose.Types.ObjectId(id) } },
      ];
    }
    const posts = await Post.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .select(FEED_FIELDS)
      .lean();
    const hasMore = posts.length > limit;
    if (hasMore) posts.pop();
    const last = posts[posts.length - 1];
    await decoratePosts(posts, req.session.userId, isAdmin(req));
    res.json({ posts, nextCursor: hasMore ? `${last.createdAt.toISOString()}_${last._id}` : null });
  } catch (error) {
    serverError(res, 'Post fetch error', error);
  }
});


// ===== Accounts =====
const BCRYPT_ROUNDS = 10;
// Emails: the length is capped before the pattern runs, and the pattern has no overlapping parts,
// so a crafted "email" can't make it run slowly and freeze the server
const EMAIL_MAX_LENGTH = 254;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
function validEmail(email) {
  return typeof email === 'string' && email.length <= EMAIL_MAX_LENGTH && EMAIL_PATTERN.test(email);
}
// Usernames appear on every post and in links: 3-30 letters, numbers or underscores
const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,30}$/;
const USERNAME_RULES = 'Sorry, usernames must be 3–30 characters and use only letters, numbers and underscores (_).';

// For log lines: quotes the value and cuts it short, so user input can't fake extra log lines
function logValue(value) {
  return JSON.stringify(String(value).slice(0, 60));
}

// Finds an account by username, ignoring capital letters (older accounts fall back to the exact name)
async function findUserByName(username) {
  const name = username.trim();
  return (await User.findOne({ usernameLower: name.toLowerCase() })) || User.findOne({ username: name });
}

// Log a user in: new session ID (so a session ID planted before login can't be reused),
// remembering which password "version" this session belongs to
function startSession(req, res, user) {
  req.session.regenerate(err => {
    if (err) return serverError(res, 'Session error', err);
    req.session.userId = user._id.toString();
    req.session.username = user.username;
    req.session.sessionVersion = user.sessionVersion || 0;
    req.session.save(err => {
      if (err) return serverError(res, 'Session save error', err);
      res.json({ username: user.username });
    });
  });
}

// Registration route with password hashing
app.post('/api/register', registerAttemptLimiter, registerLimiter, async (req, res) => {
  const { email, username, password } = req.body;
  // Must be plain text (not objects like {"$gt": ""}) and not empty
  if (![email, username, password].every(v => typeof v === 'string' && v.trim())) {
    return res.status(400).send('Please fill in your email, username and password.');
  }
  const normalizedEmail = email.trim().toLowerCase();
  const name = username.trim();
  if (!validEmail(normalizedEmail)) return res.status(400).send('Please enter a valid email address.');
  if (!USERNAME_PATTERN.test(name)) return res.status(400).send(USERNAME_RULES);
  const problem = passwordProblem(password);
  if (problem) return res.status(400).send(problem);

  try {
    const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const newUser = new User({ email: normalizedEmail, username: name, password: hashedPassword });
    await newUser.save();

    const newProfile = new Profile({
      userId: newUser._id,
      username: newUser.username,
    });
    await newProfile.save();
    console.log('New user registered:', newUser.username);

    return res.json({ username: newUser.username });
  } catch (error) {
    // Username/email already taken is expected, not a server error, so don't log it
    if (error.code === 11000) {
      const field = Object.keys(error.keyValue)[0];
      return res.status(409).send(field === 'email'
        ? 'Sorry, an account with that email already exists. Try logging in instead.'
        : 'Sorry, that username is already taken. Please choose another.');
    }
    serverError(res, 'Registration error', error);
  }
});

// Login route with password verification
app.post('/api/login', loginLimiter, accountLoginLimiter, async (req, res) => {
  const { username, password } = req.body;
  // Must be plain text, so {"$gt": ""} can't be used to match any user
  if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
    return res.status(400).send('Please enter your username and password.');
  }

  try {
    const user = await findUserByName(username);
    // Same message whether the username or the password is wrong, so it can't be used to find accounts
    if (!user || !await bcrypt.compare(password, user.password)) {
      console.warn(`[security] Failed login for ${logValue(username)} from ${req.ip}`);
      return res.status(401).send('Sorry, that username and password don\'t match. Please try again.');
    }
    startSession(req, res, user);
  } catch (error) {
    serverError(res, 'Login error', error);
  }
});

app.get('/api/me', (req, res) => {
  res.json({
    username: req.session && req.session.username ? req.session.username : null,
    isAdmin: isAdmin(req),
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) return serverError(res, 'Logout error', err);
    res.clearCookie('artping.sid');
    res.json({ ok: true });
  });
});

// ===== Password reset by email =====
// Without SMTP settings, the reset link is printed in the server terminal instead (fine for development).
const RESET_TOKEN_MINUTES = 60;
const mailer = process.env.SMTP_HOST
  ? nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  })
  : null;

async function sendResetEmail(user, link) {
  if (!mailer) {
    if (isProduction) {
      console.error('Password reset requested but email is not set up (SMTP_HOST is missing).');
    } else {
      console.log(`\n[Password reset] Email is not set up, so here is ${user.username}'s reset link (valid ${RESET_TOKEN_MINUTES} minutes):\n${link}\n`);
    }
    return;
  }
  await mailer.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to: user.email,
    subject: 'Reset your ArtPing password',
    text: `Hi ${user.username},\n\nSomeone (hopefully you) asked to reset your ArtPing password. `
      + `Open this link to choose a new one. It works once and expires in ${RESET_TOKEN_MINUTES} minutes:\n\n${link}\n\n`
      + 'If you didn\'t ask for this, you can ignore this email. Your password won\'t change.\n',
  });
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Step 1: ask for a reset link. Always gives the same answer, at the same speed,
// so it can't be used to find out who has an account.
app.post('/api/password/forgot', forgotPasswordLimiter, async (req, res) => {
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!validEmail(email)) return res.status(400).send('Please enter a valid email address.');
  res.json({
    message: 'If an account uses that email, we\'ve sent a link to reset your password. Check your inbox (and spam folder).',
  });

  // The slow part happens after answering
  try {
    const user = await User.findOne({ email });
    if (!user) return;
    const token = crypto.randomBytes(32).toString('hex');
    user.resetTokenHash = hashToken(token);
    user.resetTokenExpires = new Date(Date.now() + RESET_TOKEN_MINUTES * 60 * 1000);
    await user.save();
    console.log(`[security] Password reset requested for ${user.username} from ${req.ip}`);
    await sendResetEmail(user, `${APP_URL}/reset-password.html?token=${token}`);
  } catch (error) {
    console.error('Forgot password error:', error);
  }
});

// Step 2: choose a new password using the emailed link
app.post('/api/password/reset', resetPasswordLimiter, async (req, res) => {
  const { token, password } = req.body;
  const invalidLink = 'Sorry, this reset link is invalid or has expired. Please request a new one.';
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return res.status(400).send(invalidLink);
  const problem = passwordProblem(password);
  if (problem) return res.status(400).send(problem);

  try {
    // Claim the link and clear it in one step, so it works exactly once even if submitted twice at the same instant
    const user = await User.findOneAndUpdate(
      { resetTokenHash: hashToken(token), resetTokenExpires: { $gt: new Date() } },
      { $set: { resetTokenHash: null, resetTokenExpires: null } },
      { new: true }
    );
    if (!user) return res.status(400).send(invalidLink);

    user.password = await bcrypt.hash(password, BCRYPT_ROUNDS);
    user.sessionVersion = (user.sessionVersion || 0) + 1; // log out everywhere
    await user.save();
    console.log(`[security] Password reset completed for ${user.username}`);
    res.json({ ok: true });
  } catch (error) {
    serverError(res, 'Password reset error', error);
  }
});

// Change password while logged in (Settings page)
app.post('/api/account/password', isAuthenticated, passwordChangeLimiter, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (typeof currentPassword !== 'string' || !currentPassword) {
    return res.status(400).send('Please enter your current password.');
  }
  const problem = passwordProblem(newPassword);
  if (problem) return res.status(400).send(problem);

  try {
    const user = await User.findById(req.session.userId);
    if (!user) return res.status(401).send(MSG.loginRequired);
    if (!await bcrypt.compare(currentPassword, user.password)) {
      return res.status(401).send('Sorry, your current password isn\'t right. Please try again.');
    }
    if (await bcrypt.compare(newPassword, user.password)) {
      return res.status(400).send('Your new password must be different from your current one.');
    }

    user.password = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    user.resetTokenHash = null; // any reset link that was sent earlier stops working
    user.resetTokenExpires = null;
    user.sessionVersion = (user.sessionVersion || 0) + 1; // logs out other devices...
    await user.save();
    req.session.sessionVersion = user.sessionVersion;   // ...but keeps this one logged in
    console.log(`[security] Password changed for ${user.username} from ${req.ip}`);
    res.json({ ok: true });
  } catch (error) {
    serverError(res, 'Password change error', error);
  }
});

// ===== Your data and account deletion (privacy rights, e.g. GDPR/CCPA) =====
// Download everything ArtPing stores about you, as a JSON file
app.get('/api/account/export', isAuthenticated, actionLimiter, async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.session.userId);
    const [user, profile, posts, comments, likes, following, followers, reports] = await Promise.all([
      User.findById(userId).select('username email createdAt isAdmin').lean(),
      Profile.findOne({ userId }).select('bio pronouns pfp createdAt').lean(),
      Post.find({ userId }).select('title description filepath likeCount commentCount createdAt updatedAt').lean(),
      Comment.find({ userId }).select('postId text createdAt').lean(),
      Like.find({ userId }).select('postId createdAt').lean(),
      Follow.find({ followerId: userId }).select('followingId createdAt').lean(),
      Follow.find({ followingId: userId }).select('followerId createdAt').lean(),
      Report.find({ reporterId: userId }).select('targetType targetId reason details status createdAt').lean(),
    ]);
    if (!user) return res.status(401).send(MSG.loginRequired);
    const names = await usernamesById([...following.map(f => f.followingId), ...followers.map(f => f.followerId)]);
    const data = {
      exportedAt: new Date().toISOString(),
      account: { username: user.username, email: user.email, createdAt: user.createdAt, isAdmin: !!user.isAdmin },
      profile,
      posts: posts.map(p => ({ ...p, imageUrl: `${APP_URL}${p.filepath}` })),
      comments,
      likedPostIds: likes.map(l => ({ postId: l.postId, likedAt: l.createdAt })),
      following: following.map(f => ({ username: names.get(f.followingId.toString()) || null, since: f.createdAt })),
      followers: followers.map(f => ({ username: names.get(f.followerId.toString()) || null, since: f.createdAt })),
      reportsYouSent: reports,
    };
    console.log(`[security] Data export for ${user.username}`);
    res.set('Content-Disposition', `attachment; filename="artping-data-${user.username}.json"`);
    res.json(data);
  } catch (error) {
    serverError(res, 'Data export error', error);
  }
});

async function usernamesById(ids) {
  const users = await User.find({ _id: { $in: ids } }).select('username').lean();
  return new Map(users.map(u => [u._id.toString(), u.username]));
}

// Permanently delete your account and everything you created. Requires your password.
app.post('/api/account/delete', isAuthenticated, passwordChangeLimiter, async (req, res) => {
  const { password } = req.body;
  if (typeof password !== 'string' || !password) return res.status(400).send('Please enter your password to confirm.');

  try {
    const user = await User.findById(req.session.userId);
    if (!user) return res.status(401).send(MSG.loginRequired);
    if (!await bcrypt.compare(password, user.password)) {
      return res.status(401).send('Sorry, that password isn\'t right. Your account was not deleted.');
    }
    const userId = user._id;

    // Your posts (with their likes, comments, reports and images)
    for (const post of await Post.find({ userId }).lean()) await deletePostAndRelated(post);
    // Your comments on other people's posts (keeps their comment counts right)
    for (const comment of await Comment.find({ userId }).lean()) await deleteComment(comment);
    // Your likes (keeps like counts right)
    for (const like of await Like.find({ userId }).lean()) {
      const removed = await Like.deleteOne({ _id: like._id });
      if (removed.deletedCount) await Post.updateOne({ _id: like.postId, likeCount: { $gt: 0 } }, { $inc: { likeCount: -1 } });
    }
    const profile = await Profile.findOne({ userId }).lean();
    await Promise.all([
      Follow.deleteMany({ $or: [{ followerId: userId }, { followingId: userId }] }),
      Report.deleteMany({ reporterId: userId }),
      Profile.deleteOne({ userId }),
      User.deleteOne({ _id: userId }),
    ]);
    if (profile && profile.pfp && profile.pfp.startsWith('/uploads/')) deleteUpload(profile.pfp);
    console.log(`[security] Account deleted: ${user.username}`);

    req.session.destroy(() => {
      res.clearCookie('artping.sid');
      res.json({ deleted: true });
    });
  } catch (error) {
    serverError(res, 'Account delete error', error);
  }
});

// ===== Not found and error handling (keep these last) =====
app.use('/api', (req, res) => {
  res.status(404).send('Sorry, we couldn\'t find what you were looking for.');
});

app.use(async (req, res) => {
  try {
    const html = await fs.promises.readFile(path.join(PUBLIC_DIR, '404.html'), 'utf8');
    res.status(404).type('html').send(fillPage(html));
  } catch (error) {
    res.status(404).type('text/plain').send('Sorry, we couldn\'t find that page.');
  }
});

// eslint-disable-next-line no-unused-vars
app.use((error, req, res, next) => {
  if (error.type === 'entity.parse.failed') return res.status(400).send(MSG.badRequest);
  if (error.type === 'entity.too.large') return res.status(413).send('Sorry, that request was too large.');
  serverError(res, 'Unhandled error', error);
});

app.listen(port, () => {
  console.log(`Example app listening at http://localhost:${port}`);
});
