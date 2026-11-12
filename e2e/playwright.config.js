// Browser tests of the built client (client/dist) and the real server, run in Chromium.
// The web server below is server/index.js with NODE_ENV=production on an in-memory MongoDB
// (scripts/start-server.js). Build the client first; see README.md.
import { defineConfig, devices } from '@playwright/test';

// An uncommon port, so a busy one fails the run instead of testing some other server.
// E2E_PORT changes it.
const PORT = Number(process.env.E2E_PORT || 8850);
// localhost, not 127.0.0.1: the login cookie is Secure in production, and over plain http
// Playwright's API requests (which sign the test users up) send a Secure cookie only to localhost.
// Chromium keeps and sends it on http://localhost as well.
const BASE_URL = `http://localhost:${PORT}`;
const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  fullyParallel: true,
  forbidOnly: isCI,
  // One retry on CI only; a test that passes on its retry is still listed as flaky in the report
  retries: isCI ? 1 : 0,
  workers: 2,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: isCI
    ? [['github'], ['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: BASE_URL,
    // Wider than the dashboard's lg breakpoint, so a request list and its chat show side by side
    viewport: { width: 1280, height: 900 },
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium' }],
  webServer: {
    command: 'node scripts/start-server.js',
    env: { E2E_PORT: String(PORT) },
    // Printed once /api/health answers. The named group puts the in-memory database's URI in
    // process.env.E2E_MONGO_URI for the tests (tests/support/database.js).
    wait: { stdout: /e2e server ready at \S+ with in-memory mongodb=(?<e2e_mongo_uri>mongodb:\/\/\S+)/ },
    timeout: 120_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
    // SIGTERM lets the script stop the server and delete the in-memory database's files
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
  },
});
