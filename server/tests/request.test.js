const http = require('http');
const request = require('supertest');
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
  if (server) await new Promise((resolve) => server.close(resolve));
  await closeDB();
});

describe('Request Endpoints', () => {
  let authCookie;

  beforeEach(async () => {
    // Register and login a requester
    const requester = {
      name: 'Requester',
      email: 'req@example.com',
      password: 'password123',
      bloodGroup: 'B+',
      location: [77.5946, 12.9716], // Bangalore
    };
    await request(server).post('/api/auth/register').send(requester);
    const loginRes = await request(server).post('/api/auth/login').send({
      email: requester.email,
      password: requester.password,
    });
    authCookie = loginRes.headers['set-cookie'];
  });

  const validRequest = {
    bloodGroup: 'B+',
    unitsNeeded: 2,
    hospitalName: 'Test Hospital',
    hospitalLocation: [77.5946, 12.9716],
    urgency: 'high'
  };

  describe('POST /api/requests', () => {
    it('should create a request with valid data', async () => {
      const res = await request(server)
        .post('/api/requests')
        .set('Cookie', authCookie)
        .send(validRequest);
      
      expect(res.statusCode).toBe(201);
      expect(res.body.message).toBe('Request created and donors matched successfully');
      expect(res.body.request).toHaveProperty('hospitalName', validRequest.hospitalName);
    });

    it('should reject with invalid blood group (400)', async () => {
      const invalidData = { ...validRequest, bloodGroup: 'InvalidGroup' };
      const res = await request(server)
        .post('/api/requests')
        .set('Cookie', authCookie)
        .send(invalidData);
      
      expect(res.statusCode).toBe(400);
      expect(res.body.errors).toHaveProperty('bloodGroup');
    });

    it('should reject with unitsNeeded of 0 (400)', async () => {
      const invalidData = { ...validRequest, unitsNeeded: 0 };
      const res = await request(server)
        .post('/api/requests')
        .set('Cookie', authCookie)
        .send(invalidData);
      
      expect(res.statusCode).toBe(400);
      expect(res.body.errors).toHaveProperty('unitsNeeded', 'At least 1 unit is required');
    });
    
    it('should reject with unitsNeeded of -5 (400)', async () => {
      const invalidData = { ...validRequest, unitsNeeded: -5 };
      const res = await request(server)
        .post('/api/requests')
        .set('Cookie', authCookie)
        .send(invalidData);
      
      expect(res.statusCode).toBe(400);
      expect(res.body.errors).toHaveProperty('unitsNeeded', 'At least 1 unit is required');
    });
  });
});
