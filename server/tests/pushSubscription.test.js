const http = require('http');
const request = require('supertest');
const app = require('../index');
const User = require('../models/user.model');
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
  await new Promise((resolve) => server.close(resolve));
  await closeDB();
});

// Same shapes a browser's PushSubscription.toJSON() produces: unpadded base64url keys
const VALID_P256DH = Buffer.alloc(65, 4).toString('base64url');
const VALID_AUTH = Buffer.alloc(16, 7).toString('base64url');

const subscriptionFor = (endpoint, keyOverrides = {}) => ({
  endpoint,
  expirationTime: null,
  keys: { p256dh: VALID_P256DH, auth: VALID_AUTH, ...keyOverrides },
});

describe('POST /api/push/subscribe validation', () => {
  let authCookie;
  let userId;

  beforeEach(async () => {
    const res = await request(server).post('/api/auth/register').send({
      name: 'Push User',
      email: 'push@example.com',
      password: 'password123',
      bloodGroup: 'O-',
      location: [88.3639, 22.5726],
    });
    authCookie = res.headers['set-cookie'];
    userId = res.body.user._id;
  });

  const subscribe = (body) =>
    request(server).post('/api/push/subscribe').set('Cookie', authCookie).send(body);

  it.each([
    ['FCM (Chrome)', 'https://fcm.googleapis.com/fcm/send/dGVzdC1mY20tdG9rZW4'],
    ['Mozilla (Firefox)', 'https://updates.push.services.mozilla.com/wpush/v2/gAAAAABtest'],
  ])('should accept a valid %s subscription and store only the validated fields', async (_name, endpoint) => {
    const res = await subscribe({
      ...subscriptionFor(endpoint),
      extraField: 'must not be stored',
      keys: { p256dh: VALID_P256DH, auth: VALID_AUTH, extraKey: 'must not be stored' },
    });
    expect(res.statusCode).toBe(200);

    const stored = await User.findById(userId).lean();
    expect(stored.pushSubscription).toEqual({
      endpoint,
      expirationTime: null,
      keys: { p256dh: VALID_P256DH, auth: VALID_AUTH },
    });
  });

  it.each([
    ['plain http', 'http://fcm.googleapis.com/fcm/send/abc'],
    ['a loopback IP', 'https://127.0.0.1/push'],
    ['the cloud metadata IP', 'https://169.254.169.254/'],
    ['a host outside the allowlist', 'https://evil.com/'],
    ['an allowlisted name used as a prefix', 'https://fcm.googleapis.com.evil.com/'],
    ['userinfo in the URL', 'https://user@fcm.googleapis.com/'],
    ['a non-default port', 'https://fcm.googleapis.com:8443/fcm/send/abc'],
  ])('should reject an endpoint with %s', async (_name, endpoint) => {
    const res = await subscribe(subscriptionFor(endpoint));
    expect(res.statusCode).toBe(400);
    expect(res.body.errors).toHaveProperty('endpoint');

    const stored = await User.findById(userId).lean();
    expect(stored.pushSubscription).toBeNull();
  });

  it.each([
    ['p256dh one byte short', { p256dh: Buffer.alloc(64, 4).toString('base64url') }],
    ['auth one byte long', { auth: Buffer.alloc(17, 7).toString('base64url') }],
    ['auth not base64url', { auth: 'not base64url!!!!!!!!!' }],
  ])('should reject keys with %s', async (_name, keyOverrides) => {
    const res = await subscribe(subscriptionFor('https://fcm.googleapis.com/fcm/send/abc', keyOverrides));
    expect(res.statusCode).toBe(400);
    expect(res.body.errors).toHaveProperty('keys');

    const stored = await User.findById(userId).lean();
    expect(stored.pushSubscription).toBeNull();
  });
});
