const { Server } = require("socket.io");
const http = require("http");
const express = require("express");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || "http://localhost:5173",
    credentials: true,
  },
});

const userSocketMap = {}; // { userId: socketId }

io.on("connection", (socket) => {
  const userId = socket.handshake.query.userId;
  
  if (userId && userId !== "undefined") {
    // 1. Map for tracking online status
    userSocketMap[userId] = socket.id;
    
    // 2. Join a personal room named after the userId
    // This allows us to emit to a specific user using io.to(userId).emit(...)
    // regardless of how many tabs/devices they have open.
    socket.join(userId);
  }

  // Handle disconnect
  socket.on("disconnect", () => {
    if (userId) {
      delete userSocketMap[userId];
    }
  });
});

module.exports = { app, io, server };
