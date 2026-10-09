require('dotenv').config();
const multer = require('multer');
const path = require('path');
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const app = express();
const cookieParser = require('cookie-parser');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const rateLimit = require('express-rate-limit');

// Settings come from environment variables (.env locally, the host's settings in production).
// See .env.example for the full list.
const port = process.env.PORT || 3000;
const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/ArtPing';
const isProduction = process.env.NODE_ENV === 'production';

// Without a real secret anyone could forge login sessions, so refuse to start
if (!process.env.SESSION_SECRET) {
  console.error('SESSION_SECRET is not set. Add it to .env (see .env.example) and restart.');
  process.exit(1);
}

// Hosts put the app behind an HTTPS proxy; this lets Express see the real
// client IP (for rate limiting) and know the connection was HTTPS (for secure cookies)
app.set('trust proxy', 1);
// Serve static files from the 'public' directory
app.use(express.static('public'));
// Routes demonstrating route params, query strings, middleware, and async handling
app.use(express.json()); // for parsing application/json
app.use(express.urlencoded({ extended: true }));
// Cookie parser middleware (must be registered before routes that access req.cookies)
app.use(cookieParser());
// Connect to MongoDB
mongoose.connect(mongoUri)
.then(() => console.log('Connected to MongoDB'))
.catch((err) => console.error('MongoDB connection error:', err));
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: mongoUri }),
  cookie: {
    httpOnly: true,          // page scripts can't read the cookie
    sameSite: 'lax',         // other sites can't send requests with it
    secure: isProduction,    // HTTPS only in production (localhost uses plain HTTP)
    maxAge: 1000 * 60 * 60 * 24 * 7, // stay logged in for 7 days
  },
}));

// Slow down password guessing and mass account creation (limits are per IP address)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true, // only failed logins count toward the limit
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: 'Too many login attempts. Please wait 15 minutes and try again.',
});
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: 'Too many accounts created. Please try again in an hour.',
});

function isAuthenticated(req, res, next) {
  if (req.session && req.session.userId) {
    req.user = { id: req.session.userId, username: req.session.username };
    return next();
  }
  return res.status(401).send('No');
}

// Simple Mongoose User schema/model (used by register/login)
const userSchema = new mongoose.Schema({
  email: { type: String, unique: true, required: true },
  username: { type: String, unique: true, required: true },
  password: { type: String, required: true },
}, { timestamps: true });
const User = mongoose.model('User', userSchema);

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
}, { timestamps: true });

// Index for the feed so sorting by newest doesn't scan the whole collection
postSchema.index({ createdAt: -1, _id: -1 });

const Post = mongoose.model('Post', postSchema);

//Profile schema for user profiles with custom details about their art or themselves
const profileSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  username: { type: String, required: true },
  bio: { type: String, default: '' },
  pronouns: { type: String, default: '' },
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

//multer storage configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'public/uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    if (ext) return cb(null, true);
    cb(new Error('Images only'));
  },
  limits: { fileSize: 10 * 1024 * 1024 } // 10mb limit
});

//upload route
app.post('/api/upload', isAuthenticated, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).send('Error Occured, no file uploaded');

  try {
    const newPost = new Post({
      username: req.session.username,
      userId: req.session.userId,
      title: req.body.title,
      description: req.body.description,
      filename: req.file.filename,
      filepath: '/uploads/' + req.file.filename,
    });

    await newPost.save();
    res.json({ success: true, post: newPost });

  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).send('An error occured during upload process.');
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
    if (!profile) return res.status(404).send('Profile not found');

    const [followerCount, followingCount, isFollowing] = await Promise.all([
      Follow.countDocuments({ followingId: profile.userId }),
      Follow.countDocuments({ followerId: profile.userId }),
      req.session.userId
        ? Follow.exists({ followerId: req.session.userId, followingId: profile.userId })
        : null,
    ]);

    res.json({ ...profile.toObject(), followerCount, followingCount, isFollowing: !!isFollowing });
  } catch (error) {
    console.error('Profile fetch error:', error);
    res.status(500).send('An error occured fetching profile')
  }
});

//Follow a user
app.post('/api/users/:username/follow', isAuthenticated, async (req, res) => {
  try {
    const target = await User.findOne({ username: req.params.username }).select('_id');
    if (!target) return res.status(404).send('User not found');
    if (target._id.toString() === req.session.userId) return res.status(400).send('You cannot follow yourself');

    try {
      await Follow.create({ followerId: req.session.userId, followingId: target._id });
    } catch (error) {
      if (error.code !== 11000) throw error; // already following is fine
    }

    const followerCount = await Follow.countDocuments({ followingId: target._id });
    res.json({ following: true, followerCount });
  } catch (error) {
    console.error('Follow error:', error);
    res.status(500).send('An error occurred following user');
  }
});

//Unfollow a user
app.delete('/api/users/:username/follow', isAuthenticated, async (req, res) => {
  try {
    const target = await User.findOne({ username: req.params.username }).select('_id');
    if (!target) return res.status(404).send('User not found');

    await Follow.deleteOne({ followerId: req.session.userId, followingId: target._id });

    const followerCount = await Follow.countDocuments({ followingId: target._id });
    res.json({ following: false, followerCount });
  } catch (error) {
    console.error('Unfollow error:', error);
    res.status(500).send('An error occurred unfollowing user');
  }
});

//List a user's followers or who they follow, most recent first
// GET /api/users/:username/followers?cursor=<nextCursor>
// GET /api/users/:username/following?cursor=<nextCursor>
async function listFollows(req, res, which) {
  try {
    const user = await User.findOne({ username: req.params.username }).select('_id');
    if (!user) return res.status(404).send('User not found');

    const limit = Math.min(Math.max(parseInt(req.query.limit) || 30, 1), 100);
    const filter = which === 'followers' ? { followingId: user._id } : { followerId: user._id };
    if (req.query.cursor) {
      if (!mongoose.Types.ObjectId.isValid(req.query.cursor)) return res.status(400).send('Invalid cursor');
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
    console.error(`List ${which} error:`, error);
    res.status(500).send(`An error occurred fetching ${which}`);
  }
}

app.get('/api/users/:username/followers', (req, res) => listFollows(req, res, 'followers'));
app.get('/api/users/:username/following', (req, res) => listFollows(req, res, 'following'));

//Like a post
app.post('/api/posts/:id/like', isAuthenticated, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).send('Invalid post id');
    if (!await Post.exists({ _id: req.params.id })) return res.status(404).send('Post not found');

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
    console.error('Like error:', error);
    res.status(500).send('An error occurred liking post');
  }
});

//Unlike a post
app.delete('/api/posts/:id/like', isAuthenticated, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).send('Invalid post id');

    const result = await Like.deleteOne({ userId: req.session.userId, postId: req.params.id });
    // Only lower the count if a like was actually removed
    if (result.deletedCount) {
      await Post.updateOne({ _id: req.params.id }, { $inc: { likeCount: -1 } });
    }

    const post = await Post.findById(req.params.id).select('likeCount').lean();
    if (!post) return res.status(404).send('Post not found');
    res.json({ liked: false, likeCount: post.likeCount || 0 });
  } catch (error) {
    console.error('Unlike error:', error);
    res.status(500).send('An error occurred unliking post');
  }
});

//Creating profile route
app.post('/api/profile', isAuthenticated, async (req, res) => {
  try {
    const existing = await Profile.findOne({ userId: req.session.userId });
    if (existing) return res.status(409).send('Profile already exists');

    const newProfile = new Profile({
      userId: req.session.userId,
      username: req.session.username,
      bio: req.body.bio || '',
      pronouns: req.body.pronouns || '',
      pfp: '',
    });

    await newProfile.save();
    res.json({ success: true, profile: newProfile });

  } catch (error) {
    console.error('Error: ', error);
    res.status(500).send('An error occured creating profile');
  }
});

//Update profile route
app.put('/api/profile', isAuthenticated, async (req, res) =>{
  try {
    const profile = await Profile.findOne({ userId: req.session.userId });
    if (!profile) return res.status(404).send('Profile not found');

    profile.bio = req.body.bio ?? profile.bio;
    profile.pronouns = req.body.pronouns ?? profile.pronouns;

    await profile.save();
    res.json({ success: true, profile });

  } catch (error) {
    console.error('Error', error);
    res.status(500).send('An error occurred updating profile');
  }
});

//PFP upload route
app.post('/api/profile/pfp', isAuthenticated, upload.single('pfp'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).send('No file uploaded');

    const profile = await Profile.findOne({ userId: req.session.userId });
    if (!profile) return res.status(404).send('Profile not found');

    profile.pfp = '/uploads/' + req.file.filename;
    await profile.save();

    res.json({ success: true, pfp: profile.pfp });

  } catch (error) {
    console.error('Profile picture upload error', error);
    res.status(500).send('An error occured uploading profile pictures');
  }
});

//Feed route
// GET /api/feed?sort=new|hot&scope=all|following&limit=20&cursor=<nextCursor from previous response>
//   sort=new (default): newest first
//   sort=hot ("Trending" tab): likes weighted by recency, so new popular posts rise and old ones sink
//   scope=following: only posts from users the logged-in user follows
const FEED_FIELDS = { username: 1, title: 1, description: 1, filepath: 1, createdAt: 1, likeCount: 1 };

app.get('/api/feed', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 50);
    const sort = req.query.sort === 'hot' ? 'hot' : 'new';
    const cursor = req.query.cursor ? String(req.query.cursor) : null;
    const filter = {};

    if (req.query.scope === 'following') {
      if (!req.session.userId) return res.status(401).send('Log in to see posts from people you follow');
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
          return res.status(400).send('Invalid cursor');
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
      if (!(page >= 1)) return res.status(400).send('Invalid cursor');

      // score = likes / (hoursOld + 2) ^ 1.5
      const ageHours = { $divide: [{ $subtract: [new Date(), '$createdAt'] }, 1000 * 60 * 60] };
      posts = await Post.aggregate([
        { $match: filter },
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

    // Mark which of these posts the current user has liked
    const likedIds = new Set();
    if (req.session.userId && posts.length) {
      const likes = await Like.find({ userId: req.session.userId, postId: { $in: posts.map(p => p._id) } })
        .select('postId').lean();
      likes.forEach(l => likedIds.add(l.postId.toString()));
    }
    posts.forEach(p => {
      p.likeCount = p.likeCount || 0;
      p.likedByMe = likedIds.has(p._id.toString());
    });

    res.json({ posts, nextCursor });
  } catch (error) {
    console.error('Feed fetch error:', error);
    res.status(500).send('An error occurred fetching the feed');
  }
});

//Get posts by username
app.get('/api/posts/:username', async (req, res) => {
  try {
    const posts = await Post.find({ username: req.params.username }).sort({ createdAt: -1 });
    res.json(posts);
  } catch (error) {
    console.error('Post fetch error:', error);
    res.status(500).send('An error occurred fetching posts');
  }
});

app.get('/secret', isAuthenticated, (req, res) => {
  res.send('Welcome');
});

// Registration route with password hashing
app.post('/api/register', registerLimiter, async (req, res) => {
  const { email, username, password } = req.body || {};
  // Must be plain text (not objects like {"$gt": ""}) and not empty
  if (![email, username, password].every(v => typeof v === 'string' && v.trim())) {
    return res.status(400).send('All fields required');
  }
  const normalizedEmail = email.trim().toLowerCase();

  try {
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    const newUser = new User({ email: normalizedEmail, username, password: hashedPassword });
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
      return res.status(409).send(`${field} already exists`);
    }
    console.error('Registration error:', error);
    res.status(500).send('An error occurred during registration');
  }
});

// Login route with password verification
app.post('/api/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  // Must be plain text, so {"$gt": ""} can't be used to match any user
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return res.status(400).send('username and password required');
  }

  try {
    const user = await User.findOne({ username });
    if (!user) return res.status(404).send('User not found');

    const passwordMatch = await bcrypt.compare(password, user.password);
    if (passwordMatch) {
      // New session ID on login so a session ID planted before login can't be reused
      return req.session.regenerate(err => {
        if (err) return res.status(500).send('Login error');
        req.session.userId = user._id.toString();
        req.session.username = user.username;

        req.session.save(err => {
          if (err) return res.status(500).send('Login error');
          return res.json({ username: user.username });
        });
      });
    } else {
      return res.status(401).send('Invalid credentials');
    }
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).send('An error occurred during login');
  }
});

app.get('/api/me', (req, res) => {
  res.json({ username: req.session && req.session.username ? req.session.username : null });
});

app.post("/api/logout", (req, res) => {

  req.session.destroy((err) => {
    if (err) {
      console.error("Error destroying session:", err);
      return res.status(500).json({ error: "Logout failed" });
    }

    res.clearCookie("connect.sid"); 
    res.json({ ok: true });
  });
});
app.listen(port, () => {
  console.log(`Example app listening at http://localhost:${port}`);
});