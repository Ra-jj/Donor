// Runs before each test file (jest.setupFiles in package.json), so before index.js loads
// server/.env. dotenv never overwrites a variable that is already set, even to '', so the
// values below win and the suite runs the same on a developer machine as in CI (no .env there).
// Not a test file itself: Jest only collects *.test.js / *.spec.js and __tests__/, like tests/db.js.

// Jest sets NODE_ENV=test only when it is unset. The sign-up limiter, the auth cookie's secure
// flag and the CSP all depend on it, so pin it.
process.env.NODE_ENV = 'test';

// Test-only signing key. Tests sign their own tokens with process.env.JWT_SECRET, so this must
// never be the real secret from server/.env.
process.env.JWT_SECRET = 'test-only-jwt-secret-not-for-production';

// Set to '' so dotenv leaves the real values out of the test process: tests use an in-memory
// database, and web push stays unconfigured (as in CI) with sendNotification mocked.
process.env.MONGO_URI = '';
process.env.VAPID_PUBLIC_KEY = '';
process.env.VAPID_PRIVATE_KEY = '';

// dotenv 17 prints an "injected env" line in every test file otherwise
process.env.DOTENV_CONFIG_QUIET = 'true';
