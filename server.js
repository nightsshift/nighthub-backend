const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

let waitingUser = null;

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  if (waitingUser) {
    socket.partner = waitingUser;
    waitingUser.partner = socket;

    waitingUser.emit('message', 'Stranger connected.');
    socket.emit('message', 'Stranger connected.');
    waitingUser = null;
  } else {
    waitingUser = socket;
    socket.emit('message', 'Waiting for a stranger to connect...');
  }

  socket.on('message', (msg) => {
    if (socket.partner) {
      socket.partner.emit('message', `Stranger: ${msg}`);
    }
  });

  socket.on('disconnect', () => {
    if (socket.partner) {
      socket.partner.emit('message', 'Stranger disconnected.');
      socket.partner.partner = null;
    } else if (waitingUser === socket) {
      waitingUser = null;
    }
    console.log(`User disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
