require('dotenv').config();
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
app.listen(port, () => {
  console.log(`Example app listening at http://localhost:${port}`);
});
mongoose.connect('mongodb://localhost:27017/ArtPing')
.then(() => console.log('Connected to MongoDB at mongodb://localhost:27017/ArtPing'))
.catch((err) => console.error('MongoDB connection error:', err));
app.use(session({
  secret: process.env.SESSION_SECRET || 'mysecret',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: 'mongodb://localhost:27017/ArtPing' }),
}));

// Simple Mongoose User schema/model (used by register/login)
const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  password: { type: String, required: true },
}, { timestamps: true });
const User = mongoose.model('User', userSchema);
// console log to show server.js is running
console.log("Server file started");
// global error handlers to surface why process may be exiting
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason && reason.stack ? reason.stack : reason);
});
// Middleware to log profile requests
app.post('/profile', (req, res, next) => {
  console.log('req.body', req.body);
  res.json(req.body)
});
app.use((req, res, next) => {
  console.dir(req.cookies && req.cookies.name);
  next();
});

app.get('/secret',
  (req, res, next) => { if (!req.user) return res.status(401).send('No'); next(); },
  (req, res) => { res.send('Welcome'); 
});
// Registration route with password hashing
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body || {};
  console.log('BODY', { username });
  if (!username || !password) return res.status(400).send('username and password required');

  try {
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    const newUser = new User({ username, password: hashedPassword });
    await newUser.save();

    const allUsers = await User.find({});
    console.log("All users in DB:", allUsers);

    return res.redirect(`/index.html?newuser=${encodeURIComponent(username)}`);
 
  } catch (error) {
    console.error('Registration error:', error);
    if (error.code === 11000) return res.status(409).send('Username already exists');
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
      return res.redirect(`/index.html?user=${encodeURIComponent(user.username)}`);
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
