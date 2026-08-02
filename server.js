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
const port = 3000;
// Serve static files from the 'public' directory
app.use(express.static('public'));
// Routes demonstrating route params, query strings, middleware, and async handling
app.use(express.json()); // for parsing application/json
app.use(express.urlencoded({ extended: true }));
// Cookie parser middleware (must be registered before routes that access req.cookies)
app.use(cookieParser());
// Connect to MongoDB
mongoose.connect('mongodb://localhost:27017/ArtPing')
.then(() => console.log('Connected to MongoDB at mongodb://localhost:27017/ArtPing'))
.catch((err) => console.error('MongoDB connection error:', err));
app.use(session({
  secret: process.env.SESSION_SECRET || 'mysecret',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: 'mongodb://localhost:27017/ArtPing' }),
}));

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
}, { timestamps: true });

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
    res.json(profile);
  } catch (error) {
    console.error('Profile fetch error:', error);
    res.status(500).send('An error occured fetching profile')
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

//Get posts by username
app.get('/api/posts/:username', async (req, res) => {
  try {
    const posts = await Post.find({ username: req.params.username });
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
app.post('/api/register', async (req, res) => {
  const { email, username, password } = req.body || {};
  const normalizedEmail = email.toLowerCase();
  console.log('BODY', { email, username, password });
  if (!email || !username || !password) return res.status(400).send('All fields required');

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
  console.log('Profile created:', newProfile);

    const allUsers = await User.find({});
    console.log("All users in DB:", allUsers);

    return res.json({ username: newUser.username });
 
  } catch (error) {
    console.error('Registration error:', error);
    if (error.code === 11000) {
  const field = Object.keys(error.keyValue)[0];
  return res.status(409).send(`${field} already exists`);
}
    res.status(500).send('An error occurred during registration');
  }
});

// Login route with password verification
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).send('username and password required');

  try {
    const user = await User.findOne({ username });
    if (!user) return res.status(404).send('User not found');

    const passwordMatch = await bcrypt.compare(password, user.password);
    if (passwordMatch) {
      {
    req.session.userId = user._id.toString();
    req.session.username = user.username;
    
    return req.session.save(err => {
      if (err) return res.status(500).send('Login error');
      return res.json({ username: user.username });
    });
      }
      
  
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