// Set before the app is required: rateLimiters.js reads it once, at module load. Jest gives each
// test file its own module registry, so only this file's copy of the limiter uses this limit.
const REGISTER_LIMIT_FOR_TEST = 3;
const previousRegisterLimit = process.env.REGISTER_RATE_LIMIT_MAX;
process.env.REGISTER_RATE_LIMIT_MAX = String(REGISTER_LIMIT_FOR_TEST);

const http = require('http');
const request = require('supertest');
const app = require('../index');
const {
  resolveRegisterLimitConfig,
  DEFAULT_REGISTER_LIMIT,
} = require('../middleware/rateLimiters');
const { connectDB, closeDB, clearDB } = require('./db');

// supertest dials 127.0.0.1, so bind there explicitly. request(app) binds `::`, and another
// local app on the same ephemeral port can answer instead.
let server;

beforeAll(async () => {
  await connectDB();
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
});

afterEach(async () => {
  await clearDB();
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await closeDB();
  if (previousRegisterLimit === undefined) {
    delete process.env.REGISTER_RATE_LIMIT_MAX;
  } else {
    process.env.REGISTER_RATE_LIMIT_MAX = previousRegisterLimit;
  }
});

const newUser = (index) => ({
  name: `Signup User ${index}`,
  email: `signup${index}@example.com`,
  password: 'password123',
  bloodGroup: 'A+',
  location: [88.3639, 22.5726],
});

// express-rate-limit reports config problems (e.g. ERR_ERL_UNEXPECTED_X_FORWARDED_FOR) by
// logging an Error with an ERR_ERL_* code instead of throwing
const loggedRateLimitValidationErrors = (spy) =>
  spy.mock.calls.filter(([first]) => first && typeof first.code === 'string' && first.code.startsWith('ERR_ERL_'));

describe('POST /api/auth/register rate limit', () => {
  it(`should block sign-up ${REGISTER_LIMIT_FOR_TEST + 1} from one IP and still allow another IP`, async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error');
    const consoleWarnSpy = jest.spyOn(console, 'warn');

    try {
      // Every request carries X-Forwarded-For, as it does behind Render. With the default
      // trust proxy of 1 hop, req.ip is the last entry.
      const blockedClientIp = '198.51.100.10';
      for (let index = 1; index <= REGISTER_LIMIT_FOR_TEST; index += 1) {
        const res = await request(server)
          .post('/api/auth/register')
          .set('X-Forwarded-For', blockedClientIp)
          .send(newUser(index));
        expect(res.statusCode).toBe(201);
      }

      const blockedRes = await request(server)
        .post('/api/auth/register')
        .set('X-Forwarded-For', blockedClientIp)
        .send(newUser(REGISTER_LIMIT_FOR_TEST + 1));
      expect(blockedRes.statusCode).toBe(429);
      expect(blockedRes.body).toEqual({
        message: 'Too many accounts created from this network. Please try again later.',
      });

      const otherClientRes = await request(server)
        .post('/api/auth/register')
        .set('X-Forwarded-For', '198.51.100.20')
        .send(newUser(REGISTER_LIMIT_FOR_TEST + 2));
      expect(otherClientRes.statusCode).toBe(201);

      expect(loggedRateLimitValidationErrors(consoleErrorSpy)).toEqual([]);
      expect(loggedRateLimitValidationErrors(consoleWarnSpy)).toEqual([]);
    } finally {
      consoleErrorSpy.mockRestore();
      consoleWarnSpy.mockRestore();
    }
  });
});

describe('resolveRegisterLimitConfig', () => {
  it('should apply the default limit, unskipped, in production when no override is set', () => {
    expect(resolveRegisterLimitConfig({ NODE_ENV: 'production' })).toEqual({
      limit: DEFAULT_REGISTER_LIMIT,
      skip: false,
    });
    expect(DEFAULT_REGISTER_LIMIT).toBe(10);
  });

  it('should skip only under NODE_ENV=test when no override is set', () => {
    expect(resolveRegisterLimitConfig({ NODE_ENV: 'test' }).skip).toBe(true);
    expect(resolveRegisterLimitConfig({ NODE_ENV: 'development' }).skip).toBe(false);
    expect(resolveRegisterLimitConfig({ NODE_ENV: 'test', REGISTER_RATE_LIMIT_MAX: '5' })).toEqual({
      limit: 5,
      skip: false,
    });
  });

  it('should reject a REGISTER_RATE_LIMIT_MAX that is not a positive integer', () => {
    expect(() => resolveRegisterLimitConfig({ REGISTER_RATE_LIMIT_MAX: 'abc' })).toThrow(
      'REGISTER_RATE_LIMIT_MAX must be a positive integer'
    );
    expect(() => resolveRegisterLimitConfig({ REGISTER_RATE_LIMIT_MAX: '0' })).toThrow(
      'REGISTER_RATE_LIMIT_MAX must be a positive integer'
    );
  });
});
