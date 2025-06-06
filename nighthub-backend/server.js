const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const admin = require('firebase-admin');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.FRONTEND_URL, credentials: true },
});

app.use(cors({ origin: process.env.FRONTEND_URL, credentials: true }));
app.use(helmet());
app.use(express.json());

// Firebase setup
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_CREDENTIALS)),
});
const db = getFirestore();

// Pairing logic
const users = new Map(); // userId: { socketId, tags }
const pairs = new Map(); // userId: pairedUserId
const reports = new Map(); // userId: reportCount
const banned = new Set(); // Banned IPs

io.on('connection', (socket) => {
  const userId = socket.id;

  socket.on('join', async ({ tags }) => {
    if (banned.has(socket.handshake.address)) {
      socket.emit('banned');
      socket.disconnect();
      return;
    }

    users.set(userId, { socketId: socket.id, tags: tags || [] });

    // Find a match
    let match = null;
    for (const [id, user] of users) {
      if (id !== userId && !pairs.has(id) && !pairs.has(userId)) {
        if (tags.length && user.tags.some(t => tags.includes(t))) {
          match = id;
          break;
        } else if (!tags.length) {
          match = id;
          break;
        }
      }
    }

    if (match) {
      pairs.set(userId, match);
      pairs.set(match, userId);

      // WebRTC offer
      socket.emit('paired', { userId: match });
      io.to(users.get(match).socketId).emit('paired', { userId });
    }
  });

  socket.on('offer', ({ offer, userId }) => {
    io.to(users.get(userId).socketId).emit('offer', { offer, userId: socket.id });
  });

  socket.on('answer', ({ answer, userId }) => {
    io.to(users.get(userId).socketId).emit('answer', { answer });
  });

  socket.on('ice-candidate', ({ candidate }) => {
    const pairedUserId = pairs.get(userId);
    if (pairedUserId) {
      io.to(users.get(pairedUserId).socketId).emit('ice-candidate', { candidate });
    }
  });

  socket.on('report', async ({ reason }) => {
    const reportedUserId = pairs.get(userId);
    if (reportedUserId) {
      const reportCount = (reports.get(reportedUserId) || 0) + 1;
      reports.set(reportedUserId, reportCount);

      await db.collection('reports').add({
        reportedUserId,
        reporterId: userId,
        reason,
        timestamp: new Date(),
      });

      if (reportCount >= 10) {
        banned.add(users.get(reportedUserId).socketId);
        io.to(users.get(reportedUserId).socketId).emit('banned');
        await db.collection('bans').add({
          userId: reportedUserId,
          ip: users.get(reportedUserId).socketId,
          type: 'permanent',
          timestamp: new Date(),
        });
      }

      // Prevent rematching for 1 hour
      setTimeout(() => {
        pairs.delete(userId);
        pairs.delete(reportedUserId);
      }, 60 * 60 * 1000);
    }
  });

  socket.on('update-tags', (tags) => {
    users.set(userId, { ...users.get(userId), tags });
  });

  socket.on('disconnect', () => {
    const pairedUserId = pairs.get(userId);
    if (pairedUserId) {
      io.to(users.get(pairedUserId).socketId).emit('disconnected');
      pairs.delete(pairedUserId);
    }
    users.delete(userId);
    pairs.delete(userId);
  });
});

// Admin API (protected by Firebase Auth)
app.post('/api/ban', async (req, res) => {
  const { userId, ip, duration } = req.body;
  const token = req.headers.authorization?.split('Bearer ')[1];
  try {
    await admin.auth().verifyIdToken(token);
    banned.add(ip);
    await db.collection('bans').add({
      userId,
      ip,
      type: duration === 'permanent' ? 'permanent' : 'temporary',
      duration: duration !== 'permanent' ? duration : null,
      timestamp: new Date(),
    });
    io.to(users.get(userId).socketId).emit('banned');
    res.status(200).send('User banned');
  } catch (error) {
    res.status(403).send('Unauthorized');
  }
});

app.post('/api/unban', async (req, res) => {
  const { ip } = req.body;
  const token = req.headers.authorization?.split('Bearer ')[1];
  try {
    await admin.auth().verifyIdToken(token);
    banned.delete(ip);
    await db.collection('bans').doc(ip).delete();
    res.status(200).send('User unbanned');
  } catch (error) {
    res.status(403).send('Unauthorized');
  }
});

app.get('/api/reports', async (req, res) => {
  const token = req.headers.authorization?.split('Bearer ')[1];
  try {
    await admin.auth().verifyIdToken(token);
    const snapshot = await db.collection('reports').get();
    const reports = snapshot.docs.map(doc => doc.data());
    res.status(200).json(reports);
  } catch (error) {
    res.status(403).send('Unauthorized');
  }
});

server.listen(process.env.PORT || 3000, () => {
  console.log('Server running on port', process.env.PORT || 3000);
});