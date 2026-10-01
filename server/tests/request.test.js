const http = require('http');
const request = require('supertest');
const app = require('../index');
const Request = require('../models/request.model');
const { connectDB, closeDB, clearDB } = require('./db');
const { REGISTRATION_CONSENT } = require('./registration');

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
    await request(server).post('/api/auth/register').send({ ...requester, ...REGISTRATION_CONSENT });
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

// hospitalLocation is GeoJSON order, [longitude, latitude]. The client sends a place picked from the
// hospital search or the device's position; the server takes neither on trust.
describe('POST /api/requests hospitalLocation', () => {
  let authCookie;

  // The cookie sign-up sets, not a login: login allows 10 attempts per IP per 15 minutes, and
  // every test here needs a fresh user (afterEach clears the database)
  beforeEach(async () => {
    const res = await request(server).post('/api/auth/register').send({
      name: 'Location Requester',
      email: 'location.requester@example.com',
      password: 'password123',
      bloodGroup: 'B+',
      location: [77.5946, 12.9716], // Bangalore
      ...REGISTRATION_CONSENT,
    });
    expect(res.statusCode).toBe(201);
    authCookie = res.headers['set-cookie'];
  });

  const validRequest = {
    bloodGroup: 'B+',
    unitsNeeded: 2,
    hospitalName: 'Test Hospital',
    hospitalLocation: [77.5946, 12.9716],
    urgency: 'high',
  };

  it('stores the hospital location exactly as sent, in [longitude, latitude] order', async () => {
    const kolkataHospital = [88.4016701, 22.5743908];
    const res = await request(server)
      .post('/api/requests')
      .set('Cookie', authCookie)
      .send({ ...validRequest, hospitalLocation: kolkataHospital });

    expect(res.statusCode).toBe(201);
    expect(res.body.request.hospitalLocation).toEqual({ type: 'Point', coordinates: kolkataHospital });
    const stored = await Request.findById(res.body.request._id).lean();
    expect(stored.hospitalLocation).toEqual({ type: 'Point', coordinates: kolkataHospital });
  });

  it.each([
    ['the largest longitude and smallest latitude', [180, -90]],
    ['the smallest longitude and largest latitude', [-180, 90]],
  ])('accepts a hospital location at %s', async (_label, hospitalLocation) => {
    const res = await request(server)
      .post('/api/requests')
      .set('Cookie', authCookie)
      .send({ ...validRequest, hospitalLocation });

    expect(res.statusCode).toBe(201);
    expect(res.body.request.hospitalLocation.coordinates).toEqual(hospitalLocation);
  });

  const INVALID_LONGITUDE = 'Invalid longitude';
  const INVALID_LATITUDE = 'Invalid latitude';
  const WRONG_LENGTH = 'Location must be an array of exactly 2 numbers [longitude, latitude]';

  // The validate middleware keeps one message per field, the last Zod reported
  it.each([
    ['a longitude above 180', [180.0001, 22.57], INVALID_LONGITUDE],
    ['a longitude below -180', [-181, 22.57], INVALID_LONGITUDE],
    ['a latitude above 90', [88.36, 90.0001], INVALID_LATITUDE],
    ['a latitude below -90', [88.36, -91], INVALID_LATITUDE],
    ['both out of range', [200, 100], INVALID_LATITUDE],
    ['a single number', [88.36], INVALID_LATITUDE],
    ['three numbers', [88.36, 22.57, 0], WRONG_LENGTH],
    ['an empty array', [], INVALID_LATITUDE],
  ])('rejects %s, and saves nothing (400)', async (_label, hospitalLocation, expectedMessage) => {
    const res = await request(server)
      .post('/api/requests')
      .set('Cookie', authCookie)
      .send({ ...validRequest, hospitalLocation });

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: 'Validation failed', errors: { hospitalLocation: expectedMessage } });
    expect(await Request.countDocuments()).toBe(0);
  });

  it.each([
    ['numbers sent as strings', ['88.36', '22.57'], 'expected number, received string'],
    ['one coordinate as a string', [88.36, '22.57'], 'expected number, received string'],
    ['nulls', [null, null], 'expected number, received null'],
    ['booleans', [true, false], 'expected number, received boolean'],
    ['nested arrays', [[88.36], [22.57]], 'expected number, received array'],
    ['an object with lng and lat', { lng: 88.36, lat: 22.57 }, 'expected array, received object'],
    ['a GeoJSON Point object', { type: 'Point', coordinates: [88.36, 22.57] }, 'expected array, received object'],
    ['a "lng,lat" string', '88.36,22.57', WRONG_LENGTH],
    ['a single number', 88.36, 'expected array, received number'],
    ['null', null, 'expected array, received null'],
  ])('rejects a hospital location of %s, and saves nothing (400)', async (_label, hospitalLocation, expectedMessage) => {
    const res = await request(server)
      .post('/api/requests')
      .set('Cookie', authCookie)
      .send({ ...validRequest, hospitalLocation });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toBe('Validation failed');
    expect(Object.keys(res.body.errors)).toEqual(['hospitalLocation']);
    expect(res.body.errors.hospitalLocation).toContain(expectedMessage);
    expect(await Request.countDocuments()).toBe(0);
  });

  it('rejects a hospital location missing from the body, and saves nothing (400)', async () => {
    const { hospitalLocation: _omitted, ...withoutLocation } = validRequest;
    const res = await request(server).post('/api/requests').set('Cookie', authCookie).send(withoutLocation);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      message: 'Validation failed',
      errors: { hospitalLocation: 'Invalid input: expected array, received undefined' },
    });
    expect(await Request.countDocuments()).toBe(0);
  });

  // JSON has no Infinity, but a number too large for a double parses to it
  it.each([
    ['longitude', '[1e400, 22.57]'],
    ['latitude', '[88.36, -1e400]'],
  ])('rejects a %s that overflows to Infinity, and saves nothing (400)', async (_label, coordinatesJson) => {
    const body = `{"bloodGroup":"B+","unitsNeeded":2,"hospitalName":"Test Hospital","hospitalLocation":${coordinatesJson}}`;
    const res = await request(server)
      .post('/api/requests')
      .set('Cookie', authCookie)
      .set('Content-Type', 'application/json')
      .send(body);

    expect(res.statusCode).toBe(400);
    expect(res.body.errors.hospitalLocation).toMatch(/^Invalid input: expected number, received -?Infinity$/);
    expect(await Request.countDocuments()).toBe(0);
  });
});
