// Starts the app for the browser tests the way Render runs it, `node server/index.js` with
// NODE_ENV=production serving the built client from client/dist, but on a throwaway in-memory
// MongoDB that is deleted when the run ends. Playwright's webServer (playwright.config.js) runs
// this and stops it with SIGTERM.
//
// The server process gets an environment built here, never from server/.env:
// - every variable the server reads is set explicitly, empty where production would leave it unset.
//   dotenv never overwrites a variable that is already set, even to '', so a server/.env on this
//   machine cannot slip its MONGO_URI, VAPID keys or limiter settings in;
// - the server runs in a new empty temporary folder, so dotenv finds no .env at all, and every
//   DOTENV_* variable (which could point dotenv at another file or make it override) is removed.
//
// When the server answers /api/health, one line is printed that playwright.config.js waits for:
// it carries the in-memory database's URI, which the tests need for the one change they make
// directly in the database (tests/support/database.js).
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_REPLICA_SET_NAME } from './testDatabase.js';

const E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(E2E_DIR, '..');
const SERVER_DIR = path.join(REPO_ROOT, 'server');
const CLIENT_DIR = path.join(REPO_ROOT, 'client');
const CLIENT_INDEX_HTML = path.join(CLIENT_DIR, 'dist', 'index.html');
// What the client build is made from: a newer file here means client/dist is out of date
const CLIENT_BUILD_INPUTS = ['src', 'public', 'index.html', 'vite.config.js'].map((name) => path.join(CLIENT_DIR, name));

const PORT = Number(process.env.E2E_PORT || 8850);
const BASE_URL = `http://localhost:${PORT}`;
const HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_POLL_MS = 250;

const fail = (message) => {
  console.error(`e2e server: ${message}`);
  process.exit(1);
};

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) fail(`E2E_PORT must be a port number, got ${JSON.stringify(process.env.E2E_PORT)}`);
if (!fs.existsSync(CLIENT_INDEX_HTML)) fail(`${CLIENT_INDEX_HTML} not found. Build the client first: cd client && npm run build`);
if (!fs.existsSync(path.join(SERVER_DIR, 'node_modules'))) fail(`${SERVER_DIR}/node_modules not found. Install the server first: cd server && npm ci`);

// The newest file among the given files and folders (searched recursively), or null if none exist.
// Hidden files such as .DS_Store are skipped: they are not part of the build.
const findNewestFile = (paths) => {
  let newest = null;
  const visit = (filePath) => {
    const stats = fs.statSync(filePath, { throwIfNoEntry: false });
    if (!stats) return;
    if (stats.isDirectory()) {
      for (const name of fs.readdirSync(filePath)) {
        if (!name.startsWith('.')) visit(path.join(filePath, name));
      }
    } else if (!newest || stats.mtimeMs > newest.mtimeMs) {
      newest = { filePath, mtimeMs: stats.mtimeMs };
    }
  };
  paths.forEach(visit);
  return newest;
};

// A warning, not a failure: the tests still run, against the build that is there
const warnIfClientBuildIsOutOfDate = () => {
  const builtAtMs = fs.statSync(CLIENT_INDEX_HTML).mtimeMs;
  const newest = findNewestFile(CLIENT_BUILD_INPUTS);
  if (newest && newest.mtimeMs > builtAtMs) {
    console.error(
      `e2e server: WARNING: ${path.relative(REPO_ROOT, newest.filePath)} was modified after client/dist was built ` +
        `(${new Date(builtAtMs).toISOString()}). The tests run the build in client/dist. Rebuild with: cd client && npm run build`,
    );
  }
};
warnIfClientBuildIsOutOfDate();

// mongodb-memory-server comes from the server's own install (a devDependency there), so the
// tests use the same version and the same downloaded mongod binary as the server's Jest tests
const serverRequire = createRequire(path.join(SERVER_DIR, 'package.json'));
const { MongoMemoryReplSet } = serverRequire('mongodb-memory-server');

const buildServerEnv = (mongoUri) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('DOTENV_')));
  return {
    ...env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    MONGO_URI: mongoUri,
    // A new random secret per run: no login token from one run works in another
    JWT_SECRET: crypto.randomBytes(32).toString('hex'),
    CLIENT_URL: BASE_URL,
    // No push keys, so web push stays off (the server warns once and starts)
    VAPID_PUBLIC_KEY: '',
    VAPID_PRIVATE_KEY: '',
    VAPID_SUBJECT: '',
    // The production defaults: one trusted proxy hop, the default sign-up limit, no debug route,
    // and the real client/dist
    TRUST_PROXY: '',
    REGISTER_RATE_LIMIT_MAX: '',
    DEBUG_IP_ENDPOINT: '',
    CLIENT_DIST_DIR: '',
    DOTENV_QUIET: 'true',
  };
};

const waitForHealth = async (serverProcess) => {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (serverProcess.exitCode !== null || serverProcess.signalCode !== null) {
      throw new Error(`the server exited before answering /api/health (exit code ${serverProcess.exitCode}, signal ${serverProcess.signalCode})`);
    }
    try {
      const response = await fetch(`${BASE_URL}/api/health`);
      if (response.ok) return;
    } catch {
      // Not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
  }
  throw new Error(`no answer from ${BASE_URL}/api/health within ${HEALTH_TIMEOUT_MS / 1000} s`);
};

// Something already answering on the port would be what the tests talk to, so a busy port stops
// the run here. Both loopback addresses: localhost can resolve to either.
const isPortTaken = (host) =>
  new Promise((resolve) => {
    const socket = net.connect({ host, port: PORT });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });

const main = async () => {
  for (const host of ['127.0.0.1', '::1']) {
    if (await isPortTaken(host)) fail(`port ${PORT} is already in use on ${host}. Stop what listens there, or choose another port with E2E_PORT.`);
  }

  // A one-member replica set, like production's Atlas cluster: account deletion runs in a
  // transaction, which a standalone mongod refuses. mongod gets a process group of its own:
  // Playwright's SIGTERM goes to this script's whole group, and mongod must still be up when
  // stopDatabase below shuts it down and deletes its folder. If this script is killed outright,
  // mongodb-memory-server's own watchdog process stops mongod within about 2 s.
  const replSet = await MongoMemoryReplSet.create({
    replSet: { name: TEST_REPLICA_SET_NAME, count: 1, storageEngine: 'wiredTiger', spawn: { detached: true } },
  });
  const mongoUri = replSet.getUri();
  const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'donor-e2e-'));

  let isShuttingDown = false;
  const serverProcess = spawn(process.execPath, [path.join(SERVER_DIR, 'index.js')], {
    cwd: workingDir,
    env: buildServerEnv(mongoUri),
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  const stopDatabase = async () => {
    try {
      // Also deletes the database's temporary folder
      await replSet.stop({ doCleanup: true });
    } catch (error) {
      console.error(`e2e server: stopping the in-memory MongoDB failed: ${error.message}`);
    }
  };

  const isServerRunning = () =>
    serverProcess.pid !== undefined && serverProcess.exitCode === null && serverProcess.signalCode === null;

  const shutDown = async (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    if (isServerRunning()) {
      const exited = new Promise((resolve) => serverProcess.once('exit', resolve));
      serverProcess.kill('SIGTERM');
      await exited;
    }
    await stopDatabase();
    fs.rmSync(workingDir, { recursive: true, force: true });
    process.exit(signal ? 0 : 1);
  };

  process.on('SIGTERM', () => shutDown('SIGTERM'));
  process.on('SIGINT', () => shutDown('SIGINT'));

  serverProcess.on('error', (error) => {
    console.error(`e2e server: could not start the server process: ${error.message}`);
    shutDown(null);
  });

  // The server is in this script's process group, so Playwright's SIGTERM reaches it too, and its
  // exit can be seen here before this script's own SIGTERM handler runs: that is a normal stop.
  // Stopping in any other way (a crash, or a busy port) ends the run, and Playwright then reports
  // that the web server exited.
  serverProcess.on('exit', (code, signal) => {
    if (isShuttingDown) return;
    if (signal === 'SIGTERM' || signal === 'SIGINT') {
      shutDown(signal);
      return;
    }
    console.error(`e2e server: the server exited (exit code ${code}, signal ${signal})`);
    shutDown(null);
  });

  try {
    await waitForHealth(serverProcess);
  } catch (error) {
    console.error(`e2e server: ${error.message}`);
    await shutDown(null);
    return;
  }

  // playwright.config.js waits for this exact line
  console.log(`e2e server ready at ${BASE_URL} with in-memory mongodb=${mongoUri}`);
};

main().catch((error) => {
  console.error(`e2e server: failed to start: ${error.stack || error.message}`);
  process.exit(1);
});
