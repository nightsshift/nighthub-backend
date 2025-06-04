const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ['https://nighthub.io', 'http://localhost:5500'],
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Set Permissions-Policy header
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

// In-memory storage
const waitingUsers = [];
const pairedUsers = new Map();
const chatLogs = new Map();
const userReports = new Map();
const userBans = new Map();
const deviceBans = new Map();
const ipHistory = new Map();
const userRequests = [];
const tagUsage = new Map();
const adminSockets = new Set();
const adminChatObservers = new Map();
const stats = {
  messagesSent: 0,
  reportsFiled: 0
};
const userTagsMap = new Map();

// NSFW filter
const nsfwKeywords = ['explicit', 'nsfw', 'adult', 'inappropriate'];
function isNSFW(message) {
  const lowerMsg = message.toLowerCase();
  return nsfwKeywords.some(keyword => lowerMsg.includes(keyword));
}

// Sanitize input
function sanitizeInput(input) {
  if (typeof input !== 'string') return '';
  return input.replace(/[<>&"']/g, match => ({
    '<': '<',
    '>': '>',
    '&': '&',
    '"': '"',
    "'": '''
  }[match]));
}

// Track tag usage
function updateTagUsage(userTags) {
  const now = Date.now();
  userTags.forEach(tag => {
    const sanitizedTag = sanitizeInput(tag.toLowerCase());
    if (sanitizedTag) {
      tagUsage.set(sanitizedTag, {
        count: (tagUsage.get(sanitizedTag)?.count || 0) + 1,
        lastUsed: now
      });
    }
  });
}

// Get trending tags
function getTrendingTags() {
  const now = Date.now();
  const oneDayMs = 24 * 60 * 60 * 1000;
  const recentTags = Array.from(tagUsage.entries())
    .filter(([_, data]) => now - data.lastUsed <= oneDayMs)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 5)
    .map(([tag]) => tag);
  return recentTags.length > 0 ? recentTags : ['coding', 'movies', 'music', 'gaming', 'books'];
}

// Find best match
function findBestMatch(userId, userTags, safeMode) {
  let bestMatch = null;
  let maxCommonTags = -1;

  for (const user of waitingUsers) {
    if (user.id !== userId && user.safeMode === safeMode) {
      const commonTags = user.tags.filter(tag => userTags.includes(tag));
      if (commonTags.length > maxCommonTags) {
        maxCommonTags = commonTags.length;
        bestMatch = user;
      }
    }
  }

  return bestMatch;
}

// Get admin data
function getAdminData() {
  const users = [];
  for (const [userId, data] of pairedUsers) {
    const reports = userReports.get(userId) || { count: 0, nsfwCount: 0, lastReset: Date.now() };
    const ban = userBans.get(userId);
    users.push({
      userId,
      socketId: data.socketId,
      reports: reports.count,
      isBanned: !!ban,
      banDuration: ban ? ban.duration : null,
      banEnd: ban ? ban.start + ban.duration : null
    });
  }
  for (const user of waitingUsers) {
    const reports = userReports.get(user.id) || { count: 0, nsfwCount: 0, lastReset: Date.now() };
    const ban = userBans.get(user.id);
    users.push({
      userId: user.id,
      socketId: user.socket.id,
      reports: reports.count,
      isBanned: !!ban,
      banDuration: ban ? ban.duration : null,
      banEnd: ban ? ban.start + ban.duration : null
    });
  }

  const chats = [];
  const seenPairs = new Set();
  for (const [userId, data] of pairedUsers) {
    if (!seenPairs.has(data.pairId)) {
      seenPairs.add(data.pairId);
      const userIds = Array.from(pairedUsers.entries())
        .filter(([_, d]) => d.pairId === data.pairId)
        .map(([uId]) => uId);
      const reports = userIds.reduce((sum, uId) => sum + (userReports.get(uId)?.count || 0), 0);
      chats.push({
        pairId: data.pairId,
        userIds,
        reports
      });
    }
  }

  return {
    onlineUsers: pairedUsers.size + waitingUsers.length,
    activeChats: chats.length,
    messagesSent: stats.messagesSent,
    reportsFiled: stats.reportsFiled,
    users,
    chats
  };
}

// Broadcast admin data
function broadcastAdminData() {
  const data = getAdminData();
  adminSockets.forEach(socketId => {
    const socket = io.sockets.sockets.get(socketId);
    if (socket) {
      socket.emit('admin_data', data);
    } else {
      adminSockets.delete(socketId);
    }
  });
}

// Apply ban
function applyBan(userId, socket, duration, fingerprint, ip, reason) {
  const banStart = Date.now();
  userBans.set(userId, { duration, start: banStart });
  if (fingerprint) {
    deviceBans.set(fingerprint, { duration, start: banStart });
  }
  if (ip) {
    ipHistory.set(ip, { duration, start: banStart });
  }
  socket.emit('error', `You are banned for ${duration === Infinity ? 'permanently' : `${Math.ceil(duration / 60000)} minutes`}. Reason: ${reason}`);
  socket.disconnect();
  console.log(`Ban applied: User ${userId} (IP: ${ip}, Fingerprint: ${fingerprint || 'N/A'}) for ${duration === Infinity ? 'permanent' : `${duration / 60000} minutes`}. Reason: ${reason}`);
}

// Health check
app.get('/health', (req, res) => {
  console.log('Health check requested');
  res.status(200).send('OK');
});

io.on('connection', (socket) => {
  const userId = crypto.randomUUID();
  const ip = socket.handshake.address;
  console.log(`User connected: ${userId} (Socket ID: ${socket.id}, IP: ${ip})`);

  // Check bans
  socket.on('device_fingerprint', (fingerprint) => {
    try {
      const deviceBan = deviceBans.get(fingerprint);
      const ipBan = ipHistory.get(ip);
      const userBan = userBans.get(userId);
      const isDeviceBanned = deviceBan && (deviceBan.start + deviceBan.duration > Date.now());
      const isIpBanned = ipBan && (ipBan.start + ipBan.duration > Date.now());
      const isUserBanned = userBan && (userBan.start + userBan.duration > Date.now());

      if (isDeviceBanned || isIpBanned || isUserBanned) {
        const ban = isDeviceBanned ? deviceBan : (isIpBanned ? ipBan : userBan);
        const timeLeft = ban.start + ban.duration - Date.now();
        socket.emit('error', `You are banned for ${ban.duration === Infinity ? 'permanently' : `${Math.ceil(timeLeft / 60000)} minutes`}.`);
        socket.disconnect();
        console.log(`Banned user attempted connection: ${userId} (IP: ${ip}, Fingerprint: ${fingerprint})`);
      }
    } catch (err) {
      console.error(`Error checking bans for ${userId} (${socket.id}):`, err.message);
    }
  });

  socket.on('admin_login', ({ key }) => {
    try {
      if (key === 'ekandmc') {
        console.log(`Admin login successful: ${socket.id}`);
        adminSockets.add(socket.id);
        broadcastAdminData();
      } else {
        console.log(`Admin login failed: ${socket.id}`);
        socket.emit('error', 'Invalid admin key.');
      }
    } catch (err) {
      console.error(`Admin login error for ${socket.id}:`, err.message);
    }
  });

  socket.on('admin_ban', ({ userId: targetUserId, duration, fingerprint }) => {
    try {
      if (!adminSockets.has(socket.id)) {
        console.log(`Unauthorized admin ban attempt by ${socket.id}`);
        return;
      }
      console.log(`Admin ban requested for ${targetUserId} by ${socket.id}`);
      const userSocket = io.sockets.sockets.get(pairedUsers.get(targetUserId)?.socketId || waitingUsers.find(u => u.id === targetUserId)?.socket.id);
      if (userSocket) {
        applyBan(targetUserId, userSocket, duration, fingerprint, userSocket.handshake.address, 'Admin action');
      } else {
        console.log(`Target user ${targetUserId} not found for ban`);
      }
      broadcastAdminData();
    } catch (err) {
      console.error(`Admin ban error for ${targetUserId} by ${socket.id}:`, err.message);
    }
  });

  socket.on('admin_unban', ({ userId: targetUserId, fingerprint }) => {
    try {
      if (!adminSockets.has(socket.id)) {
        console.log(`Unauthorized admin unban attempt by ${socket.id}`);
        return;
      }
      console.log(`Admin unban requested for ${targetUserId} by ${socket.id}`);
      userBans.delete(targetUserId);
      if (fingerprint) {
        deviceBans.delete(fingerprint);
        ipHistory.delete(socket.handshake.address);
      }
      userReports.delete(targetUserId);
      broadcastAdminData();
    } catch (err) {
      console.error(`Admin unban error for ${targetUserId} by ${socket.id}:`, err.message);
    }
  });

  socket.on('admin_observe_chat', ({ pairId }) => {
    try {
      if (!adminSockets.has(socket.id)) {
        console.log(`Unauthorized admin observe attempt by ${socket.id}`);
        return;
      }
      console.log(`Admin observing chat ${pairId}: ${socket.id}`);
      socket.join(pairId);
      const observers = adminChatObservers.get(pairId) || [];
      observers.push(socket.id);
      adminChatObservers.set(pairId, observers);
      const messages = chatLogs.get(pairId) || [];
      messages.forEach(msg => {
        socket.emit('admin_message', { pairId, userId: msg.userId, message: msg.message });
      });
    } catch (err) {
      console.error(`Admin observe error for ${pairId} by ${socket.id}:`, err.message);
    }
  });

  socket.on('admin_leave_chat', ({ pairId }) => {
    try {
      if (!adminSockets.has(socket.id)) {
        console.log(`Unauthorized admin leave attempt by ${socket.id}`);
        return;
      }
      console.log(`Admin leaving chat ${pairId}: ${socket.id}`);
      socket.leave(pairId);
      const observers = adminChatObservers.get(pairId) || [];
      const updatedObservers = observers.filter(id => id !== socket.id);
      if (updatedObservers.length > 0) {
        adminChatObservers.set(pairId, updatedObservers);
      } else {
        adminChatObservers.delete(pairId);
      }
    } catch (err) {
      console.error(`Admin leave error for ${pairId} by ${socket.id}:`, err.message);
    }
  });

  socket.on('join', (userTags = []) => {
    try {
      console.log(`Join request from ${userId}: ${userTags} (${socket.id})`);
      const sanitizedTags = userTags.map(tag => sanitizeInput(tag.toLowerCase())).filter(tag => tag);
      if (sanitizedTags.length === 0) {
        socket.emit('error', 'At least one tag is required to join.');
        return;
      }
      userTagsMap.set(userId, sanitizedTags);
      updateTagUsage(sanitizedTags);

      const existingPair = pairedUsers.get(userId);
      if (existingPair) {
        const partnerSocketId = pairedUsers.get(existingPair.partner)?.socketId;
        disconnectUser(userId, existingPair.pairId, existingPair.partner, partnerSocketId, socket);
      }
      const waitingIndex = waitingUsers.findIndex(u => u.id === userId);
      if (waitingIndex !== -1) {
        waitingUsers.splice(waitingIndex, 1);
      }

      const safeMode = pairedUsers.get(userId)?.safeMode ?? true;
      const match = findBestMatch(userId, sanitizedTags, safeMode);

      if (match) {
        const matchIndex = waitingUsers.findIndex(u => u.id === match.id);
        if (matchIndex !== -1) {
          waitingUsers.splice(matchIndex, 1);
        }
        const pairId = crypto.randomUUID();
        console.log(`Pairing ${userId} (${socket.id}) with ${match.id} (${match.socket.id}) (Pair ID: ${pairId})`);
        pairedUsers.set(userId, { partner: match.id, pairId, socketId: socket.id, safeMode });
        pairedUsers.set(match.id, { partner: userId, pairId, socketId: match.socket.id, safeMode: match.safeMode });
        chatLogs.set(pairId, []);
        socket.join(pairId);
        match.socket.join(pairId);
        socket.emit('paired');
        match.socket.emit('paired');
        broadcastAdminData();
      } else {
        console.log(`Added ${userId} to waiting list: ${sanitizedTags} (${socket.id})`);
        waitingUsers.push({ id: userId, socket, safeMode, tags: sanitizedTags });
        broadcastAdminData();
      }
    } catch (err) {
      console.error(`Join error for ${userId} (${socket.id}):`, err.message);
      socket.emit('error', 'Failed to join chat.');
    }
  });

  socket.on('get_trending_tags', () => {
    try {
      const tags = getTrendingTags();
      console.log(`Sending trending tags to ${userId}: ${tags} (${socket.id})`);
      socket.emit('trending_tags', tags);
    } catch (err) {
      console.error(`Trending tags error for ${userId} (${socket.id}):`, err.message);
    }
  });

  socket.on('message', (msg) => {
    try {
      console.log(`Message from ${userId}: ${msg} (${socket.id})`);
      const pair = pairedUsers.get(userId);
      if (!pair) {
        socket.emit('error', 'Not paired with anyone.');
        return;
      }

      const pairId = pair.pairId;
      const partnerId = pair.partner;
      const partnerSocketId = pairedUsers.get(partnerId)?.socketId;
      const senderSafeMode = pair.safeMode;
      const partnerSafeMode = pairedUsers.get(partnerId)?.safeMode;

      const sanitizedMsg = sanitizeInput(msg);
      if (!sanitizedMsg) {
        socket.emit('error', 'Message cannot be empty.');
        return;
      }

      if ((senderSafeMode || partnerSafeMode) && isNSFW(sanitizedMsg)) {
        socket.emit('error', 'Message blocked: Inappropriate content detected.');
        let reports = userReports.get(userId) || { count: 0, nsfwCount: 0, lastReset: Date.now() };
        reports.nsfwCount = (reports.nsfwCount || 0) + 1;
        userReports.set(userId, reports);

        if (reports.nsfwCount >= 3) {
          applyBan(userId, socket, 30 * 60 * 1000, null, ip, 'Repeated NSFW content');
          socket.emit('device_fingerprint', (fingerprint) => {
            if (fingerprint) {
              deviceBans.set(fingerprint, { duration: 30 * 60 * 1000, start: Date.now() });
              ipHistory.set(ip, { duration: 30 * 60 * 1000, start: Date.now() });
            }
          });
        }

        chatLogs.get(pairId).push({ userId, socketId: socket.id, message: '[Blocked: NSFW]', timestamp: new Date().toISOString() });
        stats.messagesSent++;
        broadcastAdminData();
        return;
      }

      if (partnerSocketId) {
        const partnerSocket = io.sockets.sockets.get(partnerSocketId);
        if (partnerSocket) {
          partnerSocket.emit('message', sanitizedMsg);
          chatLogs.get(pairId).push({ userId, socketId: socket.id, message: sanitizedMsg, timestamp: new Date().toISOString() });
          stats.messagesSent++;
          (adminChatObservers.get(pairId) || []).forEach(socketId => {
            const adminSocket = io.sockets.sockets.get(socketId);
            if (adminSocket) {
              adminSocket.emit('admin_message', { pairId, userId, message: sanitizedMsg });
            }
          });
          broadcastAdminData();
        } else {
          socket.emit('error', 'Partner disconnected.');
        }
      } else {
        socket.emit('error', 'Partner disconnected.');
      }
    } catch (err) {
      console.error(`Message error for ${userId} (${socket.id}):`, err.message);
      socket.emit('error', 'Failed to send message.');
    }
  });

  socket.on('typing', (isTyping) => {
    try {
      const pair = pairedUsers.get(userId);
      if (pair && pair.partner) {
        const partnerSocketId = pairedUsers.get(pair.partner)?.socketId;
        if (partnerSocketId) {
          io.sockets.sockets.get(partnerSocketId)?.emit('typing', isTyping);
        }
      }
    } catch (err) {
      console.error(`Typing error for ${userId} (${socket.id}):`, err.message);
    }
  });

  socket.on('report', (data) => {
    try {
      console.log(`Report from ${userId}:`, data, `(${socket.id})`);
      const pair = pairedUsers.get(userId);
      if (!pair) {
        socket.emit('error', 'No user to report.');
        return;
      }

      const pairId = pair.pairId;
      const partnerId = pair.partner;
      const partnerSocketId = pairedUsers.get(partnerId)?.socketId;

      let reports = userReports.get(partnerId) || { count: 0, nsfwCount: 0, lastReset: Date.now() };
      if (Date.now() - reports.lastReset > 24 * 60 * 60 * 1000) {
        reports = { count: 0, nsfwCount: reports.nsfwCount, lastReset: Date.now() };
      }
      reports.count += 1;
      userReports.set(partnerId, reports);
      stats.reportsFiled++;

      chatLogs.get(pairId).push({
        userId,
        socketId: socket.id,
        message: `[Reported user ${partnerId}]`,
        timestamp: data?.timestamp || new Date().toISOString()
      });
      console.log(`Report logged for ${partnerId}: ${reports.count} reports`);

      if (partnerSocketId) {
        const partnerSocket = io.sockets.sockets.get(partnerSocketId);
        if (partnerSocket) {
          let duration;
          let reason = 'Multiple reports';
          if (reports.count >= 30) {
            duration = Infinity;
          } else if (reports.count >= 20) {
            duration = 24 * 60 * 60 * 1000;
          } else if (reports.count >= 10) {
            duration = 30 * 60 * 1000;
          }
          if (duration) {
            applyBan(partnerId, partnerSocket, duration, data.fingerprint, partnerSocket.handshake.address, reason);
          }
        }
      }
      broadcastAdminData();
    } catch (err) {
      console.error(`Report error for ${userId} (${socket.id}):`, err.message);
      socket.emit('error', 'Failed to submit report.');
    }
  });

  socket.on('toggle_safe_mode', ({ safeMode, ageConfirmed }) => {
    try {
      console.log(`Safe Mode toggle by ${userId}: ${safeMode} (${socket.id})`);
      if (!safeMode && !ageConfirmed) {
        socket.emit('error', 'You must confirm you are 18+ to enable NSFW Mode.');
        return;
      }
      const pair = pairedUsers.get(userId);
      if (pair) {
        pairedUsers.set(userId, { ...pair, safeMode });
      } else {
        const waitingUser = waitingUsers.find(u => u.id === userId);
        if (waitingUser) {
          waitingUser.safeMode = safeMode;
        }
      }
      broadcastAdminData();
    } catch (err) {
      console.error(`Safe Mode toggle error for ${userId} (${socket.id}):`, err.message);
      socket.emit('error', 'Failed to toggle Safe Mode.');
    }
  });

  socket.on('submit_request', ({ name, email, message }) => {
    try {
      console.log(`Contact request from ${userId}:`, { name, email, message }, `(${socket.id})`);
      const sanitizedMessage = sanitizeInput(message);
      if (!sanitizedMessage) {
        socket.emit('error', 'Message is required for contact request.');
        return;
      }
      const request = {
        id: crypto.randomUUID(),
        userId,
        name: sanitizeInput(name) || 'Anonymous',
        email: sanitizeInput(email) || 'N/A',
        message: sanitizedMessage,
        timestamp: new Date().toISOString()
      };
      userRequests.push(request);
      socket.emit('request_success', 'Your request has been submitted successfully.');
      console.log(`Request stored: ${request.id}`);
      broadcastAdminData();
    } catch (err) {
      console.error(`Contact request error for ${userId} (${socket.id}):`, err.message);
      socket.emit('error', 'Failed to submit contact request.');
    }
  });

  socket.on('leave', () => {
    try {
      console.log(`Leave request from ${userId} (${socket.id})`);
      const pair = pairedUsers.get(userId);
      if (!pair) {
        const index = waitingUsers.findIndex(u => u.id === userId);
        if (index !== -1) {
          waitingUsers.splice(index, 1);
          console.log(`Removed ${userId} from waiting list`);
          broadcastAdminData();
        }
        return;
      }

      const pairId = pair.pairId;
      const partnerId = pair.partner;
      const partnerSocketId = pairedUsers.get(partnerId)?.socketId;
      let countdown = 5;

      const countdownInterval = setInterval(() => {
        socket.emit('countdown', countdown);
        if (partnerSocketId) {
          io.sockets.sockets.get(partnerSocketId)?.emit('countdown', countdown);
        }
        countdown--;
        if (countdown < 0) {
          clearInterval(countdownInterval);
          disconnectUser(userId, pairId, partnerId, partnerSocketId, socket);
          const lastTags = userTagsMap.get(userId);
          if (lastTags?.length > 0) {
            console.log(`Auto-rejoining ${userId}: ${lastTags}`);
            socket.emit('rejoin');
            setTimeout(() => socket.emit('join', lastTags), 1000);
          }
        }
      }, 1000);

      socket.once('cancel_disconnect', () => {
        console.log(`Cancel disconnect by ${userId} (${socket.id})`);
        clearInterval(countdownInterval);
        socket.emit('countdown_cancelled');
        if (partnerSocketId) {
          io.sockets.sockets.get(partnerSocketId)?.emit('countdown_cancelled');
        }
        broadcastAdminData();
      });
    } catch (err) {
      console.error(`Leave error for ${userId} (${socket.id}):`, err.message);
      socket.emit('error', 'Failed to leave chat.');
    }
  });

  socket.on('disconnect', () => {
    try {
      console.log(`User disconnected: ${userId} (${socket.id})`);
      adminSockets.delete(socket.id);
      const pair = pairedUsers.get(userId);
      if (pair) {
        const partnerId = pair.partner;
        const pairId = pair.pairId;
        const partnerSocketId = pairedUsers.get(partnerId)?.socketId;
        disconnectUser(userId, pairId, partnerId, partnerSocketId, socket);
      } else {
        const index = waitingUsers.findIndex(u => u.id === userId);
        if (index !== -1) {
          waitingUsers.splice(index, 1);
          console.log(`Removed ${userId} from waiting list due to disconnect`);
        }
      }
      const observingChats = Array.from(adminChatObservers.entries())
        .filter(([_, sockets]) => sockets.includes(socket.id));
      observingChats.forEach(([pairId, sockets]) => {
        const updatedSockets = sockets.filter(id => id !== socket.id);
        if (updatedSockets.length > 0) {
          adminChatObservers.set(pairId, updatedSockets);
        } else {
          adminChatObservers.delete(pairId);
        }
      });
      broadcastAdminData();
    } catch (err) {
      console.error(`Disconnect error for ${userId} (${socket.id}):`, err.message);
    }
  });

  function disconnectUser(userId, pairId, partnerId, partnerSocketId, socket) {
    try {
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
      console.log(`Disconnected ${userId} from pair ${pairId}`);
      broadcastAdminData();
    } catch (err) {
      console.error(`Disconnect user error for ${userId} (${socket.id}):`, err.message);
    }
  }
});

// Start server
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
});
