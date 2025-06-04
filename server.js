const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ['https://yourusername.github.io/nighthub', 'http://localhost:5500'],
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;

// In-memory storage
const users = new Map();
const chats = new Map();
const requests = new Map();
const tagUsers = new Map();
const bannedUsers = new Map();
const liveUsers = new Map(); // Changed to Map to store viewer counts
let onlineUsers = 0;
let activeChats = 0;
let messagesSent = 0;
let reportsFiled = 0;

const nsfwWords = ['explicit', 'nsfw', 'adult', 'offensive'];

function generateUserId() {
  return crypto.randomBytes(16).toString('hex');
}

function sanitizeInput(input) {
  return input.replace(/<[^>]*>/g, '');
}

function checkNSFW(message, safeMode) {
  if (!safeMode) return false;
  return nsfwWords.some(word => message.toLowerCase().includes(word));
}

function getTrendingTags() {
  const tagCounts = new Map();
  for (const [tag, userSet] of tagUsers) {
    tagCounts.set(tag, userSet.size);
  }
  return [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(entry => entry[0]);
}

function addReport(userId) {
  const user = users.get(userId);
  if (user) {
    user.reports = (user.reports || 0) + 1;
    reportsFiled++;
    if (user.reports >= 30) {
      bannedUsers.set(userId, { duration: Infinity, end: Infinity });
    } else if (user.reports >= 20) {
      bannedUsers.set(userId, { duration: 24 * 60 * 60 * 1000, end: Date.now() + 24 * 60 * 60 * 1000 });
    } else if (user.reports >= 10) {
      bannedUsers.set(userId, { duration: 30 * 60 * 1000, end: Date.now() + 30 * 60 * 1000 });
    }
    if (bannedUsers.has(userId)) {
      const socketId = user.socketId;
      io.to(socketId).emit('error', `You have been banned for ${bannedUsers.get(userId).duration === Infinity ? 'permanently' : `${bannedUsers.get(userId).duration / 60000} minutes`}.`);
      if (user.pairId) {
        const pair = chats.get(user.pairId);
        if (pair) {
          const otherUserId = pair.userIds.find(id => id !== userId);
          io.to(users.get(otherUserId).socketId).emit('disconnected');
          chats.delete(user.pairId);
          activeChats--;
          users.get(otherUserId).pairId = null;
        }
      }
      socketId && io.sockets.sockets.get(socketId)?.disconnect();
      users.delete(userId);
      onlineUsers--;
    }
  }
}

function findMatch(userId, tags) {
  for (const tag of tags) {
    const usersWithTag = tagUsers.get(tag) || new Set();
    for (const otherUserId of usersWithTag) {
      if (otherUserId !== userId && !users.get(otherUserId).pairId) {
        return otherUserId;
      }
    }
  }
  return null;
}

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);
  const userId = generateUserId();
  users.set(userId, { socketId: socket.id, tags: [], safeMode: true, ageConfirmed: false });
  onlineUsers++;
  socket.userId = userId;

  socket.on('join', (tags) => {
    if (bannedUsers.has(userId)) {
      const ban = bannedUsers.get(userId);
      socket.emit('error', `You are banned until ${new Date(ban.end).toISOString()}`);
      return;
    }
    const sanitizedTags = tags.map(sanitizeInput).filter(tag => tag.length > 0);
    users.get(userId).tags = sanitizedTags;
    for (const tag of sanitizedTags) {
      if (!tagUsers.has(tag)) tagUsers.set(tag, new Set());
      tagUsers.get(tag).add(userId);
    }
    const matchId = findMatch(userId, sanitizedTags);
    if (matchId) {
      const pairId = crypto.randomBytes(8).toString('hex');
      users.get(userId).pairId = pairId;
      users.get(matchId).pairId = pairId;
      chats.set(pairId, { userIds: [userId, matchId], reports: 0 });
      activeChats++;
      io.to(socket.id).emit('paired');
      io.to(users.get(matchId).socketId).emit('paired');
    } else {
      socket.emit('rejoin');
    }
  });

  socket.on('message', (msg) => {
    const user = users.get(userId);
    if (!user || !user.pairId) {
      socket.emit('error', 'Not in a chat');
      return;
    }
    const sanitizedMsg = sanitizeInput(msg);
    if (checkNSFW(sanitizedMsg, user.safeMode)) {
      socket.emit('error', 'Message blocked by NSFW filter');
      return;
    }
    const pair = chats.get(user.pairId);
    if (pair) {
      const otherUserId = pair.userIds.find(id => id !== userId);
      io.to(users.get(otherUserId).socketId).emit('message', sanitizedMsg);
      messagesSent++;
      io.to(users.get(userId).socketId).emit('admin_message', { pairId: user.pairId, userId, message: sanitizedMsg });
      io.to(users.get(otherUserId).socketId).emit('admin_message', { pairId: user.pairId, userId, message: sanitizedMsg });
    }
  });

  socket.on('typing', (isTyping) => {
    const user = users.get(userId);
    if (user && user.pairId) {
      const pair = chats.get(user.pairId);
      if (pair) {
        const otherUserId = pair.userIds.find(id => id !== userId);
        io.to(users.get(otherUserId).socketId).emit('typing', isTyping);
      }
    }
  });

  socket.on('leave', () => {
    const user = users.get(userId);
    if (user && user.pairId) {
      const pairId = user.pairId;
      const pair = chats.get(pairId);
      if (pair) {
        let seconds = 5;
        const countdown = setInterval(() => {
          socket.emit('countdown', seconds);
          io.to(users.get(pair.userIds.find(id => id !== userId)).socketId).emit('countdown', seconds);
          seconds--;
          if (seconds < 0) {
            clearInterval(countdown);
            const otherUserId = pair.userIds.find(id => id !== userId);
            io.to(users.get(otherUserId).socketId).emit('disconnected');
            chats.delete(pairId);
            activeChats--;
            users.get(otherUserId).pairId = null;
            socket.emit('rejoin');
            user.pairId = null;
          }
        }, 1000);
        socket.countdown = countdown;
      }
    }
  });

  socket.on('cancel_disconnect', () => {
    if (socket.countdown) {
      clearInterval(socket.countdown);
      const user = users.get(userId);
      if (user && user.pairId) {
        const pair = chats.get(user.pairId);
        if (pair) {
          const otherUserId = pair.userIds.find(id => id !== userId);
          io.to(socket.id).emit('countdown_cancelled');
          io.to(users.get(otherUserId).socketId).emit('countdown_cancelled');
        }
      }
    }
  });

  socket.on('report', ({ timestamp }) => {
    const user = users.get(userId);
    if (user && user.pairId) {
      const pair = chats.get(user.pairId);
      if (pair) {
        pair.reports = (pair.reports || 0) + 1;
        const otherUserId = pair.userIds.find(id => id !== userId);
        addReport(otherUserId);
      }
    }
  });

  socket.on('submit_request', ({ name, email, message }) => {
    const requestId = crypto.randomBytes(8).toString('hex');
    requests.set(requestId, {
      name: sanitizeInput(name || 'Anonymous'),
      email: sanitizeInput(email || 'No email provided'),
      message: sanitizeInput(message),
      timestamp: new Date().toISOString()
    });
    socket.emit('request_success', 'Request submitted successfully');
    console.log(`Request stored: ${requestId}`);
  });

  socket.on('get_trending_tags', () => {
    socket.emit('trending_tags', getTrendingTags());
  });

  socket.on('admin_login', ({ key }) => {
    if (key === 'ekandmc') {
      socket.join('admin');
      socket.emit('admin_data', {
        onlineUsers,
        activeChats,
        messagesSent,
        reportsFiled,
        users: [...users.entries()].map(([id, user]) => ({
          userId: id,
          socketId: user.socketId,
          reports: user.reports || 0,
          isBanned: bannedUsers.has(id),
          banDuration: bannedUsers.get(id)?.duration,
          banEnd: bannedUsers.get(id)?.end
        })),
        chats: [...chats.entries()].map(([pairId, chat]) => ({
          pairId,
          userIds: chat.userIds,
          reports: chat.reports || 0
        }))
      });
    } else {
      socket.emit('error', 'Invalid admin key');
    }
  });

  socket.on('admin_ban', ({ userId, duration }) => {
    if (socket.rooms.has('admin')) {
      bannedUsers.set(userId, { duration, end: Date.now() + duration });
      addReport(userId);
    }
  });

  socket.on('admin_unban', ({ userId }) => {
    if (socket.rooms.has('admin')) {
      bannedUsers.delete(userId);
      const user = users.get(userId);
      if (user) {
        user.reports = 0;
        io.to(user.socketId).emit('request_success', 'You have been unbanned');
      }
    }
  });

  socket.on('admin_observe_chat', ({ pairId }) => {
    if (socket.rooms.has('admin')) {
      socket.join(`chat:${pairId}`);
    }
  });

  socket.on('admin_leave_chat', ({ pairId }) => {
    if (socket.rooms.has('admin')) {
      socket.leave(`chat:${pairId}`);
    }
  });

  // Video call signaling
  socket.on('start_video_call', () => {
    const user = users.get(userId);
    if (user && user.pairId) {
      const pair = chats.get(user.pairId);
      if (pair) {
        const otherUserId = pair.userIds.find(id => id !== userId);
        io.to(users.get(otherUserId).socketId).emit('start_video_call');
      }
    }
  });

  socket.on('webrtc_signal', (data) => {
    const user = users.get(userId);
    if (user && user.pairId) {
      const pair = chats.get(user.pairId);
      if (pair) {
        const otherUserId = pair.userIds.find(id => id !== userId);
        io.to(users.get(otherUserId).socketId).emit('webrtc_signal', data);
      }
    } else if (data.liveId) {
      io.to(`live:${data.liveId}`).emit('webrtc_signal', data.signal);
    }
  });

  // Live streaming
  socket.on('start_live', ({ userId: liveUserId }) => {
    liveUsers.set(liveUserId, { viewers: 0 });
    io.emit('live_list', [...liveUsers.keys()]);
  });

  socket.on('join_live', ({ liveId }) => {
    socket.join(`live:${liveId}`);
    if (liveUsers.has(liveId)) {
      liveUsers.get(liveId).viewers++;
      io.to(`live:${liveId}`).emit('viewer_count', liveUsers.get(liveId).viewers);
    }
  });

  socket.on('leave_live', ({ liveId }) => {
    socket.leave(`live:${liveId}`);
    if (liveUsers.has(liveId)) {
      liveUsers.get(liveId).viewers = Math.max(0, liveUsers.get(liveId).viewers - 1);
      io.to(`live:${liveId}`).emit('viewer_count', liveUsers.get(liveId).viewers);
    }
  });

  socket.on('live_comment', ({ liveId, comment }) => {
    io.to(`live:${liveId}`).emit('live_comment', { userId: socket.id, comment: sanitizeInput(comment) });
  });

  socket.on('get_live_list', () => {
    socket.emit('live_list', [...liveUsers.keys()]);
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    const user = users.get(userId);
    if (user) {
      for (const tag of user.tags) {
        tagUsers.get(tag)?.delete(userId);
      }
      if (user.pairId) {
        const pair = chats.get(user.pairId);
        if (pair) {
          const otherUserId = pair.userIds.find(id => id !== userId);
          io.to(users.get(otherUserId).socketId).emit('disconnected');
          chats.delete(user.pairId);
          activeChats--;
          users.get(otherUserId).pairId = null;
        }
      }
      if (liveUsers.has(userId)) {
        io.to(`live:${userId}`).emit('live_ended');
        liveUsers.delete(userId);
      }
      users.delete(userId);
      onlineUsers--;
      io.emit('live_list', [...liveUsers.keys()]);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
