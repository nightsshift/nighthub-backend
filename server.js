const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: 'https://yourusername.github.io', // Replace with your GitHub Pages URL (e.g., https://username.github.io/nighthub)
    methods: ['GET', 'POST']
  }
});

// In-memory storage for users and chat logs
const waitingUsers = [];
const pairedUsers = new Map();
const chatLogs = new Map(); // For admin/moderator access

// Admin authentication middleware (basic, replace with proper auth in production)
const adminAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader === 'Bearer your-admin-secret') { // Replace with secure secret
    next();
  } else {
    res.status(401).send('Unauthorized');
  }
};

// Admin endpoint to view chat logs
app.get('/admin/logs', adminAuth, (req, res) => {
  const logs = Array.from(chatLogs.entries()).map(([pairId, messages]) => ({
    pairId,
    messages
  }));
  res.json(logs);
});

// Admin endpoint to ban user (basic implementation)
app.post('/admin/ban/:socketId', adminAuth, (req, res) => {
  const { socketId } = req.params;
  const socket = io.sockets.sockets.get(socketId);
  if (socket) {
    socket.emit('error', 'You have been banned.');
    socket.disconnect();
    res.send('User banned');
  } else {
    res.status(404).send('User not found');
  }
});

io.on('connection', (socket) => {
  const userId = crypto.randomUUID();
  console.log(`User connected: ${userId}`);

  socket.on('join', () => {
    if (waitingUsers.length > 0) {
      const partner = waitingUsers.shift();
      const pairId = crypto.randomUUID();
      pairedUsers.set(userId, { partner: partner.id, pairId });
      pairedUsers.set(partner.id, { partner: userId, pairId });
      chatLogs.set(pairId, []);
      socket.join(pairId);
      partner.join(pairId);
      socket.emit('paired');
      partner.emit('paired');
    } else {
      waitingUsers.push(socket);
    }
  });

  socket.on('message', (msg) => {
    const pair = pairedUsers.get(userId);
    if (pair) {
      const partnerId = pair.partner;
      const pairId = pair.pairId;
      chatLogs.get(pairId).push({ userId, message: msg, timestamp: new Date() });
      socket.to(pairId).emit('message', msg);
    }
  });

  socket.on('report', () => {
    const pair = pairedUsers.get(userId);
    if (pair) {
      const pairId = pair.pairId;
      chatLogs.get(pairId).push({ userId, message: '[Reported]', timestamp: new Date() });
      // Notify moderators (implement notification system as needed)
    }
  });

  socket.on('leave', () => {
    const pair = pairedUsers.get(userId);
    if (pair) {
      const partnerId = pair.partner;
      const pairId = pair.pairId;
      const partnerSocket = io.sockets.sockets.get(partnerId);
      if (partnerSocket) {
        partnerSocket.emit('disconnected');
        partnerSocket.leave(pairId);
      }
      pairedUsers.delete(userId);
      pairedUsers.delete(partnerId);
      socket.leave(pairId);
    } else {
      const index = waitingUsers.findIndex((s) => s.id === userId);
      if (index !== -1) {
        waitingUsers.splice(index, 1);
      }
    }
  });

  socket.on('disconnect', () => {
    const pair = pairedUsers.get(userId);
    if (pair) {
      const partnerId = pair.partner;
      const pairId = pair.pairId;
      const partnerSocket = io.sockets.sockets.get(partnerId);
      if (partnerSocket) {
        partnerSocket.emit('disconnected');
        partnerSocket.leave(pairId);
      }
      pairedUsers.delete(userId);
      pairedUsers.delete(partnerId);
    } else {
      const index = waitingUsers.findIndex((s) => s.id === userId);
      if (index !== -1) {
        waitingUsers.splice(index, 1);
      }
    }
    console.log(`User disconnected: ${userId}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});