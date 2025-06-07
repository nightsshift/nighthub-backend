const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const helmet = require('helmet');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: 'https://nighthub.io',
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

app.use(helmet());
app.use(cors({ origin: 'https://nighthub.io', credentials: true }));

const waitingUsers = { nsfw: [], nonNsfw: [] };
const rooms = new Map();

io.on('connection', (socket) => {
  socket.on('join', ({ nsfw }) => {
    const queue = nsfw ? waitingUsers.nsfw : waitingUsers.nonNsfw;

    if (queue.length > 0) {
      const partner = queue.shift();
      const roomId = `room-${socket.id}-${partner.id}`;
      socket.join(roomId);
      partner.join(roomId);
      rooms.set(socket.id, { roomId, partnerId: partner.id });
      rooms.set(partner.id, { roomId, partnerId: socket.id });
      socket.emit('connect');
      partner.emit('connect');
    } else {
      queue.push(socket);
    }
  });

  socket.on('message', (msg) => {
    const room = rooms.get(socket.id);
    if (room) {
      socket.to(room.roomId).emit('message', msg);
    }
  });

  socket.on('disconnectRequest', () => {
    handleDisconnect(socket);
  });

  socket.on('disconnect', () => {
    handleDisconnect(socket);
  });

  function handleDisconnect(socket) {
    const room = rooms.get(socket.id);
    if (room) {
      const partner = io.sockets.sockets.get(room.partnerId);
      if (partner) {
        partner.emit('partnerDisconnected');
        partner.leave(room.roomId);
      }
      socket.leave(room.roomId);
      rooms.delete(room.partnerId);
      rooms.delete(socket.id);
    }
    waitingUsers.nsfw = waitingUsers.nsfw.filter((s) => s.id !== socket.id);
    waitingUsers.nonNsfw = waitingUsers.nonNsfw.filter((s) => s.id !== socket.id);
  }
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});