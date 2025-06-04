const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const Filter = require('bad-words');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.static('public'));

// MongoDB connection
mongoose.connect('mongodb+srv://<username>:<password>@cluster0.mongodb.net/nighthub?retryWrites=true&w=majority', {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB connection error:', err));

// Schemas
const userSchema = new mongoose.Schema({
  sessionId: String,
  socketId: String,
  tags: [String],
  isBanned: { type: Boolean, default: false },
  isAdmin: { type: Boolean, default: false }
});
const User = mongoose.model('User', userSchema);

const postSchema = new mongoose.Schema({
  text: String,
  hashtags: [String],
  upvotes: { type: Number, default: 0 },
  downvotes: { type: Number, default: 0 },
  userId: String,
  anonymousId: String,
  createdAt: { type: Date, default: Date.now }
});
const Post = mongoose.model('Post', postSchema);

const commentSchema = new mongoose.Schema({
  postId: String,
  parentId: String,
  text: String,
  upvotes: { type: Number, default: 0 },
  downvotes: { type: Number, default: 0 },
  userId: String,
  anonymousId: String,
  createdAt: { type: Date, default: Date.now }
});
const Comment = mongoose.model('Comment', commentSchema);

const voteSchema = new mongoose.Schema({
  userId: String,
  postId: String,
  commentId: String,
  voteType: String // 'up' or 'down'
});
const Vote = mongoose.model('Vote', voteSchema);

// NSFW filter
const filter = new Filter();
filter.addWords('sex', 'porn', 'nude', 'xxx'); // Extend as needed

// State
const users = new Map();
const pairs = new Map();
const waitingUsers = new Set();
const waitingVideoUsers = new Set();

// Utility functions
function generateSessionId() {
  return Math.random().toString(36).substring(2, 15);
}

function generateAnonymousId() {
  return 'Anon_' + Math.random().toString(36).substring(2, 10);
}

function extractHashtags(text) {
  return (text.match(/#\w+/g) || []).map(tag => tag.slice(1).toLowerCase());
}

// Update trending hashtags every 5 minutes
async function updateTrendingHashtags() {
  const hashtags = await Post.aggregate([
    { $unwind: '$hashtags' },
    { $group: { _id: { hashtag: '$hashtags', userId: '$userId' } } },
    { $group: { _id: '$_id.hashtag', userCount: { $sum: 1 } } },
    { $sort: { userCount: -1 } },
    { $limit: 10 }
  ]);
  io.emit('trending_update', hashtags.map(h => h._id));
}
setInterval(updateTrendingHashtags, 300000); // 5 minutes

// Socket.IO connection
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Initialize user
  const sessionId = generateSessionId();
  const user = new User({
    sessionId,
    socketId: socket.id,
    tags: [],
    isAdmin: socket.id === 'admin_socket_id' // Example admin check
  });
  user.save().then(() => {
    users.set(socket.id, user);
    socket.emit('admin_status', user.isAdmin);
  });

  socket.on('join', async (tags) => {
    if (users.get(socket.id).isBanned) {
      socket.emit('banned');
      socket.disconnect();
      return;
    }
    user.tags = tags.map(tag => tag.toLowerCase());
    await user.save();
    users.set(socket.id, user);
    waitingUsers.add(socket.id);
    waitingVideoUsers.add(socket.id);
    socket.emit('waiting_for_pair');
  });

  socket.on('start_chat', async ({ pairId }) => {
    if (pairs.has(socket.id)) {
      socket.emit('error', 'Already in a chat');
      return;
    }
    const partner = Array.from(users.values()).find(u => u.sessionId === pairId && !u.isBanned);
    if (!partner) {
      socket.emit('error', 'Partner not found');
      return;
    }
    pairs.set(socket.id, partner.socketId);
    pairs.set(partner.socketId, socket.id);
    waitingUsers.delete(socket.id);
    waitingUsers.delete(partner.socketId);
    socket.emit('paired', partner.sessionId);
    io.to(partner.socketId).emit('paired', sessionId);
  });

  socket.on('start_random_chat', async () => {
    if (pairs.has(socket.id)) {
      socket.emit('error', 'Already in a chat');
      return;
    }
    waitingUsers.delete(socket.id);
    const availableUsers = Array.from(waitingUsers).filter(id => id !== socket.id && !users.get(id).isBanned);
    if (availableUsers.length === 0) {
      waitingUsers.add(socket.id);
      socket.emit('waiting_for_pair');
      return;
    }
    const partnerId = availableUsers[Math.floor(Math.random() * availableUsers.length)];
    const partner = users.get(partnerId);
    pairs.set(socket.id, partnerId);
    pairs.set(partnerId, socket.id);
    waitingUsers.delete(partnerId);
    socket.emit('paired', partner.sessionId);
    io.to(partnerId).emit('paired', sessionId);
  });

  socket.on('start_video_call', async ({ pairId }) => {
    if (pairs.has(socket.id)) {
      socket.emit('error', 'Already in a call');
      return;
    }
    const partner = Array.from(users.values()).find(u => u.sessionId === pairId && !u.isBanned);
    if (!partner) {
      socket.emit('error', 'Partner not found');
      return;
    }
    pairs.set(socket.id, partner.socketId);
    pairs.set(partner.socketId, socket.id);
    waitingVideoUsers.delete(socket.id);
    waitingVideoUsers.delete(partner.socketId);
    socket.emit('start_video_call', partner.sessionId);
    io.to(partner.socketId).emit('start_video_call', sessionId);
  });

  socket.on('start_random_video', async () => {
    if (pairs.has(socket.id)) {
      socket.emit('error', 'Already in a call');
      return;
    }
    waitingVideoUsers.delete(socket.id);
    const availableUsers = Array.from(waitingVideoUsers).filter(id => id !== socket.id && !users.get(id).isBanned);
    if (availableUsers.length === 0) {
      waitingVideoUsers.add(socket.id);
      socket.emit('waiting_for_pair');
      return;
    }
    const partnerId = availableUsers[Math.floor(Math.random() * availableUsers.length)];
    const partner = users.get(partnerId);
    pairs.set(socket.id, partnerId);
    pairs.set(partnerId, socket.id);
    waitingVideoUsers.delete(partnerId);
    socket.emit('paired', partner.sessionId);
    io.to(partnerId).emit('paired', sessionId);
  });

  socket.on('message', (msg) => {
    const partnerId = pairs.get(socket.id);
    if (partnerId) {
      io.to(partnerId).emit('message', msg);
    }
  });

  socket.on('webrtc_signal', (data) => {
    const partnerId = pairs.get(socket.id);
    if (partnerId) {
      io.to(partnerId).emit('webrtc_signal', data);
    }
  });

  socket.on('new_post', async (text) => {
    if (users.get(socket.id).isBanned) {
      socket.emit('banned');
      return;
    }
    const words = text.split(/\s+/).filter(w => w).length;
    if (words > 100) {
      socket.emit('error', 'Post exceeds 100 words');
      return;
    }
    if (filter.isProfane(text)) {
      socket.emit('error', 'Post contains inappropriate content');
      return;
    }
    const hashtags = extractHashtags(text);
    const post = new Post({
      text,
      hashtags,
      userId: sessionId,
      anonymousId: generateAnonymousId()
    });
    await post.save();
    io.emit('post', { ...post.toObject(), comments: [] });
  });

  socket.on('new_comment', async ({ postId, parentId, text }) => {
    if (users.get(socket.id).isBanned) {
      socket.emit('banned');
      return;
    }
    if (filter.isProfane(text)) {
      socket.emit('error', 'Comment contains inappropriate content');
      return;
    }
    const comment = new Comment({
      postId,
      parentId,
      text,
      userId: sessionId,
      anonymousId: generateAnonymousId()
    });
    await comment.save();
    io.emit('comment', { postId, comment: comment.toObject() });
  });

  socket.on('vote_post', async ({ id, vote }) => {
    if (users.get(socket.id).isBanned) {
      socket.emit('banned');
      return;
    }
    const existingVote = await Vote.findOne({ userId: sessionId, postId: id });
    if (existingVote) {
      socket.emit('error', 'Already voted');
      return;
    }
    const post = await Post.findById(id);
    if (!post) {
      socket.emit('error', 'Post not found');
      return;
    }
    if (vote === 'up') {
      post.upvotes += 1;
    } else {
      post.downvotes += 1;
    }
    await post.save();
    await new Vote({ userId: sessionId, postId: id, voteType: vote }).save();
    io.emit('vote_update', { type: 'post', id, upvotes: post.upvotes, downvotes: post.downvotes });
  });

  socket.on('vote_comment', async ({ id, vote }) => {
    if (users.get(socket.id).isBanned) {
      socket.emit('banned');
      return;
    }
    const existingVote = await Vote.findOne({ userId: sessionId, commentId: id });
    if (existingVote) {
      socket.emit('error', 'Already voted');
      return;
    }
    const comment = await Comment.findById(id);
    if (!comment) {
      socket.emit('error', 'Comment not found');
      return;
    }
    if (vote === 'up') {
      comment.upvotes += 1;
    } else {
      comment.downvotes += 1;
    }
    await comment.save();
    await new Vote({ userId: sessionId, commentId: id, voteType: vote }).save();
    io.emit('vote_update', { type: 'comment', id, upvotes: comment.upvotes, downvotes: comment.downvotes });
  });

  socket.on('get_trending', async () => {
    // Trigger immediate update
    await updateTrendingHashtags();
  });

  socket.on('get_randos', async () => {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const posts = await Post.find({ createdAt: { $gte: startOfDay } })
      .sort({ createdAt: -1 })
      .limit(10);
    const postsWithComments = await Promise.all(posts.map(async post => ({
      ...post.toObject(),
      comments: await Comment.find({ postId: post._id, parentId: null })
    })));
    socket.emit('randos_update', postsWithComments);
  });

  socket.on('get_new', async () => {
    const posts = await Post.find()
      .sort({ createdAt: -1 })
      .limit(10);
    const postsWithComments = await Promise.all(posts.map(async post => ({
      ...post.toObject(),
      comments: await Comment.find({ postId: post._id, parentId: null })
    })));
    socket.emit('new_posts', postsWithComments);
  });

  socket.on('get_hashtag_posts', async (hashtag) => {
    const posts = await Post.find({ hashtags: hashtag.toLowerCase() })
      .sort({ createdAt: -1 })
      .limit(10);
    const postsWithComments = await Promise.all(posts.map(async post => ({
      ...post.toObject(),
      comments: await Comment.find({ postId: post._id, parentId: null })
    })));
    socket.emit('hashtag_posts', postsWithComments);
  });

  socket.on('admin_ban', async (userId) => {
    if (!users.get(socket.id).isAdmin) {
      socket.emit('error', 'Not authorized');
      return;
    }
    const user = await User.findOne({ sessionId: userId });
    if (!user) {
      socket.emit('error', 'User not found');
      return;
    }
    user.isBanned = true;
    await user.save();
    io.to(user.socketId).emit('banned');
    io.to(user.socketId).disconnectSockets();
  });

  socket.on('get_trending_tags', async () => {
    const tags = await User.aggregate([
      { $unwind: '$tags' },
      { $group: { _id: '$tags', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);
    socket.emit('trending_tags', tags.map(t => t._id));
  });

  socket.on('leave', () => {
    const partnerId = pairs.get(socket.id);
    if (partnerId) {
      io.to(partnerId).emit('disconnected');
      pairs.delete(partnerId);
    }
    pairs.delete(socket.id);
    waitingUsers.delete(socket.id);
    waitingVideoUsers.delete(socket.id);
  });

  socket.on('disconnect', () => {
    const partnerId = pairs.get(socket.id);
    if (partnerId) {
      io.to(partnerId).emit('disconnected');
      pairs.delete(partnerId);
    }
    pairs.delete(socket.id);
    waitingUsers.delete(socket.id);
    waitingVideoUsers.delete(socket.id);
    users.delete(socket.id);
    User.deleteOne({ socketId: socket.id }).exec();
    console.log('User disconnected:', socket.id);
  });
});

// Intervals for Randos and New posts
setInterval(async () => {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const posts = await Post.find({ createdAt: { $gte: startOfDay } })
    .sort({ createdAt: -1 })
    .limit(10);
  const postsWithComments = await Promise.all(posts.map(async post => ({
    ...post.toObject(),
    comments: await Comment.find({ postId: post._id, parentId: null })
  })));
  io.emit('randos_update', postsWithComments);
}, 60000);

setInterval(async () => {
  const posts = await Post.find()
    .sort({ createdAt: -1 })
    .limit(10);
  const postsWithComments = await Promise.all(posts.map(async post => ({
    ...post.toObject(),
    comments: await Comment.find({ postId: post._id, parentId: null })
  })));
  io.emit('new_posts', postsWithComments);
}, 1000);

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
