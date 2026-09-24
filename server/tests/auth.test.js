const http = require('http');
const request = require('supertest');
const jwt = require('jsonwebtoken');
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

describe('Auth Endpoints', () => {
  const validUser = {
    name: 'Test User',
    email: 'testuser@example.com',
    password: 'password123',
    bloodGroup: 'O+',
    location: [77.5946, 12.9716],
  };

  describe('POST /api/auth/register', () => {
    it('should register a new user with valid data', async () => {
      const res = await request(server).post('/api/auth/register').send(validUser);
      expect(res.statusCode).toBe(201);
      expect(res.body.message).toBe('User registered successfully');
      expect(res.body.user).toHaveProperty('name', validUser.name);
      expect(res.body.user).not.toHaveProperty('password');
    });

    it('should fail with invalid email format', async () => {
      const invalidData = { ...validUser, email: 'not-an-email' };
      const res = await request(server).post('/api/auth/register').send(invalidData);
      expect(res.statusCode).toBe(400);
      expect(res.body.errors).toHaveProperty('email', 'Please enter a valid email address (e.g. name@domain.com)');
    });

    it('should fail with password under 6 chars', async () => {
      const invalidData = { ...validUser, password: '123' };
      const res = await request(server).post('/api/auth/register').send(invalidData);
      expect(res.statusCode).toBe(400);
      expect(res.body.errors).toHaveProperty('password', 'Password must be at least 6 characters long');
    });

    it('should return the custom "Invalid blood group" message for an unknown blood group', async () => {
      const invalidData = { ...validUser, bloodGroup: 'Z+' };
      const res = await request(server).post('/api/auth/register').send(invalidData);
      expect(res.statusCode).toBe(400);
      expect(res.body.errors).toHaveProperty('bloodGroup', 'Invalid blood group');
    });

    it('should fail with duplicate email', async () => {
      await request(server).post('/api/auth/register').send(validUser);
      const res = await request(server).post('/api/auth/register').send(validUser);
      // Fails at the controller level
      expect(res.statusCode).toBe(400);
      expect(res.body.message).toBe('Email is already registered.');
    });
  });

  describe('POST /api/auth/login', () => {
    beforeEach(async () => {
      await request(server).post('/api/auth/register').send(validUser);
    });

    it('should login with correct credentials and set cookie', async () => {
      const res = await request(server).post('/api/auth/login').send({
        email: validUser.email,
        password: validUser.password,
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.message).toBe('Logged in successfully');
      expect(res.headers['set-cookie']).toBeDefined();
    });

    it('should fail with wrong password', async () => {
      const res = await request(server).post('/api/auth/login').send({
        email: validUser.email,
        password: 'wrongpassword',
      });
      expect(res.statusCode).toBe(400);
      expect(res.body.message).toBe('Invalid credentials.');
    });
  });

  describe('protectRoute rejects bad credentials with 401', () => {
    const registerAndGetUserId = async () => {
      const res = await request(server).post('/api/auth/register').send(validUser);
      expect(res.statusCode).toBe(201);
      return res.body.user._id;
    };

    it('should return 401 for an expired token', async () => {
      const userId = await registerAndGetUserId();
      const expiredToken = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: -60 });

      const res = await request(server).get('/api/auth/check').set('Cookie', `jwt=${expiredToken}`);
      expect(res.statusCode).toBe(401);
      expect(res.body.message).toBe('Unauthorized - Invalid Token');
    });

    it('should return 401 for a token signed with the wrong secret', async () => {
      const userId = await registerAndGetUserId();
      const forgedToken = jwt.sign({ userId }, 'not-the-server-secret', { expiresIn: '1h' });

      const res = await request(server).get('/api/auth/check').set('Cookie', `jwt=${forgedToken}`);
      expect(res.statusCode).toBe(401);
      expect(res.body.message).toBe('Unauthorized - Invalid Token');
    });

    it('should return 401 when the token belongs to a deleted user', async () => {
      const registerRes = await request(server).post('/api/auth/register').send(validUser);
      const authCookie = registerRes.headers['set-cookie'];
      await User.deleteOne({ _id: registerRes.body.user._id });

      const res = await request(server).get('/api/auth/check').set('Cookie', authCookie);
      expect(res.statusCode).toBe(401);
      expect(res.body.message).toBe('Unauthorized - User not found');
    });
  });

  describe('POST /api/auth/logout', () => {
    it('should expire the jwt cookie with the same attributes it was set with', async () => {
      const res = await request(server).post('/api/auth/logout');
      expect(res.statusCode).toBe(200);

      const jwtCookie = (res.headers['set-cookie'] || []).find((cookie) => cookie.startsWith('jwt='));
      expect(jwtCookie).toBeDefined();
      expect(jwtCookie).toMatch(/^jwt=;/);
      expect(jwtCookie).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
      expect(jwtCookie).toContain('Path=/');
      expect(jwtCookie).toContain('HttpOnly');
      expect(jwtCookie).toContain('SameSite=Strict');
    });
  });
});
