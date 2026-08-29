require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const connectDB = require('./config/db');
const authRoutes = require('./routes/auth.route');
const requestRoutes = require('./routes/request.route');
const messageRoutes = require('./routes/message.route');
const pushRoutes = require('./routes/push.route');
const { app, server } = require('./lib/socket');

const PORT = process.env.PORT || 8000;

app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:5173', credentials: true })); // Set correct cors origin for cookies
app.use(express.json());
app.use(cookieParser());

app.use('/api/auth', authRoutes);
app.use('/api/requests', requestRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/push', pushRoutes);

const path = require('path');

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Donor API is running' });
});

if (process.env.NODE_ENV === "production") {
  app.use(express.static(path.join(__dirname, "../client/dist")));

  app.use((req, res) => {
    res.sendFile(path.join(__dirname, "../client/dist", "index.html"));
  });
}

server.listen(PORT, async () => {
  await connectDB();
  console.log(`Server running on port ${PORT}`);
});

