const http = require('http');
const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../index');
const Request = require('../models/request.model');
const { connectDB, closeDB, clearDB } = require('./db');

// supertest dials 127.0.0.1, so bind there explicitly. request(app) binds `::`, and another
// local app on the same ephemeral port can answer instead.
let server;

beforeAll(async () => {
  await connectDB();
  // Mongoose builds indexes in the background; wait so the unique indexes exist before the first test
  await Request.init();
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

// Each route with an id param, with a body that passes its own validation, so a 400
// can only come from the id check and a 404 only from the lookup
const ID_ROUTES = [
  { name: 'PATCH /api/requests/:id/status', method: 'patch', path: (id) => `/api/requests/${id}/status`, body: { status: 'accepted' } },
  { name: 'PATCH /api/requests/:id/fulfill', method: 'patch', path: (id) => `/api/requests/${id}/fulfill`, body: undefined },
  { name: 'POST /api/requests/:id/rate', method: 'post', path: (id) => `/api/requests/${id}/rate`, body: { rating: 5 } },
  { name: 'GET /api/messages/:requestId', method: 'get', path: (id) => `/api/messages/${id}`, body: undefined },
  { name: 'POST /api/messages/send/:requestId', method: 'post', path: (id) => `/api/messages/send/${id}`, body: { text: 'Hello' } },
];

const MALFORMED_IDS = ['not-an-id', '12345', 'zzzzzzzzzzzzzzzzzzzzzzzz'];

const callRoute = (route, id, cookie) => {
  let call = request(server)[route.method](route.path(id));
  if (cookie) {
    call = call.set('Cookie', cookie);
  }
  return route.body === undefined ? call : call.send(route.body);
};

describe('malformed ids in route params', () => {
  let cookie;

  // Register reuses the cookie it sets; logging in per test would hit the login rate limiter
  beforeEach(async () => {
    const res = await request(server).post('/api/auth/register').send({
      name: 'Id Tester',
      email: 'id.tester@example.com',
      password: 'password123',
      bloodGroup: 'O-',
      location: [77.5946, 12.9716],
    });
    expect(res.statusCode).toBe(201);
    cookie = res.headers['set-cookie'];
  });

  describe.each(ID_ROUTES)('$name', (route) => {
    it.each(MALFORMED_IDS)('returns 400 for the malformed id "%s"', async (badId) => {
      const res = await callRoute(route, badId, cookie);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ message: 'Invalid request id' });
    });

    it('still returns 404 for a well-formed id that does not exist', async () => {
      const res = await callRoute(route, new mongoose.Types.ObjectId().toString(), cookie);

      expect(res.statusCode).toBe(404);
      expect(res.body.message).toBe('Request not found');
    });

    it('checks auth first: 401 without a cookie, even for a malformed id', async () => {
      const res = await callRoute(route, 'not-an-id', undefined);

      expect(res.statusCode).toBe(401);
    });
  });
});
