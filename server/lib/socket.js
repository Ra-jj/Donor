const { Server } = require("socket.io");
const http = require("http");
const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const User = require("../models/user.model");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || "http://localhost:5173",
    credentials: true,
  },
});

// setTimeout fires after ~1 ms for any delay above this (Node clamps it), so longer waits
// are split into steps of at most this size
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

// Parses the Cookie header of every engine.io HTTP request and WebSocket upgrade into
// req.cookies, so socket.request.cookies.jwt below is the same httpOnly cookie that Express's
// protectRoute reads. cookie-parser is already a direct dependency of the server.
io.engine.use(cookieParser());

const rejectConnection = (next, observedFact) => {
  console.warn(`socket auth rejected: ${observedFact}`);
  next(new Error("Unauthorized"));
};

// Identity comes ONLY from the verified jwt cookie. Any userId the client puts in the
// handshake query or auth payload is ignored: joining a room from it let anyone who knew a
// user's id receive that user's private events.
io.use(async (socket, next) => {
  const token = socket.request.cookies && socket.request.cookies.jwt;
  if (!token) {
    rejectConnection(next, "no jwt cookie");
    return;
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    // error.message is the library's own reason, e.g. 'jwt expired' or 'invalid signature'
    rejectConnection(next, `token verification failed: ${error.message}`);
    return;
  }

  if (typeof decoded.exp !== "number") {
    rejectConnection(next, "token has no exp claim");
    return;
  }
  if (!mongoose.isValidObjectId(decoded.userId)) {
    rejectConnection(next, "token userId is not a valid ObjectId");
    return;
  }

  let userExists;
  try {
    userExists = await User.exists({ _id: decoded.userId });
  } catch (error) {
    // Not an auth failure, so the client is not told 'Unauthorized'
    console.error(`socket auth failed: user lookup threw: ${error.message}`);
    next(new Error("Internal Server Error"));
    return;
  }
  if (!userExists) {
    rejectConnection(next, "no user exists for the token's userId");
    return;
  }

  socket.data.userId = String(decoded.userId);
  socket.data.tokenExpiresAtMs = decoded.exp * 1000;
  next();
});

// Disconnects the socket once its token has expired, so a connection never outlives its login.
// Returns a function that cancels the pending timer.
const scheduleExpiryDisconnect = (socket, expiresAtMs) => {
  let timer = null;

  const schedule = () => {
    const delay = Math.min(Math.max(expiresAtMs - Date.now(), 0), MAX_TIMER_DELAY_MS);
    timer = setTimeout(() => {
      if (Date.now() < expiresAtMs) {
        schedule();
        return;
      }
      console.warn("socket disconnected: token expired");
      socket.disconnect(true);
    }, delay);
  };

  schedule();
  return () => clearTimeout(timer);
};

io.on("connection", (socket) => {
  // One personal room per user, named after the verified userId. Controllers emit with
  // io.to(userId).emit(...), and every tab or device of that user joins the same room.
  socket.join(socket.data.userId);

  const cancelExpiryDisconnect = scheduleExpiryDisconnect(socket, socket.data.tokenExpiresAtMs);
  socket.on("disconnect", cancelExpiryDisconnect);
});

module.exports = { app, io, server };
