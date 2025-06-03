const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ['https://nighthub.io'], // Replace with your GitHub Pages URL if needed
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// In-memory storage for users and chat logs
const waitingUsers = [];
const pairedUsers = new Map();
const chatLogs = new Map();

// Admin authentication middleware
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'fallback-secret-for-testing';
const adminAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader === `Bearer ${ADMIN_SECRET}`) {
    console.log('Admin authenticated');
    next();
  } else {
    console.log('Admin authentication failed');
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
    console.log(`User ${userId} requested to join (Socket ID: ${socket.id})`);
    if (waitingUsers.length > 0) {
      const partner = waitingUsers.shift();
      const pairId = crypto.randomUUID();
      console.log(`Pairing ${userId} (Socket ID: ${socket.id}) with ${partner.id} (Socket ID: ${partner.socket.id}) (Pair ID: ${pairId})`);
      pairedUsers.set(userId, { partner: partner.id, pairId, socketId: socket.id });
      pairedUsers.set(partner.id, { partner: userId, pairId, socketId: partner.socket.id });
      chatLogs.set(pairId, []);
      socket.join(pairId);
      partner.socket.join(pairId);
      socket.emit('paired');
      partner.socket.emit('paired');
      console.log(`Users joined room ${pairId}`);
    } else {
      console.log(`User ${userId} added to waiting list (Socket ID: ${socket.id})`);
      waitingUsers.push({ id: userId, socket });
    }
  });

  socket.on('message', (msg) => {
    console.log(`Message from ${userId} (Socket ID: ${socket.id}): ${msg}`);
    const pair = pairedUsers.get(userId);
    if (pair) {
      const pairId = pair.pairId;
      const partnerId = pair.partner;
      const partnerSocketId = pairedUsers.get(partnerId)?.socketId; // Get partner's socketId
      console.log(`Sending message to partner ${partnerId} (Socket ID: ${partnerSocketId}) in pairId ${pairId}`);
      if (partnerSocketId) {
        const partnerSocket = io.sockets.sockets.get(partnerSocketId);
        if (partnerSocket) {
          partnerSocket.emit('message', msg);
          chatLogs.get(pairId).push({ userId, socketId: socket.id, message: msg, timestamp: new Date().toISOString() });
        } else {
          console.log(`Partner socket ${partnerSocketId} not found for ${partnerId}`);
          socket.emit('error', 'Partner disconnected');
        }
      } else {
        console.log(`No socketId found for partner ${partnerId}`);
        socket.emit('error', 'Partner disconnected');
      }
    } else {
      console.log(`No pair found for user ${userId} (Socket ID: ${socket.id})`);
      socket.emit('error', 'Not paired with anyone');
    }
  });

  socket.on('report', (data) => {
    console.log(`Report from ${userId} (Socket ID: ${socket.id}):`, data);
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
      console.log(`No partner found for report from ${userId} (Socket ID: ${socket.id})`);
      socket.emit('error', 'No user to report');
    }
  });

  socket.on('leave', () => {
    console.log(`User ${userId} requested to leave (Socket ID: ${socket.id})`);
    const pair = pairedUsers.get(userId);
    if (pair) {
      const partnerId = pair.partner;
      const pairId = pair.pairId;
      const partnerSocketId = pairedUsers.get(partnerId)?.socketId;
      if (partnerSocketId) {
        const partnerSocket = io.sockets.sockets.get(partnerSocketId);
        if (partnerSocket) {
          partnerSocket.emit('disconnected');
          partnerSocket.leave(pairId);
          console.log(`Partner ${partnerId} notified and left room ${pairId}`);
        }
      }
      pairedUsers.delete(userId);
      pairedUsers.delete(partnerId);
      chatLogs.delete(pairId); // Clean up chat logs
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
      const partnerSocketId = pairedUsers.get(partnerId)?.socketId;
      if (partnerSocketId) {
        const partnerSocket = io.sockets.sockets.get(partnerSocketId);
        if (partnerSocket) {
          partnerSocket.emit('disconnected');
          partnerSocket.leave(pairId);
          console.log(`Partner ${partnerId} notified and left room ${pairId}`);
        }
      }
      pairedUsers.delete(userId);
      pairedUsers.delete(partnerId);
      chatLogs.delete(pairId); // Clean up chat logs
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
