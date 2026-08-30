const request = require('supertest');
const app = require('../index');
const { connectDB, closeDB, clearDB } = require('./db');

beforeAll(async () => {
  await connectDB();
});

afterEach(async () => {
  await clearDB();
});

afterAll(async () => {
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
    await request(app).post('/api/auth/register').send(requester);
    const loginRes = await request(app).post('/api/auth/login').send({
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
      const res = await request(app)
        .post('/api/requests')
        .set('Cookie', authCookie)
        .send(validRequest);
      
      expect(res.statusCode).toBe(201);
      expect(res.body.message).toBe('Request created and donors matched successfully');
      expect(res.body.request).toHaveProperty('hospitalName', validRequest.hospitalName);
    });

    it('should reject with invalid blood group (400)', async () => {
      const invalidData = { ...validRequest, bloodGroup: 'InvalidGroup' };
      const res = await request(app)
        .post('/api/requests')
        .set('Cookie', authCookie)
        .send(invalidData);
      
      expect(res.statusCode).toBe(400);
      expect(res.body.errors).toHaveProperty('bloodGroup');
    });

    it('should reject with unitsNeeded of 0 (400)', async () => {
      const invalidData = { ...validRequest, unitsNeeded: 0 };
      const res = await request(app)
        .post('/api/requests')
        .set('Cookie', authCookie)
        .send(invalidData);
      
      expect(res.statusCode).toBe(400);
      expect(res.body.errors).toHaveProperty('unitsNeeded', 'At least 1 unit is required');
    });
    
    it('should reject with unitsNeeded of -5 (400)', async () => {
      const invalidData = { ...validRequest, unitsNeeded: -5 };
      const res = await request(app)
        .post('/api/requests')
        .set('Cookie', authCookie)
        .send(invalidData);
      
      expect(res.statusCode).toBe(400);
      expect(res.body.errors).toHaveProperty('unitsNeeded', 'At least 1 unit is required');
    });
  });
});
