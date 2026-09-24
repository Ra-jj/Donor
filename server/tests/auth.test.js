const http = require('http');
const request = require('supertest');
const app = require('../index');
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
});
