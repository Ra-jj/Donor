const fs = require('fs');
const path = require('path');
const request = require('supertest');
const mongoose = require('mongoose');
const webpush = require('web-push');
// Mounts the routes on the app that lib/socket's server serves
require('../index');
const { io, server } = require('../lib/socket');
const Request = require('../models/request.model');
const { findNextEligibleDonationAt } = require('../utils/donationGap');
const {
  REQUEST_OPEN_HOURS,
  SWEEP_INTERVAL_MS,
  LAZY_SWEEP_MIN_GAP_MS,
  getRequestOpenCutoff,
  expireStaleRequests,
  expireStaleRequestsIfDue,
  startRequestExpirySweeps,
} = require('../utils/requestExpiry');
const { connectDB, closeDB, clearDB } = require('./db');
const { REGISTRATION_CONSENT } = require('./registration');

// Time is controlled through createdAt, written on create (Mongoose keeps a createdAt it is given),
// and through the sweep's nowMs. No fake timers: the driver and Mongoose need the real clock.

// Coordinates are [longitude, latitude]
const HOSPITAL = [77.5946, 12.9716]; // Bangalore
const NEARBY = [77.6, 12.975]; // ~0.7 km from HOSPITAL
const ALSO_NEARBY = [77.58, 12.96]; // ~2 km from HOSPITAL

const PASSWORD = 'password123';
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const OPEN_MS = 48 * HOUR_MS;
// Long enough for an event already emitted to arrive, and for work after a 200 to finish
const SILENCE_WINDOW_MS = 300;

let userCount = 0;

beforeAll(async () => {
  await connectDB();
  // Builds every index first, including { status, createdAt } and one_active_donation_per_donor
  await Request.init();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
});

beforeEach(() => {
  // protectRoute logs every rejection; nothing here is about them
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  // A reopened request is announced to nearby donors, push included; never reach a real service
  jest.spyOn(webpush, 'sendNotification').mockResolvedValue({ statusCode: 201 });
});

afterEach(async () => {
  jest.restoreAllMocks();
  await clearDB();
});

afterAll(async () => {
  await new Promise((resolve) => io.close(() => resolve()));
  await closeDB();
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitUntil = async (check, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms`);
    await delay(10);
  }
};

// Register through the API and reuse the cookie register sets (login is rate limited)
const registerUser = async ({ bloodGroup = 'O-', location = NEARBY, name } = {}) => {
  userCount += 1;
  const res = await request(server)
    .post('/api/auth/register')
    .send({
      name: name || `Expiry User ${userCount}`,
      email: `expiry.user${userCount}@example.com`,
      password: PASSWORD,
      bloodGroup,
      location,
      ...REGISTRATION_CONSENT,
    });
  expect(res.statusCode).toBe(201);
  return { id: res.body.user._id, name: res.body.user.name, cookie: res.headers['set-cookie'] };
};

const registerRequester = (name = 'Rita Requester') => registerUser({ name, bloodGroup: 'A+', location: HOSPITAL });

// Created directly on the model, ageMs old, so each test controls status, donor and age
const createBloodRequest = (requesterId, { ageMs = 0, ...overrides } = {}) =>
  Request.create({
    requesterId,
    bloodGroup: 'B+',
    unitsNeeded: 2,
    hospitalName: 'Expiry Test Hospital',
    hospitalLocation: { type: 'Point', coordinates: HOSPITAL },
    urgency: 'high',
    createdAt: new Date(Date.now() - ageMs),
    ...overrides,
  });

const asUser = (user, method, url) => request(server)[method](url).set('Cookie', user.cookie);
const patchStatus = (requestId, user, status) => asUser(user, 'patch', `/api/requests/${requestId}/status`).send({ status });

// The stored document, raw: compares by value, declinedBy and updatedAt included
const readRaw = async (requestId) => JSON.stringify(await Request.collection.findOne({ _id: requestId }));

// Replaces io.to() so a test can see which rooms were notified, with which event and payload
const spyOnSocket = () => {
  const emit = jest.fn();
  const to = jest.spyOn(io, 'to').mockReturnValue({ emit });
  const sent = () =>
    to.mock.calls.map(([room], index) => {
      const [event, payload] = emit.mock.calls[index];
      return { room: String(room), event, payload };
    });
  return {
    to,
    sent,
    statusUpdates: () =>
      sent()
        .filter(({ event }) => event === 'requestStatusUpdate')
        .map(({ room, payload }) => ({ room, payload: { ...payload, requestId: String(payload.requestId) } })),
    expiredUpdates: () =>
      sent().filter(({ event, payload }) => event === 'requestStatusUpdate' && payload.reason === 'expired'),
    newRequestAlerts: () => sent().filter(({ event }) => event === 'newBloodRequest'),
  };
};

const expiredEventFor = (requester, bloodRequest) => ({
  room: requester.id,
  payload: {
    requestId: String(bloodRequest._id),
    status: 'cancelled',
    reason: 'expired',
    hospitalName: 'Expiry Test Hospital',
  },
});

// First in this file on purpose: nothing has swept yet in this module, so the read below is due
// one. Later tests move the throttle's clock forward.
describe('GET /api/requests/incoming after the server woke up', () => {
  it('starts a sweep that closes the requests that ran out and tells each requester', async () => {
    const requester = await registerRequester();
    const donor = await registerUser();
    const stale = await createBloodRequest(requester.id, { ageMs: OPEN_MS + HOUR_MS });
    const fresh = await createBloodRequest(requester.id, { ageMs: HOUR_MS });
    const socket = spyOnSocket();

    const res = await asUser(donor, 'get', '/api/requests/incoming');

    expect(res.statusCode).toBe(200);
    expect(res.body.incomingRequests.map((req) => req._id)).toEqual([String(fresh._id)]);
    // The list does not wait for the sweep, so it may finish after the response. The event is
    // sent after the write, so once it is here the request is stored as closed.
    await waitUntil(() => socket.statusUpdates().length === 1);
    expect(await Request.collection.findOne({ _id: stale._id })).toMatchObject({ status: 'cancelled', closedReason: 'expired' });
    expect(socket.statusUpdates()).toEqual([expiredEventFor(requester, stale)]);
  });
});

describe('expireStaleRequests (the sweep)', () => {
  it('closes a pending request at exactly 48 h and leaves one at 47 h 59 m open', async () => {
    const requester = await registerRequester();
    const nowMs = Date.now();
    const atDeadline = await createBloodRequest(requester.id, { createdAt: new Date(nowMs - OPEN_MS) });
    const justInside = await createBloodRequest(requester.id, { createdAt: new Date(nowMs - OPEN_MS + MINUTE_MS) });

    const expiredIds = await expireStaleRequests({ nowMs });

    expect(expiredIds.map(String)).toEqual([String(atDeadline._id)]);
    const closed = await Request.collection.findOne({ _id: atDeadline._id });
    expect(closed).toMatchObject({ status: 'cancelled', closedReason: 'expired', matchedDonorId: null, fulfilledAt: null });
    const open = await Request.collection.findOne({ _id: justInside._id });
    expect(open.status).toBe('pending');
    expect(open).not.toHaveProperty('closedReason');
  });

  it.each([
    ['accepted', { status: 'accepted' }],
    ['fulfilled', { status: 'fulfilled', fulfilledAt: new Date(Date.now() - 9 * DAY_MS) }],
    ['cancelled', { status: 'cancelled' }],
  ])('never touches a %s request, however old', async (_label, overrides) => {
    const requester = await registerRequester();
    const donor = await registerUser();
    const matchedDonorId = overrides.status === 'cancelled' ? null : donor.id;
    const old = await createBloodRequest(requester.id, { ageMs: 10 * DAY_MS, matchedDonorId, ...overrides });
    const before = await readRaw(old._id);
    const socket = spyOnSocket();

    expect(await expireStaleRequests()).toEqual([]);

    expect(await readRaw(old._id)).toBe(before);
    expect(socket.sent()).toEqual([]);
  });

  it('is idempotent: a second run changes nothing and sends nothing', async () => {
    const requester = await registerRequester();
    const stale = await createBloodRequest(requester.id, { ageMs: OPEN_MS + MINUTE_MS });
    expect((await expireStaleRequests()).map(String)).toEqual([String(stale._id)]);
    const afterFirst = await readRaw(stale._id);
    const socket = spyOnSocket();

    expect(await expireStaleRequests()).toEqual([]);

    expect(await readRaw(stale._id)).toBe(afterFirst);
    expect(socket.sent()).toEqual([]);
  });

  it("notifies only the requester's room, once, with reason 'expired'", async () => {
    const requester = await registerRequester();
    const otherRequester = await registerRequester('Omar Requester');
    // A compatible donor nearby, who was alerted when the request was created
    await registerUser();
    const stale = await createBloodRequest(requester.id, { ageMs: OPEN_MS + HOUR_MS });
    await createBloodRequest(otherRequester.id, { ageMs: HOUR_MS });
    const socket = spyOnSocket();

    await expireStaleRequests();
    await expireStaleRequests();

    expect(socket.statusUpdates()).toEqual([expiredEventFor(requester, stale)]);
    expect(socket.sent()).toHaveLength(1);
  });

  it('closes and announces each request once when two sweeps run at the same moment', async () => {
    const requester = await registerRequester();
    const staleRequests = [];
    for (let i = 0; i < 4; i += 1) {
      staleRequests.push(await createBloodRequest(requester.id, { ageMs: OPEN_MS + (i + 1) * MINUTE_MS }));
    }
    const socket = spyOnSocket();

    const [firstIds, secondIds] = await Promise.all([expireStaleRequests(), expireStaleRequests()]);

    const allIds = [...firstIds, ...secondIds].map(String).sort();
    expect(allIds).toEqual(staleRequests.map((req) => String(req._id)).sort());
    expect(socket.expiredUpdates().map(({ payload }) => String(payload.requestId)).sort()).toEqual(allIds);
  });

  describe('over a backlog', () => {
    const BACKLOG_SIZE = 25;
    const BATCH_SIZE = 10;

    const createBacklog = async (requesterId) => {
      const nowMs = Date.now();
      const docs = [];
      for (let i = 0; i < BACKLOG_SIZE; i += 1) {
        docs.push({
          requesterId: new mongoose.Types.ObjectId(requesterId),
          bloodGroup: 'B+',
          unitsNeeded: 1,
          hospitalName: 'Expiry Test Hospital',
          hospitalLocation: { type: 'Point', coordinates: HOSPITAL },
          urgency: 'high',
          status: 'pending',
          createdAt: new Date(nowMs - OPEN_MS - (i + 1) * MINUTE_MS),
        });
      }
      const { insertedIds } = await Request.collection.insertMany(docs);
      return Object.values(insertedIds).map(String).sort();
    };

    // Counts the sweep's writes in flight, each held a moment so that overlapping ones overlap
    const trackWritesInFlight = ({ failOnCall } = {}) => {
      const realUpdateOne = Request.updateOne.bind(Request);
      const stats = { inFlight: 0, maxInFlight: 0, started: 0, inFlightWhenSettled: null };
      jest.spyOn(Request, 'updateOne').mockImplementation(async (...args) => {
        stats.started += 1;
        const call = stats.started;
        stats.inFlight += 1;
        stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
        try {
          await delay(call === failOnCall ? 5 : 20);
          if (call === failOnCall) throw new Error('forced write failure');
          return await realUpdateOne(...args);
        } finally {
          stats.inFlight -= 1;
        }
      });
      return stats;
    };

    it(`closes every request, at most ${BATCH_SIZE} writes at a time, announcing each once`, async () => {
      const requester = await registerRequester();
      const backlogIds = await createBacklog(requester.id);
      const stats = trackWritesInFlight();
      const socket = spyOnSocket();

      const expiredIds = await expireStaleRequests();

      expect(expiredIds.map(String).sort()).toEqual(backlogIds);
      expect(stats.maxInFlight).toBe(BATCH_SIZE);
      expect(stats.inFlight).toBe(0);
      expect(socket.expiredUpdates().map(({ payload }) => String(payload.requestId)).sort()).toEqual(backlogIds);
      expect(socket.expiredUpdates().every(({ room }) => room === requester.id)).toBe(true);
      expect(await Request.countDocuments({ status: 'cancelled', closedReason: 'expired' })).toBe(BACKLOG_SIZE);
    });

    it('stops at a failed write, once the rest of its batch has settled, and starts no later batch', async () => {
      const requester = await registerRequester();
      await createBacklog(requester.id);
      // The first write of the second batch fails, before the others in that batch finish
      const stats = trackWritesInFlight({ failOnCall: BATCH_SIZE + 1 });
      const socket = spyOnSocket();

      await expect(
        expireStaleRequests().finally(() => {
          stats.inFlightWhenSettled = stats.inFlight;
        })
      ).rejects.toThrow('forced write failure');

      expect(stats.inFlightWhenSettled).toBe(0);
      expect(stats.started).toBe(2 * BATCH_SIZE);
      // The first batch and the second batch's other writes closed theirs, and each was announced
      const closedCount = await Request.countDocuments({ status: 'cancelled', closedReason: 'expired' });
      expect(closedCount).toBe(2 * BATCH_SIZE - 1);
      expect(socket.expiredUpdates()).toHaveLength(closedCount);
    });
  });

  it('closes only the requests in scope', async () => {
    const requester = await registerRequester();
    const otherRequester = await registerRequester('Omar Requester');
    const mine = await createBloodRequest(requester.id, { ageMs: OPEN_MS + HOUR_MS });
    const theirs = await createBloodRequest(otherRequester.id, { ageMs: OPEN_MS + HOUR_MS });

    const expiredIds = await expireStaleRequests({ scope: { requesterId: new mongoose.Types.ObjectId(requester.id) } });

    expect(expiredIds.map(String)).toEqual([String(mine._id)]);
    expect((await Request.findById(theirs._id)).status).toBe('pending');
  });

  it('finds its candidates through the { status, createdAt } index', async () => {
    const requesterId = new mongoose.Types.ObjectId();
    const nowMs = Date.now();
    const base = {
      requesterId,
      bloodGroup: 'B+',
      unitsNeeded: 1,
      hospitalName: 'Index Hospital',
      hospitalLocation: { type: 'Point', coordinates: HOSPITAL },
    };
    // Mostly open requests, with two stale ones among them
    const docs = [];
    for (let i = 0; i < 40; i += 1) docs.push({ ...base, status: 'pending', createdAt: new Date(nowMs - i * HOUR_MS / 2) });
    docs.push({ ...base, status: 'pending', createdAt: new Date(nowMs - 3 * DAY_MS) });
    docs.push({ ...base, status: 'pending', createdAt: new Date(nowMs - 4 * DAY_MS) });
    // Straight to the collection, so each createdAt is exactly as given
    await Request.collection.insertMany(docs);

    const explained = await Request.find({ status: 'pending', createdAt: { $lte: getRequestOpenCutoff(nowMs) } })
      .select('_id requesterId hospitalName')
      .explain('executionStats');

    const winningPlan = JSON.stringify(explained.queryPlanner.winningPlan);
    expect(winningPlan).toContain('"indexName":"status_1_createdAt_1"');
    expect(winningPlan).not.toContain('COLLSCAN');
    expect(explained.executionStats.nReturned).toBe(2);
    // Only the two stale entries are read, not every pending request
    expect(explained.executionStats.totalKeysExamined).toBeLessThanOrEqual(3);
    expect(explained.executionStats.totalDocsExamined).toBe(2);
  });
});

describe('GET /api/requests/incoming', () => {
  it('leaves out a pending request past 48 h even before any sweep has closed it', async () => {
    const requester = await registerRequester();
    const donor = await registerUser();
    const stale = await createBloodRequest(requester.id, { ageMs: OPEN_MS + SECOND_MS });
    const justInside = await createBloodRequest(requester.id, { ageMs: OPEN_MS - MINUTE_MS });
    // Every sweep write fails, so nothing can close the stale request: only the read's own filter
    // keeps it out. The failure is logged, and the list still loads.
    jest.spyOn(Request, 'updateOne').mockRejectedValue(new Error('forced sweep failure'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await expireStaleRequestsIfDue(Date.now() + 100 * LAZY_SWEEP_MIN_GAP_MS);

    const res = await asUser(donor, 'get', '/api/requests/incoming');

    expect(res.statusCode).toBe(200);
    expect(res.body.incomingRequests.map((req) => req._id)).toEqual([String(justInside._id)]);
    expect((await Request.collection.findOne({ _id: stale._id })).status).toBe('pending');
    expect(console.error).toHaveBeenCalledWith('Closing expired requests failed:', 'forced sweep failure');
  });

  it('runs the sweep at most once per gap, and joins one already running', async () => {
    const requester = await registerRequester();
    // Past every sweep earlier in this file, so the first call below is due
    const startMs = Date.now() + 1000 * LAZY_SWEEP_MIN_GAP_MS;
    const first = await createBloodRequest(requester.id, { ageMs: OPEN_MS + HOUR_MS });

    expect((await expireStaleRequestsIfDue(startMs)).map(String)).toEqual([String(first._id)]);

    const second = await createBloodRequest(requester.id, { ageMs: OPEN_MS + HOUR_MS });
    expect(await expireStaleRequestsIfDue(startMs + LAZY_SWEEP_MIN_GAP_MS - 1)).toEqual([]);
    expect((await Request.findById(second._id)).status).toBe('pending');

    const findSpy = jest.spyOn(Request, 'find');
    const runningSweep = expireStaleRequestsIfDue(startMs + LAZY_SWEEP_MIN_GAP_MS);
    const joiningCall = expireStaleRequestsIfDue(startMs + LAZY_SWEEP_MIN_GAP_MS);
    expect(joiningCall).toBe(runningSweep);
    expect((await runningSweep).map(String)).toEqual([String(second._id)]);
    expect(findSpy).toHaveBeenCalledTimes(1);
  });

  it('answers while a sweep is still running, without waiting for it', async () => {
    const requester = await registerRequester();
    const donor = await registerUser();
    const stale = await createBloodRequest(requester.id, { ageMs: OPEN_MS + HOUR_MS });
    const fresh = await createBloodRequest(requester.id, { ageMs: HOUR_MS });
    // Every sweep write waits until released, so the sweep below stays running
    let releaseSweep;
    const sweepReleased = new Promise((resolve) => {
      releaseSweep = resolve;
    });
    const realUpdateOne = Request.updateOne.bind(Request);
    jest.spyOn(Request, 'updateOne').mockImplementation(async (...args) => {
      await sweepReleased;
      return realUpdateOne(...args);
    });
    // Past every sweep earlier in this file (the test above starts at +1000 gaps), so it is due
    const runningSweep = expireStaleRequestsIfDue(Date.now() + 2000 * LAZY_SWEEP_MIN_GAP_MS);

    let res;
    try {
      res = await Promise.race([
        asUser(donor, 'get', '/api/requests/incoming'),
        delay(2000).then(() => 'still waiting after 2 s'),
      ]);
    } finally {
      releaseSweep();
    }

    expect(res).not.toBe('still waiting after 2 s');
    expect(res.statusCode).toBe(200);
    expect(res.body.incomingRequests.map((req) => req._id)).toEqual([String(fresh._id)]);
    // The sweep the list did not wait for still closes the request
    expect((await runningSweep).map(String)).toEqual([String(stale._id)]);
    expect((await Request.collection.findOne({ _id: stale._id })).closedReason).toBe('expired');
  });
});

describe('accepting or declining a request past 48 h', () => {
  it('refuses an accept just after 48 h (409), changes nothing and notifies no one', async () => {
    const requester = await registerRequester();
    const donor = await registerUser();
    const stale = await createBloodRequest(requester.id, { ageMs: OPEN_MS + SECOND_MS });
    const before = await readRaw(stale._id);
    const socket = spyOnSocket();

    const res = await patchStatus(stale._id, donor, 'accepted');

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ message: 'This request has expired' });
    expect(await readRaw(stale._id)).toBe(before);
    expect(socket.sent()).toEqual([]);
  });

  it('lets a donor accept just before 48 h (200)', async () => {
    const requester = await registerRequester();
    const donor = await registerUser();
    const nearlyStale = await createBloodRequest(requester.id, { ageMs: OPEN_MS - MINUTE_MS });
    const socket = spyOnSocket();

    const res = await patchStatus(nearlyStale._id, donor, 'accepted');

    expect(res.statusCode).toBe(200);
    expect(res.body.request).toMatchObject({ status: 'accepted', matchedDonorId: donor.id });
    expect(socket.statusUpdates()).toEqual([
      { room: requester.id, payload: { requestId: String(nearlyStale._id), status: 'accepted', donorName: donor.name } },
    ]);
    // Accepted requests never expire, however long the donation takes
    expect(await expireStaleRequests({ nowMs: Date.now() + 30 * DAY_MS })).toEqual([]);
    expect((await Request.findById(nearlyStale._id)).status).toBe('accepted');
  });

  it('refuses an accept of a request the sweep has closed (409, not "it has been cancelled")', async () => {
    const requester = await registerRequester();
    const donor = await registerUser();
    const stale = await createBloodRequest(requester.id, { ageMs: OPEN_MS + HOUR_MS });
    await expireStaleRequests();

    const res = await patchStatus(stale._id, donor, 'accepted');

    expect(res.statusCode).toBe(409);
    expect(res.body.message).toBe('This request has expired');
  });

  it.each([
    ['not yet closed', false],
    ['closed by the sweep', true],
  ])('refuses a decline of a request past 48 h, %s (409), and records no decline', async (_label, sweepFirst) => {
    const requester = await registerRequester();
    const donor = await registerUser();
    const stale = await createBloodRequest(requester.id, { ageMs: OPEN_MS + SECOND_MS });
    if (sweepFirst) await expireStaleRequests();
    const before = await readRaw(stale._id);

    const res = await patchStatus(stale._id, donor, 'declined');

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ message: 'This request has expired' });
    expect(await readRaw(stale._id)).toBe(before);
  });

  it('tells a requester who cancels an expired request that it has expired (409)', async () => {
    const requester = await registerRequester();
    const stale = await createBloodRequest(requester.id, { ageMs: OPEN_MS + HOUR_MS });
    await expireStaleRequests();

    const res = await patchStatus(stale._id, requester, 'cancelled');

    expect(res.statusCode).toBe(409);
    expect(res.body.message).toBe('This request has expired');
    expect(await Request.collection.findOne({ _id: stale._id })).toMatchObject({ status: 'cancelled', closedReason: 'expired' });
  });

  it('closes as expired, not as cancelled, a request past 48 h that no sweep has closed yet (409)', async () => {
    const requester = await registerRequester();
    const stale = await createBloodRequest(requester.id, { ageMs: OPEN_MS + SECOND_MS });
    const socket = spyOnSocket();

    const res = await patchStatus(stale._id, requester, 'cancelled');

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ message: 'This request has expired' });
    expect(await Request.collection.findOne({ _id: stale._id })).toMatchObject({
      status: 'cancelled',
      closedReason: 'expired',
      matchedDonorId: null,
    });
    // The requester hears of the expiry once, as from a sweep; a second cancel sends nothing more
    expect(socket.statusUpdates()).toEqual([expiredEventFor(requester, stale)]);
    const again = await patchStatus(stale._id, requester, 'cancelled');
    expect(again.statusCode).toBe(409);
    expect(again.body).toEqual({ message: 'This request has expired' });
    expect(socket.statusUpdates()).toEqual([expiredEventFor(requester, stale)]);
  });

  it('still cancels a request just before 48 h (200), with no closedReason', async () => {
    const requester = await registerRequester();
    const nearlyStale = await createBloodRequest(requester.id, { ageMs: OPEN_MS - MINUTE_MS });
    const socket = spyOnSocket();

    const res = await patchStatus(nearlyStale._id, requester, 'cancelled');

    expect(res.statusCode).toBe(200);
    const stored = await Request.collection.findOne({ _id: nearlyStale._id });
    expect(stored.status).toBe('cancelled');
    expect(stored).not.toHaveProperty('closedReason');
    // No donor holds it, so no one is notified
    expect(socket.sent()).toEqual([]);
  });

  it('still cancels an accepted request, however old (200)', async () => {
    const requester = await registerRequester();
    const donor = await registerUser();
    const old = await createBloodRequest(requester.id, { ageMs: 10 * DAY_MS, status: 'accepted', matchedDonorId: donor.id });
    const socket = spyOnSocket();

    const res = await patchStatus(old._id, requester, 'cancelled');

    expect(res.statusCode).toBe(200);
    const stored = await Request.collection.findOne({ _id: old._id });
    expect(stored.status).toBe('cancelled');
    expect(stored).not.toHaveProperty('closedReason');
    expect(socket.statusUpdates()).toEqual([
      { room: donor.id, payload: { requestId: String(old._id), status: 'cancelled', requesterName: requester.name } },
    ]);
  });
});

describe('an accept racing the sweep', () => {
  // Inside its hours for the accept (real time), past them for a sweep that runs a minute ahead
  const createBoundaryRequest = (requesterId) => createBloodRequest(requesterId, { ageMs: OPEN_MS - 30 * SECOND_MS });
  const sweepAMinuteAhead = () => expireStaleRequests({ nowMs: Date.now() + MINUTE_MS });

  it('the sweep lands first: the accept gets 409 and the requester hears only of the expiry', async () => {
    const requester = await registerRequester();
    const donor = await registerUser();
    const bloodRequest = await createBoundaryRequest(requester.id);
    const realFindOneAndUpdate = Request.findOneAndUpdate.bind(Request);
    let sweptIds = null;
    // Right before the accept's write. Set BEFORE awaiting, so it runs once.
    jest.spyOn(Request, 'findOneAndUpdate').mockImplementation(async (...args) => {
      if (sweptIds === null) {
        sweptIds = [];
        sweptIds = await sweepAMinuteAhead();
      }
      return realFindOneAndUpdate(...args);
    });
    const socket = spyOnSocket();

    const res = await patchStatus(bloodRequest._id, donor, 'accepted');

    expect(sweptIds.map(String)).toEqual([String(bloodRequest._id)]);
    expect(res.statusCode).toBe(409);
    expect(res.body.message).toBe('This request has expired');
    expect(await Request.collection.findOne({ _id: bloodRequest._id })).toMatchObject({
      status: 'cancelled',
      closedReason: 'expired',
      matchedDonorId: null,
    });
    expect(socket.statusUpdates()).toEqual([expiredEventFor(requester, bloodRequest)]);
  });

  it('the accept lands first: the sweep that already listed the request closes nothing', async () => {
    const requester = await registerRequester();
    const donor = await registerUser();
    const bloodRequest = await createBoundaryRequest(requester.id);
    const realUpdateOne = Request.updateOne.bind(Request);
    let acceptRes = null;
    // After the sweep has read its candidates, right before its write. Set BEFORE awaiting.
    jest.spyOn(Request, 'updateOne').mockImplementation(async (...args) => {
      if (acceptRes === null) {
        acceptRes = {};
        acceptRes = await patchStatus(bloodRequest._id, donor, 'accepted');
      }
      return realUpdateOne(...args);
    });
    const socket = spyOnSocket();

    const expiredIds = await sweepAMinuteAhead();

    expect(acceptRes.statusCode).toBe(200);
    expect(expiredIds).toEqual([]);
    const stored = await Request.collection.findOne({ _id: bloodRequest._id });
    expect(stored.status).toBe('accepted');
    expect(String(stored.matchedDonorId)).toBe(donor.id);
    expect(stored).not.toHaveProperty('closedReason');
    expect(socket.statusUpdates()).toEqual([
      { room: requester.id, payload: { requestId: String(bloodRequest._id), status: 'accepted', donorName: donor.name } },
    ]);
  });

  it('sent at the same moment, gives exactly one outcome every time', async () => {
    const requester = await registerRequester();
    const outcomes = [];
    for (let round = 0; round < 6; round += 1) {
      const donor = await registerUser();
      const bloodRequest = await createBoundaryRequest(requester.id);
      const socket = spyOnSocket();

      const [acceptRes, expiredIds] = await Promise.all([
        patchStatus(bloodRequest._id, donor, 'accepted'),
        sweepAMinuteAhead(),
      ]);

      const stored = await Request.collection.findOne({ _id: bloodRequest._id });
      const updates = socket.statusUpdates();
      if (acceptRes.statusCode === 200) {
        expect(expiredIds).toEqual([]);
        expect(stored.status).toBe('accepted');
        expect(stored).not.toHaveProperty('closedReason');
        expect(updates.map(({ payload }) => payload.status)).toEqual(['accepted']);
        outcomes.push('accepted');
      } else {
        expect(acceptRes.statusCode).toBe(409);
        expect(acceptRes.body.message).toBe('This request has expired');
        expect(expiredIds.map(String)).toEqual([String(bloodRequest._id)]);
        expect(stored).toMatchObject({ status: 'cancelled', closedReason: 'expired', matchedDonorId: null });
        expect(updates).toEqual([expiredEventFor(requester, bloodRequest)]);
        outcomes.push('expired');
      }
      socket.to.mockRestore();
    }
    // Which side wins each round depends on timing; both are correct
    expect(outcomes).toHaveLength(6);
  });
});

describe("the requester's own reads", () => {
  it('GET /api/requests/mine closes and shows an expired request, notifying its requester once', async () => {
    const requester = await registerRequester();
    const otherRequester = await registerRequester('Omar Requester');
    const stale = await createBloodRequest(requester.id, { ageMs: OPEN_MS + HOUR_MS });
    const fresh = await createBloodRequest(requester.id, { ageMs: HOUR_MS });
    const someoneElses = await createBloodRequest(otherRequester.id, { ageMs: OPEN_MS + HOUR_MS });
    const socket = spyOnSocket();

    const first = await asUser(requester, 'get', '/api/requests/mine');
    const second = await asUser(requester, 'get', '/api/requests/mine');

    expect(first.statusCode).toBe(200);
    expect(first.body.requests).toEqual([
      expect.objectContaining({ _id: String(fresh._id), status: 'pending' }),
      expect.objectContaining({ _id: String(stale._id), status: 'cancelled', closedReason: 'expired', matchedDonorId: null }),
    ]);
    expect(first.body.requests[0]).not.toHaveProperty('closedReason');
    expect(second.body.requests).toEqual(first.body.requests);
    expect(socket.statusUpdates()).toEqual([expiredEventFor(requester, stale)]);
    // Only the caller's own requests are closed on their read
    expect((await Request.findById(someoneElses._id)).status).toBe('pending');
  });

  it('GET /api/users/history shows an expired request as expired', async () => {
    const requester = await registerRequester();
    const stale = await createBloodRequest(requester.id, { ageMs: OPEN_MS + HOUR_MS });

    const res = await asUser(requester, 'get', '/api/users/history');

    expect(res.statusCode).toBe(200);
    expect(res.body.pastRequests).toEqual([
      expect.objectContaining({ _id: String(stale._id), status: 'cancelled', closedReason: 'expired', matchedDonorId: null }),
    ]);
  });
});

describe('a request reopened by its donor deleting their account', () => {
  // The requester's request, accepted by a donor who then deletes their account
  const reopenAfter = async (ageMs) => {
    const requester = await registerRequester();
    const leaver = await registerUser({ name: 'Leela Leaver' });
    const nearbyDonor = await registerUser({ name: 'Nina Donor', location: ALSO_NEARBY });
    const bloodRequest = await createBloodRequest(requester.id, { ageMs, status: 'accepted', matchedDonorId: leaver.id });
    const socket = spyOnSocket();
    const res = await asUser(leaver, 'delete', '/api/users/me').send({ password: PASSWORD });
    expect(res.statusCode).toBe(200);
    return { requester, nearbyDonor, bloodRequest, socket };
  };

  it('is closed instead of announced once it is past 48 h from when it was created', async () => {
    const { requester, bloodRequest, socket } = await reopenAfter(OPEN_MS + HOUR_MS);

    // The announcement runs after the 200
    await waitUntil(() => socket.expiredUpdates().length > 0);
    await delay(SILENCE_WINDOW_MS);

    expect(socket.newRequestAlerts()).toEqual([]);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
    // Exactly one event, the expiry: no "open to donors again" before it
    expect(socket.statusUpdates()).toEqual([expiredEventFor(requester, bloodRequest)]);
    expect(await Request.collection.findOne({ _id: bloodRequest._id })).toMatchObject({
      status: 'cancelled',
      closedReason: 'expired',
      matchedDonorId: null,
    });
  });

  it('at 47 h is announced again, and still closes 48 h after it was created', async () => {
    const { requester, nearbyDonor, bloodRequest, socket } = await reopenAfter(47 * HOUR_MS);

    await waitUntil(() => socket.newRequestAlerts().length > 0);
    await delay(SILENCE_WINDOW_MS);

    expect(socket.newRequestAlerts().map(({ room }) => room)).toEqual([nearbyDonor.id]);
    // Its requester hears that it is open again, and nothing about expiry
    expect(socket.statusUpdates()).toEqual([
      { room: requester.id, payload: { requestId: String(bloodRequest._id), status: 'pending', reason: 'account_deleted' } },
    ]);
    expect((await Request.findById(bloodRequest._id)).status).toBe('pending');
    expect((await expireStaleRequests({ nowMs: Date.now() + HOUR_MS })).map(String)).toEqual([String(bloodRequest._id)]);
  });
});

describe('donation gap and stats', () => {
  it('an expired request has no donor, so it starts no donation gap and counts as no donation', async () => {
    const requester = await registerRequester();
    const donor = await registerUser();
    const stale = await createBloodRequest(requester.id, { ageMs: OPEN_MS + HOUR_MS });
    await expireStaleRequests();

    const stored = await Request.collection.findOne({ _id: stale._id });
    expect(stored).toMatchObject({ status: 'cancelled', closedReason: 'expired', matchedDonorId: null, fulfilledAt: null });
    expect(await findNextEligibleDonationAt(donor.id, null)).toBeNull();
    expect((await asUser(donor, 'get', '/api/auth/check')).body.user.nextEligibleDonationAt).toBeNull();
    expect((await asUser(donor, 'get', '/api/users/stats')).body.donor).toEqual({ livesSaved: 0, avgRating: null, totalRated: 0 });
    expect((await asUser(requester, 'get', '/api/users/stats')).body.requester).toEqual({ totalCreated: 1, totalFulfilled: 0 });

    // Neither busy nor resting: the donor can still accept another request
    const next = await createBloodRequest(requester.id);
    expect((await patchStatus(next._id, donor, 'accepted')).statusCode).toBe(200);
  });
});

describe('sweep schedule', () => {
  it('sweeps once at startup, then on an unref\'d 10-minute interval that stop() clears', async () => {
    const requester = await registerRequester();
    const stale = await createBloodRequest(requester.id, { ageMs: OPEN_MS + HOUR_MS });
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval');

    const { firstSweep, stop } = startRequestExpirySweeps();
    const callIndex = setIntervalSpy.mock.calls.findIndex(([, delayMs]) => delayMs === SWEEP_INTERVAL_MS);
    const timer = callIndex === -1 ? null : setIntervalSpy.mock.results[callIndex].value;
    // Read before stop(), which is in finally so a failed check can never leave the timer running
    let hadRef;
    try {
      hadRef = timer && timer.hasRef();
      await firstSweep;
    } finally {
      stop();
    }

    expect(SWEEP_INTERVAL_MS).toBe(10 * MINUTE_MS);
    expect(timer).not.toBeNull();
    // Unref'd: it never keeps Node (or Jest) running
    expect(hadRef).toBe(false);
    expect((await firstSweep).map(String)).toEqual([String(stale._id)]);
    expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
  });
});

describe('open hours', () => {
  it('are 48, and the client shows the same number', () => {
    expect(REQUEST_OPEN_HOURS).toBe(48);
    const clientLibPath = path.join(__dirname, '../../client/src/lib/requestExpiry.js');
    const match = fs.readFileSync(clientLibPath, 'utf8').match(/export const REQUEST_OPEN_HOURS = (\d+);/);

    expect(match).not.toBeNull();
    expect(Number(match[1])).toBe(REQUEST_OPEN_HOURS);
  });
});
