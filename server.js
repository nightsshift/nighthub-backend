const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ['https://nighthub.io', 'https://nightshift.github.io'], // Replace 'https://yourusername.github.io' with your GitHub Pages URL
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// In-memory storage for users and chat logs
const waitingUsers = [];
const pairedUsers = new Map();
const chatLogs = new Map(); // For admin/moderator access

// Admin authentication middleware
const adminAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader === 'Bearer x7k9m2p8q3z5w1n4b6t2r8y0u3j5h9l2') { 
    next();
  } else {
    res.status(401).send('Unauthorized');
  }
};

// Admin endpoint to view chat logs
app.get('/admin/logs', adminAuth, (req, res) => {
  console.log('Admin requested logs');
  const logs = Array.from(chatLogs.entries()).map(([pairId, messages]) => ({
    pairId,
    messages
  }));
  res.json(logs);
});

// Admin endpoint to ban user
app.post('/admin/ban/:socketId', adminAuth, (req, res) => {
  const { socketId } = req.params;
  console.log(`Admin requested to ban socket: ${socketId}`);
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
  console.log(`User connected: ${userId} (Socket ID: ${socket.id})`);

  socket.on('join', () => {
    console.log(`User ${userId} requested to join`);
    if (waitingUsers.length > 0) {
      const partner = waitingUsers.shift();
      const pairId = crypto.randomUUID();
      console.log(`Pairing ${userId} with ${partner.id} (Pair ID: ${pairId})`);
      pairedUsers.set(userId, { partner: partner.id, pairId, socketId: socket.id });
      pairedUsers.set(partner.id, { partner: userId, pairId, socketId: partner.id });
      chatLogs.set(pairId, []);
      socket.join(pairId);
      partner.join(pairId);
      socket.emit('paired');
      partner.emit('paired');
    } else {
      console.log(`User ${userId} added to waiting list`);
      waitingUsers.push({ id: userId, socket });
    }
  });

  socket.on('message', (msg) => {
    console.log(`Message from ${userId}: ${msg}`);
    const pair = pairedUsers.get(userId);
    if (pair) {
      const pairId = pair.pairId;
      chatLogs.get(pairId).push({ userId, socketId: socket.id, message: msg, timestamp: new Date() });
      socket.to(pairId).emit('message', msg);
    } else {
      console.log(`No pair found for user ${userId}`);
      socket.emit('error', 'Not paired with anyone');
    }
  });

  socket.on('report', (data) => {
    console.log(`Report from ${userId}:`, data);
    const pair = pairedUsers.get(userId);
    if (pair) {
      const pairId = pair.pairId;
      chatLogs.get(pairId).push({
        userId,
        socketId: socket.id,
        message: '[Reported]',
        timestamp: data.timestamp || new Date().toISOString()
      });
      console.log(`Report logged for pair ${pairId}`);
    } else {
      console.log(`No pair found for report from ${userId}`);
    }
  });

  socket.on('leave', () => {
    console.log(`User ${userId} requested to leave`);
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
      console.log(`User ${userId} left pair ${pairId}`);
    } else {
      const index = waitingUsers.findIndex((s) => s.id === userId);
      if (index !== -1) {
        waitingUsers.splice(index, 1);
        console.log(`User ${userId} removed from waiting list`);
      }
    }
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${userId} (Socket ID: ${socket.id})`);
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
      console.log(`Pair ${pairId} dissolved due to disconnect`);
    } else {
      const index = waitingUsers.findIndex((s) => s.id === userId);
      if (index !== -1) {
        waitingUsers.splice(index, 1);
        console.log(`User ${userId} removed from waiting list due to disconnect`);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
