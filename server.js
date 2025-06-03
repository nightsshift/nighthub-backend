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

// In-memory storage for users, chat logs, reports, bans, and requests
const waitingUsers = [];
const pairedUsers = new Map();
const chatLogs = new Map();
const userReports = new Map(); // { userId: { count: number, lastReset: timestamp } }
const userBans = new Map(); // { userId: { duration: number, start: timestamp } }
const userRequests = []; // [{ id, userId, name, email, message, timestamp }]

// Simple NSFW keyword filter (replace with external API if needed)
const nsfwKeywords = ['explicit', 'nsfw', 'adult', 'inappropriate'];
function isNSFW(message) {
  const lowerMsg = message.toLowerCase();
  return nsfwKeywords.some(keyword => lowerMsg.includes(keyword));
}

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

// Admin endpoint to view user requests
app.get('/admin/requests', adminAuth, (req, res) => {
  console.log('Admin requested user requests');
  res.json(userRequests);
});

// Admin endpoint to ban user
app.post('/admin/ban/:socketId', adminAuth, (req, res) => {
  const { socketId } = req.params;
  console.log(`Admin requested to ban socket: ${socketId}`);
  const socket = io.sockets.sockets.get(socketId);
  if (socket) {
    socket.emit('error', 'You are banned.');
    socket.disconnect();
    res.send('User banned');
  } else {
    res.status(404).send('User not found');
  }
});

io.on('connection', (socket) => {
  const userId = crypto.randomUUID();
  console.log(`User connected: ${userId} (Socket ID: ${socket.id})`);

  // Check if user is banned
  const ban = userBans.get(userId);
  if (ban) {
    const timeLeft = ban.start + ban.duration - Date.now();
    if (timeLeft > 0) {
      socket.emit('error', `You are banned for ${ban.duration === Infinity ? 'permanently' : `${Math.ceil(timeLeft / 60000)} minutes`}.`);
      socket.disconnect();
      return;
    } else {
      userBans.delete(userId);
      userReports.delete(userId);
    }
  }

  socket.on('join', () => {
    console.log(`User ${userId} requested to join (Socket ID: ${socket.id})`);
    if (waitingUsers.length > 0) {
      const partner = waitingUsers.shift();
      const pairId = crypto.randomUUID();
      console.log(`Pairing ${userId} (Socket ID: ${socket.id}) with ${partner.id} (Socket ID: ${partner.socket.id}) (Pair ID: ${pairId})`);
      pairedUsers.set(userId, { partner: partner.id, pairId, socketId: socket.id, safeMode: true });
      pairedUsers.set(partner.id, { partner: userId, pairId, socketId: partner.socket.id, safeMode: partner.safeMode });
      chatLogs.set(pairId, []);
      socket.join(pairId);
      partner.socket.join(pairId);
      socket.emit('paired');
      partner.socket.emit('paired');
      console.log(`Users joined room ${pairId}`);
    } else {
      console.log(`User ${userId} added to waiting list (Socket ID: ${socket.id})`);
      waitingUsers.push({ id: userId, socket, safeMode: true });
    }
  });

  socket.on('message', (msg) => {
    console.log(`Message from ${userId} (Socket ID: ${socket.id}): ${msg}`);
    const pair = pairedUsers.get(userId);
    if (pair) {
      const pairId = pair.pairId;
      const partnerId = pair.partner;
      const partnerSocketId = pairedUsers.get(partnerId)?.socketId;
      const senderSafeMode = pair.safeMode;
      const partnerSafeMode = pairedUsers.get(partnerId)?.safeMode;

      // Check NSFW content if sender or partner has Safe Mode on
      if ((senderSafeMode || partnerSafeMode) && isNSFW(msg)) {
        socket.emit('error', 'Message blocked: Inappropriate content detected.');
        chatLogs.get(pairId).push({ userId, socketId: socket.id, message: '[Blocked: NSFW]', timestamp: new Date().toISOString() });
        return;
      }

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

  socket.on('typing', (isTyping) => {
    console.log(`Typing event from ${userId} (Socket ID: ${socket.id}): ${isTyping}`);
    const pair = pairedUsers.get(userId);
    if (pair) {
      const partnerId = pair.partner;
      const partnerSocketId = pairedUsers.get(partnerId)?.socketId;
      if (partnerSocketId) {
        const partnerSocket = io.sockets.sockets.get(partnerSocketId);
        if (partnerSocket) {
          partnerSocket.emit('typing', isTyping);
        } else {
          console.log(`Partner socket ${partnerSocketId} not found for ${partnerId}`);
        }
      }
    }
  });

  socket.on('report', (data) => {
    console.log(`Report from ${userId} (Socket ID: ${socket.id}):`, data);
    const pair = pairedUsers.get(userId);
    if (pair) {
      const pairId = pair.pairId;
      const partnerId = pair.partner;
      const partnerSocketId = pairedUsers.get(partnerId)?.socketId;

      // Track reports
      let reports = userReports.get(partnerId) || { count: 0, lastReset: Date.now() };
      if (Date.now() - reports.lastReset > 24 * 60 * 60 * 1000) {
        reports = { count: 0, lastReset: Date.now() };
      }
      reports.count += 1;
      userReports.set(partnerId, reports);

      chatLogs.get(pairId).push({
        userId,
        socketId: socket.id,
        message: `[Reported user ${partnerId}]`,
        timestamp: data.timestamp || new Date().toISOString()
      });
      console.log(`Report logged for pair ${pairId}, user ${partnerId} now has ${reports.count} reports`);

      // Apply bans based on report count
      if (partnerSocketId) {
        const partnerSocket = io.sockets.sockets.get(partnerSocketId);
        if (partnerSocket) {
          if (reports.count >= 30) {
            userBans.set(partnerId, { duration: Infinity, start: Date.now() });
            partnerSocket.emit('error', 'You are permanently banned due to multiple reports.');
            partnerSocket.disconnect();
            console.log(`User ${partnerId} permanently banned`);
          } else if (reports.count >= 20) {
            userBans.set(partnerId, { duration: 24 * 60 * 60 * 1000, start: Date.now() });
            partnerSocket.emit('error', 'You are banned for 24 hours due to multiple reports.');
            partnerSocket.disconnect();
            console.log(`User ${partnerId} banned for 24 hours`);
          } else if (reports.count >= 10) {
            userBans.set(partnerId, { duration: 30 * 60 * 1000, start: Date.now() });
            partnerSocket.emit('error', 'You are banned for 30 minutes due to multiple reports.');
            partnerSocket.disconnect();
            console.log(`User ${partnerId} banned for 30 minutes`);
          }
        }
      }
    } else {
      console.log(`No partner found for report from ${userId} (Socket ID: ${socket.id})`);
      socket.emit('error', 'No user to report');
    }
  });

  socket.on('toggle_safe_mode', (safeMode) => {
    console.log(`User ${userId} toggled Safe Mode to ${safeMode} (Socket ID: ${socket.id})`);
    const pair = pairedUsers.get(userId);
    if (pair) {
      pairedUsers.set(userId, { ...pair, safeMode });
    } else {
      const waitingUser = waitingUsers.find(u => u.id === userId);
      if (waitingUser) {
        waitingUser.safeMode = safeMode;
      }
    }
  });

  socket.on('submit_request', ({ name, email, message }) => {
    console.log(`Request from ${userId} (Socket ID: ${socket.id}):`, { name, email, message });
    if (!message) {
      socket.emit('error', 'Message is required for contact request.');
      return;
    }
    const request = {
      id: crypto.randomUUID(),
      userId,
      name: name || 'Anonymous',
      email: email || 'N/A',
      message,
      timestamp: new Date().toISOString()
    };
    userRequests.push(request);
    socket.emit('request_success', 'Your request has been submitted successfully.');
    console.log(`Request stored: ${request.id}`);
  });

  socket.on('leave', () => {
    console.log(`User ${userId} initiated leave (Socket ID: ${socket.id})`);
    const pair = pairedUsers.get(userId);
    if (pair) {
      const pairId = pair.pairId;
      const partnerId = pair.partner;
      const partnerSocketId = pairedUsers.get(partnerId)?.socketId;
      let countdown = 5;

      const countdownInterval = setInterval(() => {
        socket.emit('countdown', countdown);
        if (partnerSocketId) {
          const partnerSocket = io.sockets.sockets.get(partnerSocketId);
          if (partnerSocket) {
            partnerSocket.emit('countdown', countdown);
          }
        }
        countdown--;
        if (countdown < 0) {
          clearInterval(countdownInterval);
          disconnectUser(userId, pairId, partnerId, partnerSocketId, socket);
        }
      }, 1000);

      socket.once('cancel_disconnect', () => {
        console.log(`User ${userId} cancelled disconnect (Socket ID: ${socket.id})`);
        clearInterval(countdownInterval);
        socket.emit('countdown_cancelled');
        if (partnerSocketId) {
          const partnerSocket = io.sockets.sockets.get(partnerSocketId);
          if (partnerSocket) {
            partnerSocket.emit('countdown_cancelled');
          }
        }
      });
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
      disconnectUser(userId, pairId, partnerId, partnerSocketId, socket);
    } else {
      const index = waitingUsers.findIndex((s) => s.id === userId);
      if (index !== -1) {
        waitingUsers.splice(index, 1);
        console.log(`User ${userId} removed from waiting list due to disconnect`);
      }
    }
  });

  function disconnectUser(userId, pairId, partnerId, partnerSocketId, socket) {
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
    chatLogs.delete(pairId);
    socket.leave(pairId);
    console.log(`User ${userId} disconnected from pair ${pairId}`);
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
