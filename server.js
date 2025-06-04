const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
  cors: {
    origin: ['https://nighthub.io', 'https://yourusername.github.io/nighthub'],
    methods: ['GET', 'POST'],
    credentials: true
  }
});
const Filter = require('bad-words');
const filter = new Filter();
const port = process.env.PORT || 3000;

// In-memory storage (replace with database for persistence)
let waitingUsers = [];
let pairedUsers = {};
let reports = {};
let requests = [];
let safeModeUsers = new Set();
let tags = {};
let quotes = [];
let quoteIdCounter = 0;

// NSFW filter
function isNSFW(message, safeMode) {
  return safeMode && filter.isProfane(message);
}

// Generate unique quote ID
function generateQuoteId() {
  return quoteIdCounter++;
}

// Track tag usage
function updateTagUsage(userTags) {
  userTags.forEach(tag => {
    tags[tag] = (tags[tag] || 0) + 1;
  });
}

// Get trending tags (top 5 in last 24 hours)
function getTrendingTags() {
  const sortedTags = Object.entries(tags)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(entry => entry[0]);
  return sortedTags.length > 0 ? sortedTags : ['coding', 'movies', 'music', 'gaming', 'books'];
}

// Match users based on tags
function findBestMatch(socket, userTags) {
  let bestMatch = null;
  let maxCommonTags = -1;

  waitingUsers.forEach(user => {
    if (user.id !== socket.id) {
      const commonTags = user.tags.filter(tag => userTags.includes(tag));
      if (commonTags.length > maxCommonTags) {
        maxCommonTags = commonTags.length;
        bestMatch = user;
      }
    }
  });

  return bestMatch;
}

// Clean up user data
function cleanupUser(socketId) {
  waitingUsers = waitingUsers.filter(user => user.id !== socketId);
  if (pairedUsers[socketId]) {
    const partnerId = pairedUsers[socketId];
    delete pairedUsers[partnerId];
    delete pairedUsers[socketId];
    io.to(partnerId).emit('disconnected');
  }
}

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('join', (userTags = []) => {
    console.log(`Join request from ${socket.id} with tags: ${userTags}`);
    cleanupUser(socket.id);
    updateTagUsage(userTags);

    const user = { id: socket.id, tags: userTags };
    const match = findBestMatch(socket, userTags);

    if (match) {
      waitingUsers = waitingUsers.filter(u => u.id !== match.id);
      pairedUsers[socket.id] = match.id;
      pairedUsers[match.id] = socket.id;
      io.to(socket.id).emit('paired');
      io.to(match.id).emit('paired');
      console.log(`Paired ${socket.id} with ${match.id}`);
    } else {
      waitingUsers.push(user);
      console.log(`User ${socket.id} added to waiting list`);
    }
  });

  socket.on('message', (msg) => {
    console.log(`Message from ${socket.id}: ${msg}`);
    const partnerId = pairedUsers[socket.id];
    const safeMode = safeModeUsers.has(socket.id) || safeModeUsers.has(partnerId);

    if (partnerId && !isNSFW(msg, safeMode)) {
      io.to(partnerId).emit('message', msg);
    } else if (partnerId) {
      socket.emit('error', 'Message blocked by NSFW filter.');
    }
  });

  socket.on('typing', (isTyping) => {
    console.log(`Typing event from ${socket.id}: ${isTyping}`);
    const partnerId = pairedUsers[socket.id];
    if (partnerId) {
      io.to(partnerId).emit('typing', isTyping);
    }
  });

  socket.on('leave', () => {
    console.log(`Leave request from ${socket.id}`);
    const partnerId = pairedUsers[socket.id];
    if (partnerId) {
      let countdown = 5;
      const interval = setInterval(() => {
        io.to(socket.id).emit('countdown', countdown);
        io.to(partnerId).emit('countdown', countdown);
        countdown--;
        if (countdown < 0) {
          clearInterval(interval);
          cleanupUser(socket.id);
          io.to(socket.id).emit('disconnected');
        }
      }, 1000);
      socket.interval = interval;
    } else {
      cleanupUser(socket.id);
      socket.emit('disconnected');
    }
  });

  socket.on('cancel_disconnect', () => {
    console.log(`Cancel disconnect from ${socket.id}`);
    if (socket.interval) {
      clearInterval(socket.interval);
      const partnerId = pairedUsers[socket.id];
      if (partnerId) {
        io.to(socket.id).emit('countdown_cancelled');
        io.to(partnerId).emit('countdown_cancelled');
      }
    }
  });

  socket.on('report', (data) => {
    console.log(`Report from ${socket.id}:`, data);
    const partnerId = pairedUsers[socket.id];
    if (partnerId) {
      reports[partnerId] = (reports[partnerId] || 0) + 1;
      console.log(`Reports for ${partnerId}: ${reports[partnerId]}`);
      if (reports[partnerId] >= 30) {
        io.to(partnerId).emit('error', 'You have been permanently banned due to multiple reports.');
        io.sockets.sockets.get(partnerId)?.disconnect();
      } else if (reports[partnerId] >= 20) {
        io.to(partnerId).emit('error', 'You have been banned for 24 hours due to multiple reports.');
        io.sockets.sockets.get(partnerId)?.disconnect();
      } else if (reports[partnerId] >= 10) {
        io.to(partnerId).emit('error', 'You have been banned for 1 hour due to multiple reports.');
        io.sockets.sockets.get(partnerId)?.disconnect();
      }
      socket.emit('error', 'User reported to moderators.');
    }
  });

  socket.on('toggle_safe_mode', (safeMode) => {
    console.log(`Safe Mode toggle from ${socket.id}: ${safeMode}`);
    if (safeMode) {
      safeModeUsers.add(socket.id);
    } else {
      safeModeUsers.delete(socket.id);
    }
  });

  socket.on('submit_request', (request) => {
    console.log(`Request from ${socket.id}:`, request);
    if (!request.message) {
      socket.emit('error', 'Message is required for contact requests.');
      return;
    }
    const requestId = requests.length;
    requests.push({ id: requestId, ...request, timestamp: new Date().toISOString() });
    socket.emit('request_success', 'Your request was submitted successfully.');
    console.log(`Request stored: ${requestId}`);
  });

  socket.on('get_trending_tags', () => {
    socket.emit('trending_tags', getTrendingTags());
  });

  socket.on('save_quote', (text) => {
    console.log(`Quote save request from ${socket.id}: ${text}`);
    if (text.length > 500) {
      socket.emit('error', 'Quote is too long (max 500 characters).');
      return;
    }
    const quote = {
      id: generateQuoteId(),
      text,
      timestamp: new Date().toISOString(),
      votes: 0
    };
    quotes.push(quote);
    socket.emit('quote_saved', 'Quote saved to vault.');
    io.emit('vault_quotes', quotes);
  });

  socket.on('vote_quote', ({ quoteId, voteType }) => {
    console.log(`Vote request from ${socket.id} for quote ${quoteId}: ${voteType}`);
    const quote = quotes.find(q => q.id === parseInt(quoteId));
    if (quote) {
      if (voteType === 'upvote') {
        quote.votes += 1;
      } else if (voteType === 'downvote') {
        quote.votes -= 1;
      }
      io.emit('vault_quotes', quotes);
    }
  });

  socket.on('get_vault_quotes', () => {
    socket.emit('vault_quotes', quotes);
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    cleanupUser(socket.id);
    safeModeUsers.delete(socket.id);
  });
});

// Admin endpoint to view requests
app.get('/admin/requests', (req, res) => {
  const authHeader = req.headers['authorization'];
  const adminSecret = process.env.ADMIN_SECRET || 'your-admin-secret';
  if (authHeader !== `Bearer ${adminSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json(requests);
});

http.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
