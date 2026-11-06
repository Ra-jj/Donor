const http = require('http');
const mongoose = require('mongoose');
const request = require('supertest');
const app = require('../index');
const Request = require('../models/request.model');
const User = require('../models/user.model');
const {
  PUBLIC_STATS_CACHE_MS,
  readPublicStats,
  clearPublicStatsCache,
} = require('../controllers/publicStats.controller');
const { generateShareToken } = require('../utils/shareToken');
const { connectDB, closeDB, clearDB } = require('./db');

// The home page's totals, GET /api/public/stats: anyone may call it, it counts, and it says nothing
// about any one user.

// Coordinates are [longitude, latitude]
const HOSPITAL = [77.5946, 12.9716]; // Bangalore
const NEARBY = [77.6, 12.975]; // ~0.7 km from HOSPITAL
const MINUTE_MS = 60 * 1000;

// supertest dials 127.0.0.1, so bind there explicitly. request(app) binds `::`, and another
// local app on the same ephemeral port can answer instead.
let server;
let userCount = 0;

beforeAll(async () => {
  await connectDB();
  await Request.init();
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
});

beforeEach(() => {
  // Each test counts its own documents, not a copy an earlier test left in memory
  clearPublicStatsCache();
});

afterEach(async () => {
  jest.restoreAllMocks();
  await clearDB();
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await closeDB();
});

// Straight on the model: none of them logs in
const createUser = () => {
  userCount += 1;
  return User.create({
    name: `Stats Person ${userCount}`,
    email: `stats.person${userCount}@example.com`,
    password: 'not-a-real-hash',
    bloodGroup: 'A+',
    location: { type: 'Point', coordinates: NEARBY },
  });
};

const createBloodRequest = (overrides) =>
  Request.create({
    requesterId: new mongoose.Types.ObjectId(),
    bloodGroup: 'B+',
    unitsNeeded: 1,
    hospitalName: 'Stats Test Hospital',
    hospitalLocation: { type: 'Point', coordinates: HOSPITAL },
    ...overrides,
  });

const readStats = () => request(server).get('/api/public/stats');

describe('GET /api/public/stats', () => {
  it('counts fulfilled requests, anonymised ones included, and the accounts that exist', async () => {
    const people = [await createUser(), await createUser(), await createUser()];
    await createBloodRequest({ status: 'fulfilled', matchedDonorId: people[0]._id, fulfilledAt: new Date() });
    // Kept by deleteAccount: the requester deleted theirs, or the donor deleted theirs
    await createBloodRequest({ status: 'fulfilled', requesterId: null, matchedDonorId: people[1]._id, fulfilledAt: new Date() });
    await createBloodRequest({ status: 'fulfilled', matchedDonorId: null, fulfilledAt: new Date() });
    // Not donations
    await createBloodRequest({ status: 'pending' });
    await createBloodRequest({ status: 'accepted', matchedDonorId: people[2]._id });
    await createBloodRequest({ status: 'cancelled', closedReason: 'expired' });
    // An outside donation is self-reported, so it is not one either
    await User.updateOne({ _id: people[2]._id }, { $set: { lastOutsideDonationDate: new Date('2026-01-01T00:00:00.000Z') } });

    const res = await readStats();

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ donationsCompleted: 3, peopleRegistered: 3 });
  });

  it('answers 0 and 0 when there is nothing yet', async () => {
    const res = await readStats();

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ donationsCompleted: 0, peopleRegistered: 0 });
  });

  it('holds nothing about any one user', async () => {
    const person = await createUser();
    await createBloodRequest({ status: 'fulfilled', matchedDonorId: person._id, fulfilledAt: new Date() });

    const res = await readStats();

    expect(Object.keys(res.body).sort()).toEqual(['donationsCompleted', 'peopleRegistered']);
    expect(res.text).not.toContain(String(person._id));
    expect(res.text).not.toContain(person.email);
    expect(res.text).not.toContain(person.name);
    expect(res.text).not.toContain('Stats Test Hospital');
  });

  it('may be kept by a browser for 5 minutes, needs no login, and stays out of search results', async () => {
    const res = await readStats();

    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.headers['x-robots-tag']).toBe('noindex');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers['ratelimit-limit']).toBe('300');
  });

  it('answers 500 with no-store when counting fails, and counts again on the next call', async () => {
    await createUser();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const countSpy = jest.spyOn(Request, 'countDocuments').mockRejectedValueOnce(new Error('database unavailable'));

    const failed = await readStats();

    expect(failed.statusCode).toBe(500);
    expect(failed.body).toEqual({ message: 'Internal Server Error' });
    expect(failed.headers['cache-control']).toBe('no-store');
    expect(console.error).toHaveBeenCalledWith('Error in getPublicStats:', 'database unavailable');

    countSpy.mockRestore();
    const next = await readStats();
    expect(next.statusCode).toBe(200);
    expect(next.body).toEqual({ donationsCompleted: 0, peopleRegistered: 1 });
  });
});

describe('the copy in memory', () => {
  it('is used for 10 minutes, then the database is counted again', async () => {
    expect(PUBLIC_STATS_CACHE_MS).toBe(10 * MINUTE_MS);
    const startMs = Date.now();
    await createUser();
    expect(await readPublicStats(startMs)).toEqual({ donationsCompleted: 0, peopleRegistered: 1 });

    await createUser();
    await createBloodRequest({ status: 'fulfilled', matchedDonorId: new mongoose.Types.ObjectId(), fulfilledAt: new Date() });

    expect(await readPublicStats(startMs + PUBLIC_STATS_CACHE_MS - 1)).toEqual({ donationsCompleted: 0, peopleRegistered: 1 });
    // The route reads the same copy
    expect((await readStats()).body).toEqual({ donationsCompleted: 0, peopleRegistered: 1 });
    expect(await readPublicStats(startMs + PUBLIC_STATS_CACHE_MS)).toEqual({ donationsCompleted: 1, peopleRegistered: 2 });
  });

  it('is counted once for calls that arrive together', async () => {
    const requestCountSpy = jest.spyOn(Request, 'countDocuments');
    const userCountSpy = jest.spyOn(User, 'countDocuments');

    const results = await Promise.all([readStats(), readStats(), readPublicStats(), readPublicStats()]);

    expect(requestCountSpy).toHaveBeenCalledTimes(1);
    expect(userCountSpy).toHaveBeenCalledTimes(1);
    expect(results[0].body).toEqual({ donationsCompleted: 0, peopleRegistered: 0 });
    expect(results[3]).toEqual({ donationsCompleted: 0, peopleRegistered: 0 });
  });
});

// Last in this file: it uses up the limiter's allowance for this address
describe('the rate limit', () => {
  it('answers 429 with no-store after 300 calls, and leaves shared links their own allowance', async () => {
    const first = await readStats();
    const remaining = Number(first.headers['ratelimit-remaining']);
    expect(remaining).toBeGreaterThan(0);

    for (let i = 0; i < remaining; i += 1) {
      const res = await readStats();
      expect(res.statusCode).not.toBe(429);
    }
    const limited = await readStats();

    expect(limited.statusCode).toBe(429);
    expect(limited.headers['cache-control']).toBe('no-store');
    expect(limited.headers['x-robots-tag']).toBe('noindex');
    expect(limited.body).toEqual({ message: 'Too many requests from this network. Please wait a few minutes and try again.' });

    // A separate count: a shared request's page still opens from the same address
    const sharedLink = await request(server).get(`/api/public/requests/${generateShareToken()}`);
    expect(sharedLink.statusCode).toBe(404);
    // About 300 calls one after another: more than Jest's default 5 s on a slow CI runner
  }, 30000);
});
