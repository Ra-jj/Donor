require('dotenv').config();
const { findMissingEnvVars, PUSH_ENV_VARS } = require('./config/env');

// Refuse to start without required config, instead of starting and failing later at request
// time. Only when run directly: tests require this file with no MONGO_URI (they use an in-memory
// database). Prints variable names only, never their values.
if (require.main === module) {
  const missingEnvVars = findMissingEnvVars(process.env);
  if (missingEnvVars.length > 0) {
    console.error(`Server not started: missing required environment variables: ${missingEnvVars.join(', ')} (see README)`);
    process.exit(1);
  }

  const missingPushEnvVars = findMissingEnvVars(process.env, PUSH_ENV_VARS);
  if (process.env.NODE_ENV === 'production' && missingPushEnvVars.length > 0) {
    console.warn(`Web push notifications are off: ${missingPushEnvVars.join(', ')} not set`);
  }
}

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const connectDB = require('./config/db');
const authRoutes = require('./routes/auth.route');
const requestRoutes = require('./routes/request.route');
const messageRoutes = require('./routes/message.route');
const pushRoutes = require('./routes/push.route');
const userRoutes = require('./routes/user.route');
const { createSecurityHeaders } = require('./middleware/securityHeaders');
const { parseTrustProxy } = require('./utils/parseTrustProxy');
const { app, server } = require('./lib/socket');

const PORT = process.env.PORT || 8000;
const isProduction = process.env.NODE_ENV === 'production';

// req.ip, and so every per-IP rate limit, comes from X-Forwarded-For only for the hops trusted
// here. Default 1 hop; TRUST_PROXY overrides it (see README). Check it after a deploy with
// DEBUG_IP_ENDPOINT=1 and GET /api/debug/ip.
app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));
app.disable('x-powered-by');
app.use(createSecurityHeaders({ isProduction }));

app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:5173', credentials: true })); // Set correct cors origin for cookies
app.use(express.json());
app.use(cookieParser());

app.use('/api/auth', authRoutes);
app.use('/api/requests', requestRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/users', userRoutes);

const path = require('path');

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Donor API is running' });
});

// Opt-in diagnostic for the trust proxy setting: shows which address Express picked as req.ip
// from the forwarding chain. Registered only when DEBUG_IP_ENDPOINT is exactly '1'; it echoes
// the client's forwarding headers, so turn it off again once the hop count is confirmed.
if (process.env.DEBUG_IP_ENDPOINT === '1') {
  app.get('/api/debug/ip', (req, res) => {
    res.json({ ip: req.ip, ips: req.ips, xff: req.headers['x-forwarded-for'] });
  });
}

// Unknown API paths get a JSON 404 instead of falling through to the SPA's index.html
app.use('/api', (_req, res) => {
  res.status(404).json({ message: 'Not found' });
});

if (isProduction) {
  // The built client. CLIENT_DIST_DIR is only for tests, which serve a small fake build from a
  // temp dir; left unset, it is client/dist next to this server.
  const clientDistPath = path.resolve(process.env.CLIENT_DIST_DIR || path.join(__dirname, '../client/dist'));

  // Vite puts only content-hashed files in dist/assets (a changed file gets a new name), so they
  // can be cached for a year. client/public has no assets/ folder: anything added there would be
  // copied in un-hashed and cached just as long. A missing file is an error here instead of
  // falling through to index.html, e.g. an old chunk that a page open across a deploy asks for.
  app.use('/assets', express.static(path.join(clientDistPath, 'assets'), { immutable: true, maxAge: '1y', fallthrough: false }));

  // Plain-text status (404 for a missing file) rather than Express's default HTML error page
  app.use('/assets', (err, _req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status || 500;
    if (status >= 500) console.error('Error serving a client asset:', err);
    res.set('Cache-Control', 'no-store').sendStatus(status);
  });

  // Everything else at the root (index.html, sw.js, manifest, icons, theme-init.js) keeps
  // express.static's default max-age=0, so a deploy is picked up on the next visit
  app.use(express.static(clientDistPath));

  app.use((req, res) => {
    res.sendFile(path.join(clientDistPath, 'index.html'));
  });
}

// Only when run directly (npm start / dev). Tests require this file, so require.main is not
// this module there and they start their own server on an in-memory database.
if (require.main === module) {
  // Connect first: a request or socket handshake accepted before MongoDB is ready would wait
  // on Mongoose's command buffer and could fail. connectDB exits the process if it cannot connect.
  const startServer = async () => {
    await connectDB();
    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  };
  startServer();
}

module.exports = app;

