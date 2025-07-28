require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const socketIo = require('socket.io');
const http = require('http');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/chirper', {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('MongoDB connected'))
.catch(err => console.error('MongoDB connection error:', err));

// User Schema
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  name: { type: String, required: true },
  avatar: { type: String, default: 'US' },
  bio: { type: String, default: '' },
  following: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  followers: { type: Number, default: 0 }
});

// Tweet Schema
const tweetSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  author: { type: String, required: true },
  handle: { type: String, required: true },
  avatar: { type: String, required: true },
  content: { type: String, required: true },
  image: { type: String },
  likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  retweets: { type: Number, default: 0 },
  comments: [{
    user: { 
      _id: mongoose.Schema.Types.ObjectId,
      name: String,
      username: String,
      avatar: String
    },
    content: String,
    createdAt: { type: Date, default: Date.now }
  }],
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Tweet = mongoose.model('Tweet', tweetSchema);

// Middleware
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Authentication middleware
const authenticate = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret_key');
    req.user = await User.findById(decoded.userId);
    if (!req.user) return res.status(401).json({ error: 'User not found' });
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// Image upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

// Routes

// Signup
app.post('/api/signup', async (req, res) => {
  try {
    const { username, password, name } = req.body;
    if (!username || !password || !name) {
      return res.status(400).json({ error: 'Please provide all fields' });
    }

    const existingUser = await User.findOne({ username });
    if (existingUser) {
      return res.status(400).json({ error: 'Username already taken' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const avatar = name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
    const newUser = new User({ username, password: hashedPassword, name, avatar });
    await newUser.save();

    const token = jwt.sign({ userId: newUser._id }, process.env.JWT_SECRET || 'secret_key', { expiresIn: '7d' });
    res.json({ 
      user: { 
        _id: newUser._id,
        username: newUser.username,
        name: newUser.name,
        avatar: newUser.avatar,
        token 
      }, 
      message: 'User created' 
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET || 'secret_key', { expiresIn: '7d' });
    res.json({ 
      user: { 
        _id: user._id,
        username: user.username,
        name: user.name,
        avatar: user.avatar,
        token 
      }, 
      message: 'Login successful' 
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get all tweets
app.get('/api/tweets', async (req, res) => {
  try {
    const tweets = await Tweet.find().sort({ createdAt: -1 });
    res.json(tweets);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Create tweet
app.post('/api/tweets', authenticate, upload.single('image'), async (req, res) => {
  try {
    const { content } = req.body;
    if (!content) {
      return res.status(400).json({ error: 'Content is required' });
    }

    const image = req.file ? `/uploads/${req.file.filename}` : null;
    const newTweet = new Tweet({
      userId: req.user._id,
      author: req.user.name,
      handle: `@${req.user.username}`,
      avatar: req.user.avatar,
      content,
      image
    });

    await newTweet.save();
    io.emit('new-tweet', newTweet);
    res.status(201).json(newTweet);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Like a tweet
app.post('/api/tweets/:id/like', authenticate, async (req, res) => {
  try {
    const tweet = await Tweet.findById(req.params.id);
    if (!tweet) {
      return res.status(404).json({ error: 'Tweet not found' });
    }

    const userId = req.user._id;
    const likeIndex = tweet.likes.indexOf(userId);
    
    if (likeIndex === -1) {
      tweet.likes.push(userId);
    } else {
      tweet.likes.splice(likeIndex, 1);
    }

    await tweet.save();
    io.emit('tweet-liked', tweet);
    res.json(tweet);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Follow a user
app.post('/api/users/:id/follow', authenticate, async (req, res) => {
  try {
    const userToFollow = await User.findById(req.params.id);
    if (!userToFollow) {
      return res.status(404).json({ error: 'User not found' });
    }

    const currentUser = await User.findById(req.user._id);
    if (currentUser.following.includes(userToFollow._id)) {
      return res.status(400).json({ error: 'Already following this user' });
    }

    currentUser.following.push(userToFollow._id);
    userToFollow.followers = (userToFollow.followers || 0) + 1;
    
    await currentUser.save();
    await userToFollow.save();

    io.emit('user-followed', {
      followerId: currentUser._id,
      followedId: userToFollow._id,
      followedUsername: userToFollow.username,
      following: currentUser.following
    });

    res.json({
      following: currentUser.following,
      followedUsername: userToFollow.username
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Unfollow a user
app.delete('/api/users/:id/follow', authenticate, async (req, res) => {
  try {
    const userToUnfollow = await User.findById(req.params.id);
    if (!userToUnfollow) {
      return res.status(404).json({ error: 'User not found' });
    }

    const currentUser = await User.findById(req.user._id);
    const index = currentUser.following.indexOf(userToUnfollow._id);
    if (index === -1) {
      return res.status(400).json({ error: 'Not following this user' });
    }

    currentUser.following.splice(index, 1);
    userToUnfollow.followers = Math.max(0, (userToUnfollow.followers || 0) - 1);
    
    await currentUser.save();
    await userToUnfollow.save();

    io.emit('user-unfollowed', {
      followerId: currentUser._id,
      unfollowedId: userToUnfollow._id,
      unfollowedUsername: userToUnfollow.username,
      following: currentUser.following
    });

    res.json({
      following: currentUser.following,
      unfollowedUsername: userToUnfollow.username
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user's following list
app.get('/api/users/:id/following', async (req, res) => {
  try {
    const user = await User.findById(req.params.id).populate('following', 'username name avatar');
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(user.following);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user profile
app.get('/api/users/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user tweets
app.get('/api/tweets/user/:id', async (req, res) => {
  try {
    const tweets = await Tweet.find({ userId: req.params.id }).sort({ createdAt: -1 });
    res.json(tweets);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Add comment to tweet
app.post('/api/tweets/:id/comment', authenticate, async (req, res) => {
  try {
    const { content } = req.body;
    if (!content) {
      return res.status(400).json({ error: 'Content is required' });
    }

    const tweet = await Tweet.findById(req.params.id);
    if (!tweet) {
      return res.status(404).json({ error: 'Tweet not found' });
    }

    const newComment = {
      user: {
        _id: req.user._id,
        name: req.user.name,
        username: req.user.username,
        avatar: req.user.avatar
      },
      content,
      createdAt: new Date()
    };

    tweet.comments.push(newComment);
    await tweet.save();
    
    const updatedTweet = await Tweet.findById(req.params.id);
    io.emit('tweet-commented', updatedTweet);
    
    res.json(updatedTweet);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Socket.IO connection
io.on('connection', (socket) => {
  console.log('New client connected');

  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
