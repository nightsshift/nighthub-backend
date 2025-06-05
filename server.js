const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// MongoDB connection
mongoose.connect('mongodb://localhost/nighthub', {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('MongoDB connected')).catch(err => console.error('MongoDB connection error:', err));

// Schemas
const PostSchema = new mongoose.Schema({
  anonymousId: String,
  content: String,
  timestamp: { type: Date, default: Date.now },
  likes: { type: Number, default: 0 },
  comments: [{
    anonymousId: String,
    content: String,
    timestamp: { type: Date, default: Date.now },
    likes: { type: Number, default: 0 }
  }]
});

const UserSchema = new mongoose.Schema({
  anonymousId: String,
  lastActive: { type: Date, default: Date.now },
  isBanned: { type: Boolean, default: false },
  banExpires: { type: Date, default: null }
});

const Post = mongoose.model('Post', PostSchema);
const User = mongoose.model('User', UserSchema);

// Middleware
app.use(express.static(path.join(__dirname, 'public')));

// Clean URL routing
const pages = ['index', 'chat', 'video', 'social', 'admin', 'live'];
pages.forEach(page => {
  app.get(`/${page}`, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', `${page}.html`));
  });
});

// Redirect root to /index
app.get('/', (req, res) => {
  res.redirect('/index');
});

// Socket.IO logic
let waitingUsers = [];
let activePairs = new Map();
const posts = [];
const users = new Map();

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join', (tags) => {
    socket.tags = tags;
    waitingUsers.push(socket);
    if (waitingUsers.length >= 2) {
      const user1 = waitingUsers.shift();
      const user2 = waitingUsers.shift();
      const pairId = `${user1.id}-${user2.id}`;
      activePairs.set(user1.id, { partner: user2.id, pairId });
      activePairs.set(user2.id, { partner: user1.id, pairId });
      user1.emit('paired', pairId);
      user2.emit('paired', pairId);
    } else {
      socket.emit('waiting_for_pair');
    }
  });

  socket.on('start_random_video', () => {
    if (!waitingUsers.includes(socket) && !activePairs.has(socket.id)) {
      waitingUsers.push(socket);
      if (waitingUsers.length >= 2) {
        const user1 = waitingUsers.shift();
        const user2 = waitingUsers.shift();
        const pairId = `${user1.id}-${user2.id}`;
        activePairs.set(user1.id, { partner: user2.id, pairId });
        activePairs.set(user2.id, { partner: user1.id, pairId });
        user1.emit('paired', pairId);
        user2.emit('paired', pairId);
      } else {
        socket.emit('waiting_for_pair');
      }
    }
  });

  socket.on('start_video_call', ({ pairId }) => {
    if (activePairs.has(socket.id)) {
      socket.emit('start_video_call', pairId);
    }
  });

  socket.on('webrtc_signal', (data) => {
    const pair = activePairs.get(socket.id);
    if (pair) {
      io.to(pair.partner).emit('webrtc_signal', data);
    }
  });

  socket.on('message', (msg) => {
    const pair = activePairs.get(socket.id);
    if (pair) {
      io.to(pair.partner).emit('message', msg);
    }
  });

  socket.on('leave', () => {
    const pair = activePairs.get(socket.id);
    if (pair) {
      io.to(pair.partner).emit('disconnected');
      activePairs.delete(pair.partner);
      activePairs.delete(socket.id);
    }
    waitingUsers = waitingUsers.filter(user => user.id !== socket.id);
  });

  socket.on('get_trending_tags', () => {
    socket.emit('trending_tags', ['chat', 'video', 'random', 'fun']);
  });

  socket.on('create_post', async (content) => {
    const anonymousId = socket.id.slice(0, 6);
    const post = new Post({ anonymousId, content });
    await post.save();
    io.emit('new_post', post);
  });

  socket.on('get_posts', async () => {
    const posts = await Post.find().sort({ timestamp: -1 });
    socket.emit('posts', posts);
  });

  socket.on('create_comment', async ({ postId, content }) => {
    const anonymousId = socket.id.slice(0, 6);
    const post = await Post.findById(postId);
    if (post) {
      post.comments.push({ anonymousId, content });
      await post.save();
      io.emit('new_comment', { postId, comment: post.comments[post.comments.length - 1] });
    }
  });

  socket.on('like_post', async (postId) => {
    const post = await Post.findById(postId);
    if (post) {
      post.likes += 1;
      await post.save();
      io.emit('like_post', { postId, likes: post.likes });
    }
  });

  socket.on('like_comment', async ({ postId, commentId }) => {
    const post = await Post.findById(postId);
    if (post) {
      const comment = post.comments.id(commentId);
      if (comment) {
        comment.likes += 1;
        await post.save();
        io.emit('like_comment', { postId, commentId, likes: comment.likes });
      }
    }
  });

  socket.on('admin_login', async (password) => {
    if (password === 'admin123') {
      socket.isAdmin = true;
      socket.emit('admin_authenticated');
    } else {
      socket.emit('error', 'Invalid admin password');
    }
  });

  socket.on('admin_get_posts', async () => {
    if (socket.isAdmin) {
      const posts = await Post.find().sort({ timestamp: -1 });
      socket.emit('admin_posts', posts);
    }
  });

  socket.on('admin_get_users', async () => {
    if (socket.isAdmin) {
      const users = await User.find();
      socket.emit('admin_users', users);
    }
  });

  socket.on('admin_get_streams', () => {
    if (socket.isAdmin) {
      socket.emit('admin_streams', [{ id: 'stream1', startTime: Date.now(), status: 'live' }]);
    }
  });

  socket.on('admin_delete_post', async (postId) => {
    if (socket.isAdmin) {
      await Post.findByIdAndDelete(postId);
      socket.emit('admin_posts', await Post.find().sort({ timestamp: -1 }));
    }
  });

  socket.on('admin_delete_comment', async ({ postId, commentId }) => {
    if (socket.isAdmin) {
      const post = await Post.findById(postId);
      if (post) {
        post.comments.id(commentId).remove();
        await post.save();
        socket.emit('admin_posts', await Post.find().sort({ timestamp: -1 }));
      }
    }
  });

  socket.on('admin_temp_ban_user', async (anonymousId) => {
    if (socket.isAdmin) {
      let user = await User.findOne({ anonymousId });
      if (!user) {
        user = new User({ anonymousId });
      }
      user.isBanned = true;
      user.banExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await user.save();
      socket.emit('admin_users', await User.find());
    }
  });

  socket.on('admin_perm_ban_user', async (anonymousId) => {
    if (socket.isAdmin) {
      let user = await User.findOne({ anonymousId });
      if (!user) {
        user = new User({ anonymousId });
      }
      user.isBanned = !user.isBanned;
      user.banExpires = null;
      await user.save();
      socket.emit('admin_users', await User.find());
    }
  });

  socket.on('admin_announcement', (text) => {
    if (socket.isAdmin) {
      io.emit('announcement', text);
    }
  });

  socket.on('disconnect', () => {
    const pair = activePairs.get(socket.id);
    if (pair) {
      io.to(pair.partner).emit('disconnected');
      activePairs.delete(pair.partner);
      activePairs.delete(socket.id);
    }
    waitingUsers = waitingUsers.filter(user => user.id !== socket.id);
    console.log('User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
