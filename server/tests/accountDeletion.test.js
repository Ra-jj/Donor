const request = require('supertest');
const mongoose = require('mongoose');
const webpush = require('web-push');
const { io: ioClient } = require('socket.io-client');
// Mounts the routes on the app that lib/socket's server serves, so HTTP calls and real sockets
// in these tests reach the same server
require('../index');
const { io, server } = require('../lib/socket');
const Message = require('../models/message.model');
const Request = require('../models/request.model');
const User = require('../models/user.model');
const { computeNextEligibleDonationAt, describeDonationGap } = require('../utils/donationGap');
const { connectDB, closeDB, clearDB } = require('./db');
const { REGISTRATION_CONSENT } = require('./registration');

// Coordinates are [longitude, latitude]
const HOSPITAL = [77.5946, 12.9716]; // Bangalore
const NEARBY = [77.6, 12.975]; // ~0.7 km from HOSPITAL
const ALSO_NEARBY = [77.58, 12.96]; // ~2 km from HOSPITAL

const FAR_AWAY = [77.8246, 12.9716]; // ~25 km from HOSPITAL, outside the 15 km radius

const PASSWORD = 'password123';
const DAY_MS = 24 * 60 * 60 * 1000;
// Long enough for an event already emitted to arrive over loopback
const SILENCE_WINDOW_MS = 300;
const PUSH_SUBSCRIPTION = { endpoint: 'https://fcm.googleapis.com/fcm/send/donor', keys: { p256dh: 'a', auth: 'b' } };

let baseUrl;
let openClients = [];
let userCount = 0;

beforeAll(async () => {
  await connectDB();
  // Mongoose builds indexes in the background; wait so one_active_donation_per_donor exists
  await Request.init();
  // The real Socket.io server from lib/socket.js, bound to 127.0.0.1 so no other local app on
  // the same ephemeral port can answer
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  // protectRoute and the socket middleware log every rejection; keep the output clean but let
  // tests read the messages
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  // A request that goes back to pending is announced to nearby donors again, push included.
  // Without this mock a well-formed subscription would be sent to the real push service.
  jest.spyOn(webpush, 'sendNotification').mockResolvedValue({ statusCode: 201 });
});

afterEach(async () => {
  openClients.forEach((client) => client.disconnect());
  openClients = [];
  jest.restoreAllMocks();
  await clearDB();
});

afterAll(async () => {
  // io.close() disconnects every socket (clearing their expiry timers) and closes the server
  await new Promise((resolve) => io.close(() => resolve()));
  await closeDB();
});

// Register through the API and reuse the cookie register sets (login is rate limited)
const registerUser = async ({ bloodGroup = 'O-', location = NEARBY, name } = {}) => {
  userCount += 1;
  const email = `erase.user${userCount}@example.com`;
  const res = await request(server)
    .post('/api/auth/register')
    .send({ name: name || `Erase User ${userCount}`, email, password: PASSWORD, bloodGroup, location, ...REGISTRATION_CONSENT });
  expect(res.statusCode).toBe(201);
  const setCookie = res.headers['set-cookie'];
  return {
    id: res.body.user._id,
    name: res.body.user.name,
    email,
    cookie: setCookie,
    // Just "jwt=<token>", the form a browser sends in the Cookie header
    socketCookie: setCookie.find((value) => value.startsWith('jwt=')).split(';')[0],
  };
};

// Created directly on the model so each test controls status, donor and dates
const createBloodRequest = (requesterId, overrides = {}) =>
  Request.create({
    requesterId,
    bloodGroup: 'B+',
    unitsNeeded: 2,
    hospitalName: 'Erase Test Hospital',
    hospitalLocation: { type: 'Point', coordinates: HOSPITAL },
    urgency: 'high',
    ...overrides,
  });

const addMessage = (senderId, receiverId, requestId, text) =>
  Message.create({ senderId, receiverId, requestId, text });

const asUser = (user, method, path) => request(server)[method](path).set('Cookie', user.cookie);

const deleteAccount = (user, body = { password: PASSWORD }) =>
  asUser(user, 'delete', '/api/users/me').send(body);

const patchStatus = (requestId, user, status) =>
  asUser(user, 'patch', `/api/requests/${requestId}/status`).send({ status });

const jwtCookieOf = (res) => (res.headers['set-cookie'] || []).find((cookie) => cookie.startsWith('jwt='));

// Replaces io.to() so a test can see which rooms were notified, with which event and payload
const spyOnSocket = () => {
  const emit = jest.fn();
  const to = jest.spyOn(io, 'to').mockReturnValue({ emit });
  const sent = () => to.mock.calls.map(([room], index) => ({ room, event: emit.mock.calls[index][0], payload: emit.mock.calls[index][1] }));
  return {
    notifications: () =>
      to.mock.calls.map(([room], index) => {
        const [event, payload] = emit.mock.calls[index];
        return { room, event, payload: { ...payload, requestId: String(payload.requestId) } };
      }),
    // The newBloodRequest alerts, whose payload is the request itself (_id, no requestId)
    newRequestAlerts: () =>
      sent()
        .filter(({ event }) => event === 'newBloodRequest')
        .map(({ room, payload }) => ({ room, payload: { ...payload, _id: String(payload._id) } })),
    statusUpdates: () => sent().filter(({ event }) => event === 'requestStatusUpdate'),
  };
};

// Every stored document, raw (declinedBy included), as one JSON string. ObjectIds and Dates
// serialise to their values, so two snapshots compare by value.
const readDatabase = async () =>
  JSON.stringify({
    users: await User.collection.find({}).sort({ _id: 1 }).toArray(),
    requests: await Request.collection.find({}).sort({ _id: 1 }).toArray(),
    messages: await Message.collection.find({}).sort({ _id: 1 }).toArray(),
  });

// forceNew: each client gets its own connection. reconnection: false so a failed test can never
// leave a client retrying.
const connectClient = (cookieHeader) => {
  const client = ioClient(baseUrl, { forceNew: true, reconnection: false, extraHeaders: { Cookie: cookieHeader } });
  openClients.push(client);
  return client;
};

const waitForConnect = (client) =>
  new Promise((resolve, reject) => {
    client.once('connect', resolve);
    client.once('connect_error', reject);
  });

const waitForEvent = (client, eventName, timeoutMs = 3000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${eventName} within ${timeoutMs} ms`)), timeoutMs);
    client.once(eventName, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Polls until check() returns true. The alerts for a reopened request go out after the 200.
const waitUntil = async (check, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms`);
    await delay(10);
  }
};

// Runs action() right after the NEXT call of model[method] has read the database, before its
// caller gets the result: the moment a deletion from another browser window can commit. A
// Mongoose query runs through exec() when awaited, so the wrapper sits there; the query itself,
// and any chained .select(), is the real one.
const runOnceAfterNextRead = (model, method, action) => {
  const realMethod = model[method].bind(model);
  jest.spyOn(model, method).mockImplementationOnce((...args) => {
    const query = realMethod(...args);
    const realExec = query.exec.bind(query);
    query.exec = async (...execArgs) => {
      const result = await realExec(...execArgs);
      await action();
      return result;
    };
    return query;
  });
};

// The deleting user (Leela) in every role an account can have, next to requests and messages
// that belong to other people and must not change
const buildScenario = async () => {
  const leaver = await registerUser({ name: 'Leela Leaver', bloodGroup: 'O-', location: HOSPITAL });
  const anil = await registerUser({ name: 'Anil Donor' });
  const bina = await registerUser({ name: 'Bina Donor' });
  const dev = await registerUser({ name: 'Dev Donor' });
  const ravi = await registerUser({ name: 'Ravi Requester', bloodGroup: 'A+', location: HOSPITAL });
  const sita = await registerUser({ name: 'Sita Requester', bloodGroup: 'A+', location: HOSPITAL });

  // a. Requests Leela created
  const leaverPending = await createBloodRequest(leaver.id, { declinedBy: [dev.id] });
  const leaverAccepted = await createBloodRequest(leaver.id, { status: 'accepted', matchedDonorId: anil.id });
  const leaverFulfilledAt = new Date(Date.now() - 10 * DAY_MS);
  const leaverFulfilled = await createBloodRequest(leaver.id, {
    status: 'fulfilled',
    matchedDonorId: bina.id,
    fulfilledAt: leaverFulfilledAt,
    rating: 4,
    ratingNote: 'Bina came within the hour',
  });
  const leaverCancelled = await createBloodRequest(leaver.id, { status: 'cancelled' });

  // b. Requests Leela was the donor on
  const raviAccepted = await createBloodRequest(ravi.id, { status: 'accepted', matchedDonorId: leaver.id });
  const sitaFulfilledAt = new Date(Date.now() - 200 * DAY_MS);
  const sitaFulfilled = await createBloodRequest(sita.id, {
    status: 'fulfilled',
    matchedDonorId: leaver.id,
    fulfilledAt: sitaFulfilledAt,
    rating: 5,
    ratingNote: 'Leela was so kind',
  });
  const raviCancelled = await createBloodRequest(ravi.id, { status: 'cancelled', matchedDonorId: leaver.id });

  // c. A request Leela declined
  const raviPending = await createBloodRequest(ravi.id, { declinedBy: [leaver.id, dev.id] });

  // Nothing to do with Leela
  const unrelatedAccepted = await createBloodRequest(sita.id, { status: 'accepted', matchedDonorId: dev.id });

  // d. Messages
  await addMessage(leaver.id, anil.id, leaverAccepted._id, 'Leela to Anil');
  await addMessage(anil.id, leaver.id, leaverAccepted._id, 'Anil to Leela');
  await addMessage(ravi.id, leaver.id, raviAccepted._id, 'Ravi to Leela');
  await addMessage(leaver.id, ravi.id, raviAccepted._id, 'Leela to Ravi');
  // Leela is neither sender nor receiver: removed only because its request is removed
  await addMessage(anil.id, dev.id, leaverCancelled._id, 'Left on a cancelled request of Leela');
  await addMessage(sita.id, dev.id, unrelatedAccepted._id, 'Sita to Dev');
  await addMessage(dev.id, sita.id, unrelatedAccepted._id, 'Dev to Sita');

  // Erased with the user document
  await User.findByIdAndUpdate(leaver.id, {
    pushSubscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/leela', keys: { p256dh: 'a', auth: 'b' } },
    profilePic: 'https://example.com/leela.png',
  });

  return {
    leaver, anil, bina, dev, ravi, sita,
    leaverPending, leaverAccepted, leaverFulfilled, leaverFulfilledAt, leaverCancelled,
    raviAccepted, sitaFulfilled, sitaFulfilledAt, raviCancelled,
    raviPending, unrelatedAccepted,
  };
};

describe('DELETE /api/users/me: refusals change nothing', () => {
  it('refuses a wrong password (403): no write, no cookie change, no event', async () => {
    const scenario = await buildScenario();
    const before = await readDatabase();
    const socket = spyOnSocket();
    const disconnectSpy = jest.spyOn(io, 'in');

    const res = await deleteAccount(scenario.leaver, { password: 'not-my-password' });

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ message: 'Incorrect password. Your account was not deleted.' });
    expect(jwtCookieOf(res)).toBeUndefined();
    expect(await readDatabase()).toBe(before);
    expect(socket.notifications()).toEqual([]);
    expect(disconnectSpy).not.toHaveBeenCalled();
    // The session still works
    expect((await asUser(scenario.leaver, 'get', '/api/auth/check')).statusCode).toBe(200);
  });

  it.each([
    ['no password', {}],
    ['an empty password', { password: '' }],
    ['a password that is not a string', { password: 12345678 }],
    ['a null password', { password: null }],
  ])('rejects %s (400) and changes nothing', async (_label, body) => {
    const user = await registerUser();
    const before = await readDatabase();

    const res = await deleteAccount(user, body);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: 'Validation failed', errors: { password: 'Password is required' } });
    expect(await readDatabase()).toBe(before);
  });

  it('rejects a request with no body at all (400)', async () => {
    const user = await registerUser();

    const res = await asUser(user, 'delete', '/api/users/me');

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toBe('Validation failed');
    expect(await User.exists({ _id: user.id })).not.toBeNull();
  });

  it('requires a login (401)', async () => {
    const user = await registerUser();

    const res = await request(server).delete('/api/users/me').send({ password: PASSWORD });

    expect(res.statusCode).toBe(401);
    expect(res.body.message).toBe('Unauthorized - No Token Provided');
    expect(await User.exists({ _id: user.id })).not.toBeNull();
  });

  it('allows five attempts per user in 15 minutes, then refuses even the right password (429)', async () => {
    const user = await registerUser();
    const otherUser = await registerUser();

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect((await deleteAccount(user, { password: 'wrong-password' })).statusCode).toBe(403);
    }
    const blocked = await deleteAccount(user);

    expect(blocked.statusCode).toBe(429);
    expect(blocked.body.message).toBe('Too many attempts to delete your account. Please try again in 15 minutes.');
    expect(await User.exists({ _id: user.id })).not.toBeNull();
    // Counted per user, not per IP: another account from the same address is not blocked
    expect((await deleteAccount(otherUser)).statusCode).toBe(200);
  });

  it.each([
    ['the last step (deleting the user)', () => jest.spyOn(User, 'deleteOne')],
    ['a middle step (deleting the messages)', () => jest.spyOn(Message, 'deleteMany')],
  ])('rolls back every write when %s fails (500), and tells no one', async (_label, spyOnStep) => {
    const scenario = await buildScenario();
    const before = await readDatabase();
    spyOnStep().mockRejectedValue(new Error('forced failure for the rollback test'));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const socket = spyOnSocket();
    const disconnectSpy = jest.spyOn(io, 'in');

    const res = await deleteAccount(scenario.leaver);

    expect(res.statusCode).toBe(500);
    expect(consoleError).toHaveBeenCalledWith('Error in deleteAccount:', 'forced failure for the rollback test');
    expect(jwtCookieOf(res)).toBeUndefined();
    expect(await readDatabase()).toBe(before);
    expect(socket.notifications()).toEqual([]);
    expect(disconnectSpy).not.toHaveBeenCalled();
    expect((await asUser(scenario.leaver, 'get', '/api/auth/check')).statusCode).toBe(200);
  });
});

describe('DELETE /api/users/me: a successful deletion', () => {
  it('applies every rule in the database: (a) own requests, (b) donations, (c) declines, (d) messages, (e) the user', async () => {
    const scenario = await buildScenario();
    const { leaver } = scenario;
    const leaverObjectId = new mongoose.Types.ObjectId(leaver.id);
    const otherUsersBefore = JSON.stringify(await User.collection.find({ _id: { $ne: leaverObjectId } }).sort({ _id: 1 }).toArray());
    const unrelatedBefore = JSON.stringify(await Request.collection.findOne({ _id: scenario.unrelatedAccepted._id }));

    const res = await deleteAccount(leaver);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ message: 'Your account has been deleted' });

    // e. The user document, with its push subscription and profile picture
    expect(await User.collection.findOne({ email: leaver.email })).toBeNull();
    expect(await User.countDocuments()).toBe(5);

    // a. Own requests: fulfilled kept and anonymised, everything else deleted
    for (const removed of [scenario.leaverPending, scenario.leaverAccepted, scenario.leaverCancelled]) {
      expect(await Request.exists({ _id: removed._id })).toBeNull();
    }
    const anonymised = await Request.collection.findOne({ _id: scenario.leaverFulfilled._id });
    expect(anonymised).toMatchObject({
      status: 'fulfilled',
      requesterId: null,
      ratingNote: '',
      rating: 4,
      hospitalName: 'Erase Test Hospital',
      bloodGroup: 'B+',
      unitsNeeded: 2,
    });
    expect(String(anonymised.matchedDonorId)).toBe(scenario.bina.id);
    expect(anonymised.fulfilledAt.toISOString()).toBe(scenario.leaverFulfilledAt.toISOString());

    // b. Requests Leela was the donor on
    const reopened = await Request.collection.findOne({ _id: scenario.raviAccepted._id });
    expect(reopened).toMatchObject({ status: 'pending', matchedDonorId: null });
    expect(String(reopened.requesterId)).toBe(scenario.ravi.id);

    const donation = await Request.collection.findOne({ _id: scenario.sitaFulfilled._id });
    expect(donation).toMatchObject({ status: 'fulfilled', matchedDonorId: null, ratingNote: '', rating: 5 });
    expect(String(donation.requesterId)).toBe(scenario.sita.id);
    expect(donation.fulfilledAt.toISOString()).toBe(scenario.sitaFulfilledAt.toISOString());

    const cancelled = await Request.collection.findOne({ _id: scenario.raviCancelled._id });
    expect(cancelled).toMatchObject({ status: 'cancelled', matchedDonorId: null });
    expect(String(cancelled.requesterId)).toBe(scenario.ravi.id);

    // c. Declines
    const declined = await Request.collection.findOne({ _id: scenario.raviPending._id });
    expect(declined.declinedBy.map(String)).toEqual([scenario.dev.id]);
    expect(declined.status).toBe('pending');

    // d. Messages: only the conversation Leela was never part of is left
    const remainingMessages = await Message.find().sort({ createdAt: 1 }).lean();
    expect(remainingMessages.map((message) => message.text)).toEqual(['Sita to Dev', 'Dev to Sita']);

    // Nothing stored anywhere still holds Leela's id, and other people's data is unchanged
    expect(await readDatabase()).not.toContain(leaver.id);
    expect(JSON.stringify(await User.collection.find({}).sort({ _id: 1 }).toArray())).toBe(otherUsersBefore);
    expect(JSON.stringify(await Request.collection.findOne({ _id: scenario.unrelatedAccepted._id }))).toBe(unrelatedBefore);
  });

  it('clears the jwt cookie exactly as logout does', async () => {
    const user = await registerUser();

    const res = await deleteAccount(user);
    const logoutRes = await request(server).post('/api/auth/logout');

    expect(res.statusCode).toBe(200);
    const clearedCookie = jwtCookieOf(res);
    expect(clearedCookie).toBe(jwtCookieOf(logoutRes));
    expect(clearedCookie).toMatch(/^jwt=;/);
    expect(clearedCookie).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    expect(clearedCookie).toContain('Path=/');
    expect(clearedCookie).toContain('HttpOnly');
    expect(clearedCookie).toContain('SameSite=Strict');
  });

  it('leaves the old token useless: 401 on every protected route and on socket auth', async () => {
    const user = await registerUser();
    expect((await deleteAccount(user)).statusCode).toBe(200);

    for (const path of ['/api/auth/check', '/api/users/history', '/api/users/stats', '/api/requests/mine', '/api/requests/incoming']) {
      const res = await asUser(user, 'get', path);
      expect({ path, status: res.statusCode, message: res.body.message })
        .toEqual({ path, status: 401, message: 'Unauthorized - User not found' });
    }
    const secondDelete = await deleteAccount(user);
    expect(secondDelete.statusCode).toBe(401);
    expect(secondDelete.body.message).toBe('Unauthorized - User not found');

    const client = connectClient(user.socketCookie);
    await expect(waitForConnect(client)).rejects.toThrow('Unauthorized');
    expect(client.active).toBe(false);
    expect(console.warn).toHaveBeenCalledWith("socket auth rejected: no user exists for the token's userId");
  });

  it('tells the donor of a deleted accepted request it was cancelled, and the requester of a released request it is pending again', async () => {
    const scenario = await buildScenario();
    const socket = spyOnSocket();

    const res = await deleteAccount(scenario.leaver);

    expect(res.statusCode).toBe(200);
    // Nobody else: pending, cancelled and fulfilled requests changed without anyone waiting on them.
    // A reason and no name: the deleted account's name is not passed on.
    expect(socket.statusUpdates().map(({ room, payload }) => ({ room, payload: { ...payload, requestId: String(payload.requestId) } }))).toEqual([
      {
        room: scenario.anil.id,
        payload: { requestId: String(scenario.leaverAccepted._id), status: 'cancelled', reason: 'account_deleted' },
      },
      {
        room: scenario.ravi.id,
        payload: { requestId: String(scenario.raviAccepted._id), status: 'pending', reason: 'account_deleted' },
      },
    ]);
    expect(JSON.stringify(socket.statusUpdates())).not.toContain('Leela');

    // The reopened request is then announced to nearby donors again. Only Anil can take it: his
    // accepted request was just deleted. Bina is resting after her donation, Dev is busy, Ravi is
    // its requester, and Sita and Leela are gone or incompatible.
    await waitUntil(() => socket.newRequestAlerts().length > 0);
    await delay(SILENCE_WINDOW_MS);
    expect(socket.newRequestAlerts().map(({ room, payload }) => ({ room, requestId: payload._id }))).toEqual([
      { room: scenario.anil.id, requestId: String(scenario.raviAccepted._id) },
    ]);
    expect(socket.notifications()).toHaveLength(3);
  });

  it("disconnects every live socket of the deleted user and only theirs, and the other side's event arrives", async () => {
    const leaver = await registerUser({ name: 'Leela Leaver', location: HOSPITAL });
    const anil = await registerUser({ name: 'Anil Donor' });
    const leaverAccepted = await createBloodRequest(leaver.id, { status: 'accepted', matchedDonorId: anil.id });
    const leaverTab = connectClient(leaver.socketCookie);
    const leaverPhone = connectClient(leaver.socketCookie);
    const anilClient = connectClient(anil.socketCookie);
    await Promise.all([leaverTab, leaverPhone, anilClient].map(waitForConnect));
    const engineClientsBefore = io.engine.clientsCount;

    const leaverDisconnects = [leaverTab, leaverPhone].map((client) => waitForEvent(client, 'disconnect'));
    const cancelledForAnil = waitForEvent(anilClient, 'requestStatusUpdate');
    expect((await deleteAccount(leaver)).statusCode).toBe(200);

    // Server-initiated, so socket.io-client does not reconnect on its own
    expect(await Promise.all(leaverDisconnects)).toEqual(['io server disconnect', 'io server disconnect']);
    expect(leaverTab.active).toBe(false);
    expect(leaverPhone.active).toBe(false);
    expect(await cancelledForAnil).toEqual({
      requestId: String(leaverAccepted._id),
      status: 'cancelled',
      reason: 'account_deleted',
    });
    await delay(SILENCE_WINDOW_MS);
    expect(anilClient.connected).toBe(true);
    expect(await io.in(leaver.id).fetchSockets()).toEqual([]);
    // Each of the leaver's clients also closed its connection underneath, so none is left open
    expect([leaverTab.io.engine.readyState, leaverPhone.io.engine.readyState]).toEqual(['closed', 'closed']);
    expect(io.engine.clientsCount).toBe(engineClientsBefore - 2);
  });

  it('lets the same email register again, as a new account that inherits nothing', async () => {
    const scenario = await buildScenario();
    expect((await deleteAccount(scenario.leaver)).statusCode).toBe(200);

    const res = await request(server).post('/api/auth/register').send({
      name: 'Leela Again',
      email: scenario.leaver.email,
      password: 'a-new-password',
      bloodGroup: 'O-',
      location: HOSPITAL,
      ...REGISTRATION_CONSENT,
    });

    expect(res.statusCode).toBe(201);
    expect(res.body.user._id).not.toBe(scenario.leaver.id);
    expect(res.body.user.nextEligibleDonationAt).toBeNull();
    const newAccount = { cookie: res.headers['set-cookie'] };
    expect((await asUser(newAccount, 'get', '/api/users/history')).body).toEqual({ pastRequests: [], pastDonations: [] });
    expect((await asUser(newAccount, 'get', '/api/users/stats')).body).toEqual({
      donor: { livesSaved: 0, avgRating: null, totalRated: 0 },
      requester: { totalCreated: 0, totalFulfilled: 0 },
    });
    expect((await asUser(newAccount, 'get', '/api/requests/mine')).body.requests).toEqual([]);
  });
});

describe('the other person after a deletion', () => {
  // Accepted and fulfilled through the API, so fulfilledAt is set the way production sets it
  const completeDonation = async (requester, donor) => {
    const bloodRequest = await createBloodRequest(requester.id);
    expect((await patchStatus(bloodRequest._id, donor, 'accepted')).statusCode).toBe(200);
    expect((await asUser(requester, 'patch', `/api/requests/${bloodRequest._id}/fulfill`)).statusCode).toBe(200);
    return bloodRequest;
  };

  it("keeps the donor's history, lives saved, rating and 120-day gap when the requester deletes", async () => {
    const requester = await registerUser({ name: 'Rita Requester', bloodGroup: 'A+', location: HOSPITAL });
    const donor = await registerUser({ name: 'Dana Donor' });
    const nextRequester = await registerUser({ name: 'Omar Requester', bloodGroup: 'A+', location: HOSPITAL });
    const freeDonor = await registerUser({ name: 'Farah Donor', location: ALSO_NEARBY });
    const bloodRequest = await completeDonation(requester, donor);
    const rateRes = await asUser(requester, 'post', `/api/requests/${bloodRequest._id}/rate`)
      .send({ rating: 4, ratingNote: 'Dana was wonderful' });
    expect(rateRes.statusCode).toBe(200);
    const { fulfilledAt } = await Request.findById(bloodRequest._id);
    const expectedNextEligible = computeNextEligibleDonationAt(fulfilledAt).toISOString();

    expect((await deleteAccount(requester)).statusCode).toBe(200);

    const history = await asUser(donor, 'get', '/api/users/history');
    expect(history.statusCode).toBe(200);
    expect(history.body.pastDonations).toHaveLength(1);
    expect(history.body.pastDonations[0]).toMatchObject({
      _id: String(bloodRequest._id),
      requesterId: null,
      status: 'fulfilled',
      rating: 4,
      ratingNote: '',
      hospitalName: 'Erase Test Hospital',
      fulfilledAt: fulfilledAt.toISOString(),
    });

    const stats = await asUser(donor, 'get', '/api/users/stats');
    expect(stats.body.donor).toEqual({ livesSaved: 1, avgRating: 4, totalRated: 1 });

    expect((await asUser(donor, 'get', '/api/auth/check')).body.user.nextEligibleDonationAt).toBe(expectedNextEligible);
    const incoming = await asUser(donor, 'get', '/api/requests/incoming');
    expect(incoming.statusCode).toBe(200);
    expect(incoming.body.nextEligibleDonationAt).toBe(expectedNextEligible);
    expect(incoming.body.incomingRequests).toEqual([
      expect.objectContaining({ _id: String(bloodRequest._id), status: 'fulfilled', requesterId: null }),
    ]);

    // Still inside the gap: left out of a new request's alerts, and Accept is refused
    const socket = spyOnSocket();
    const created = await asUser(nextRequester, 'post', '/api/requests')
      .send({ bloodGroup: 'B+', unitsNeeded: 1, hospitalName: 'Next Hospital', hospitalLocation: HOSPITAL });
    expect(created.statusCode).toBe(201);
    const notifiedRooms = socket.notifications()
      .filter((notification) => notification.event === 'newBloodRequest')
      .map((notification) => notification.room);
    expect(notifiedRooms).toEqual([freeDonor.id]);

    const acceptRes = await patchStatus(created.body.request._id, donor, 'accepted');
    expect(acceptRes.statusCode).toBe(403);
    expect(acceptRes.body.message).toBe(describeDonationGap(new Date(expectedNextEligible)));
  });

  it('answers every route that reads the anonymised request with its normal refusal, never a 500', async () => {
    const requester = await registerUser({ name: 'Rita Requester', bloodGroup: 'A+', location: HOSPITAL });
    const donor = await registerUser({ name: 'Dana Donor' });
    const stranger = await registerUser({ name: 'Sam Stranger', location: ALSO_NEARBY });
    const bloodRequest = await completeDonation(requester, donor);
    expect((await deleteAccount(requester)).statusCode).toBe(200);
    const id = bloodRequest._id;

    // Sent one at a time; all compared at once, so a regression shows every route it breaks
    const statusByRoute = {};
    const sendInTurn = async (label, call) => {
      statusByRoute[label] = (await call).statusCode;
    };
    await sendInTurn('GET messages', asUser(donor, 'get', `/api/messages/${id}`));
    await sendInTurn('send message', asUser(donor, 'post', `/api/messages/send/${id}`).send({ text: 'Hello' }));
    await sendInTurn('rate', asUser(donor, 'post', `/api/requests/${id}/rate`).send({ rating: 5 }));
    await sendInTurn('accept', patchStatus(id, stranger, 'accepted'));
    await sendInTurn('decline', patchStatus(id, stranger, 'declined'));
    await sendInTurn('cancel', patchStatus(id, donor, 'cancelled'));
    await sendInTurn('fulfil', asUser(donor, 'patch', `/api/requests/${id}/fulfill`));

    expect(statusByRoute).toEqual({
      'GET messages': 403,
      'send message': 403,
      rate: 403,
      accept: 409,
      decline: 409,
      cancel: 403,
      fulfil: 403,
    });
    const stored = await Request.findById(id);
    expect(stored.status).toBe('fulfilled');
    expect(stored.rating).toBeNull();
  });

  it("keeps the requester's history and stats when the donor deletes, and refuses a rating (409)", async () => {
    const requester = await registerUser({ name: 'Rita Requester', bloodGroup: 'A+', location: HOSPITAL });
    const donor = await registerUser({ name: 'Dana Donor' });
    const bloodRequest = await completeDonation(requester, donor);

    expect((await deleteAccount(donor)).statusCode).toBe(200);

    const history = await asUser(requester, 'get', '/api/users/history');
    expect(history.statusCode).toBe(200);
    expect(history.body.pastRequests).toEqual([
      expect.objectContaining({ _id: String(bloodRequest._id), status: 'fulfilled', matchedDonorId: null }),
    ]);
    expect((await asUser(requester, 'get', '/api/users/stats')).body.requester).toEqual({ totalCreated: 1, totalFulfilled: 1 });
    const mine = await asUser(requester, 'get', '/api/requests/mine');
    expect(mine.body.requests).toEqual([expect.objectContaining({ status: 'fulfilled', matchedDonorId: null })]);

    const rateRes = await asUser(requester, 'post', `/api/requests/${bloodRequest._id}/rate`)
      .send({ rating: 5, ratingNote: 'Thank you' });
    expect(rateRes.statusCode).toBe(409);
    expect(rateRes.body.message).toBe('The donor has deleted their account, so this donation can no longer be rated');
    const stored = await Request.findById(bloodRequest._id);
    expect(stored.rating).toBeNull();
    expect(stored.ratingNote).toBe('');
    expect((await asUser(requester, 'get', `/api/messages/${bloodRequest._id}`)).statusCode).toBe(403);
  });

  it('gives a requester whose donor deletes the request back as pending, for another donor to accept', async () => {
    const requester = await registerUser({ name: 'Rita Requester', bloodGroup: 'A+', location: HOSPITAL });
    const donor = await registerUser({ name: 'Dana Donor' });
    const nextDonor = await registerUser({ name: 'Nina Donor', location: ALSO_NEARBY });
    const bloodRequest = await createBloodRequest(requester.id);
    expect((await patchStatus(bloodRequest._id, donor, 'accepted')).statusCode).toBe(200);

    expect((await deleteAccount(donor)).statusCode).toBe(200);

    const mine = await asUser(requester, 'get', '/api/requests/mine');
    expect(mine.body.requests).toEqual([expect.objectContaining({ status: 'pending', matchedDonorId: null })]);
    const nextDonorIncoming = await asUser(nextDonor, 'get', '/api/requests/incoming');
    expect(nextDonorIncoming.body.incomingRequests.map((incomingRequest) => incomingRequest._id)).toEqual([String(bloodRequest._id)]);
    const acceptRes = await patchStatus(bloodRequest._id, nextDonor, 'accepted');
    expect(acceptRes.statusCode).toBe(200);
    expect(acceptRes.body.request.matchedDonorId).toBe(nextDonor.id);
  });

  it('frees the donor of an accepted request whose requester deletes, so they can accept another', async () => {
    const requester = await registerUser({ name: 'Rita Requester', bloodGroup: 'A+', location: HOSPITAL });
    const donor = await registerUser({ name: 'Dana Donor' });
    const nextRequester = await registerUser({ name: 'Omar Requester', bloodGroup: 'A+', location: HOSPITAL });
    const heldRequest = await createBloodRequest(requester.id);
    expect((await patchStatus(heldRequest._id, donor, 'accepted')).statusCode).toBe(200);
    expect((await asUser(donor, 'get', '/api/requests/incoming')).body.hasActiveDonation).toBe(true);

    expect((await deleteAccount(requester)).statusCode).toBe(200);

    const incoming = await asUser(donor, 'get', '/api/requests/incoming');
    expect(incoming.body.hasActiveDonation).toBe(false);
    expect(incoming.body.incomingRequests).toEqual([]);
    const nextRequest = await createBloodRequest(nextRequester.id);
    expect((await patchStatus(nextRequest._id, donor, 'accepted')).statusCode).toBe(200);
  });
});

describe('DELETE /api/users/me: the losing side of a race between two browser windows', () => {
  it('clears the cookie when the account is deleted between the session check and the password check (401)', async () => {
    const user = await registerUser();
    let otherWindowRes;
    // The other window's whole deletion lands right after this request's protectRoute found the user
    runOnceAfterNextRead(User, 'findById', async () => {
      otherWindowRes = await deleteAccount(user);
    });

    const res = await deleteAccount(user);
    const logoutRes = await request(server).post('/api/auth/logout');

    expect(otherWindowRes.statusCode).toBe(200);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ message: 'Unauthorized - User not found' });
    expect(jwtCookieOf(res)).toBe(jwtCookieOf(logoutRes));
    expect(jwtCookieOf(res)).toMatch(/^jwt=;/);
  });
});

describe('writes by the deleted user that land after the deletion', () => {
  // Each handler has already passed protectRoute (and its own reads) when the whole deletion,
  // clean-up included, commits. Only the handler's own check after its write can catch these.

  it('createRequest removes a request saved after its requester was deleted (401), and alerts no donor', async () => {
    const leaver = await registerUser({ name: 'Leela Leaver', bloodGroup: 'A+', location: HOSPITAL });
    const nina = await registerUser({ name: 'Nina Donor', location: ALSO_NEARBY });
    await User.findByIdAndUpdate(nina.id, { pushSubscription: PUSH_SUBSCRIPTION });
    let deletionRes;
    runOnceAfterNextRead(User, 'findById', async () => {
      deletionRes = await deleteAccount(leaver);
    });
    const socket = spyOnSocket();

    const res = await asUser(leaver, 'post', '/api/requests')
      .send({ bloodGroup: 'B+', unitsNeeded: 1, hospitalName: 'Race Hospital', hospitalLocation: HOSPITAL });

    expect(deletionRes.statusCode).toBe(200);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ message: 'Unauthorized - User not found' });
    expect(await Request.countDocuments()).toBe(0);
    expect(await readDatabase()).not.toContain(leaver.id);
    await delay(SILENCE_WINDOW_MS);
    expect(socket.notifications()).toEqual([]);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  it('acceptRequest puts back to pending an accept written after its donor was deleted (401), and tells the requester nothing', async () => {
    const requester = await registerUser({ name: 'Rita Requester', bloodGroup: 'A+', location: HOSPITAL });
    const leaver = await registerUser({ name: 'Leela Leaver' });
    const bloodRequest = await createBloodRequest(requester.id);
    let deletionRes;
    runOnceAfterNextRead(User, 'findById', async () => {
      deletionRes = await deleteAccount(leaver);
    });
    const socket = spyOnSocket();

    const res = await patchStatus(bloodRequest._id, leaver, 'accepted');

    expect(deletionRes.statusCode).toBe(200);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ message: 'Unauthorized - User not found' });
    expect(await Request.collection.findOne({ _id: bloodRequest._id })).toMatchObject({ status: 'pending', matchedDonorId: null });
    expect(await readDatabase()).not.toContain(leaver.id);
    await delay(SILENCE_WINDOW_MS);
    expect(socket.notifications()).toEqual([]);
    // The same request can still be accepted by another donor
    const nextDonor = await registerUser({ name: 'Nina Donor', location: ALSO_NEARBY });
    expect((await patchStatus(bloodRequest._id, nextDonor, 'accepted')).statusCode).toBe(200);
  });

  it('declineRequest removes a decline written after its donor was deleted (401), and keeps the others', async () => {
    const requester = await registerUser({ name: 'Rita Requester', bloodGroup: 'A+', location: HOSPITAL });
    const leaver = await registerUser({ name: 'Leela Leaver' });
    const declan = await registerUser({ name: 'Declan Declined' });
    const bloodRequest = await createBloodRequest(requester.id, { declinedBy: [declan.id] });
    let deletionRes;
    runOnceAfterNextRead(User, 'findById', async () => {
      deletionRes = await deleteAccount(leaver);
    });
    const socket = spyOnSocket();

    const res = await patchStatus(bloodRequest._id, leaver, 'declined');

    expect(deletionRes.statusCode).toBe(200);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ message: 'Unauthorized - User not found' });
    const stored = await Request.collection.findOne({ _id: bloodRequest._id });
    expect(stored.status).toBe('pending');
    expect(stored.declinedBy.map(String)).toEqual([declan.id]);
    expect(await readDatabase()).not.toContain(leaver.id);
    await delay(SILENCE_WINDOW_MS);
    expect(socket.notifications()).toEqual([]);
  });

  it('sendMessage removes a message saved after its sender was deleted (401), and sends it to no one', async () => {
    const leaver = await registerUser({ name: 'Leela Leaver', bloodGroup: 'A+', location: HOSPITAL });
    const dana = await registerUser({ name: 'Dana Donor' });
    const bloodRequest = await createBloodRequest(leaver.id, { status: 'accepted', matchedDonorId: dana.id });
    let deletionRes;
    // After sendMessage has read the request and found Leela its requester, before it saves
    runOnceAfterNextRead(Request, 'findById', async () => {
      deletionRes = await deleteAccount(leaver);
    });
    const socket = spyOnSocket();

    const res = await asUser(leaver, 'post', `/api/messages/send/${bloodRequest._id}`).send({ text: 'Are you on your way?' });

    expect(deletionRes.statusCode).toBe(200);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ message: 'Unauthorized - User not found' });
    expect(await Message.countDocuments()).toBe(0);
    expect(await readDatabase()).not.toContain(leaver.id);
    await delay(SILENCE_WINDOW_MS);
    // Only the deletion's own event: Dana's accepted request was cancelled with the account
    expect(socket.notifications()).toEqual([
      {
        room: dana.id,
        event: 'requestStatusUpdate',
        payload: { requestId: String(bloodRequest._id), status: 'cancelled', reason: 'account_deleted' },
      },
    ]);
  });
});

describe('the chat of a request whose donor deletes their account', () => {
  it('sendMessage removes a message saved after its receiver was deleted (409), so the next donor never sees it', async () => {
    const rita = await registerUser({ name: 'Rita Requester', bloodGroup: 'A+', location: HOSPITAL });
    const sita = await registerUser({ name: 'Sita Donor' });
    const bob = await registerUser({ name: 'Bob Donor', location: ALSO_NEARBY });
    const bloodRequest = await createBloodRequest(rita.id);
    expect((await patchStatus(bloodRequest._id, sita, 'accepted')).statusCode).toBe(200);
    let deletionRes;
    // After sendMessage has read the request and found Sita its donor, before it saves
    runOnceAfterNextRead(Request, 'findById', async () => {
      deletionRes = await deleteAccount(sita);
    });
    const socket = spyOnSocket();

    const res = await asUser(rita, 'post', `/api/messages/send/${bloodRequest._id}`).send({ text: 'Private note for Sita' });

    expect(deletionRes.statusCode).toBe(200);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ message: 'This chat has ended' });
    expect(await Message.countDocuments()).toBe(0);
    expect(await readDatabase()).not.toContain(sita.id);
    // The reopened request is announced after the deletion's 200; let that finish first
    await waitUntil(() => socket.newRequestAlerts().length > 0);
    await delay(SILENCE_WINDOW_MS);
    expect(socket.notifications().filter(({ event }) => event === 'newMessage')).toEqual([]);

    // Bob accepts the reopened request, and its chat starts empty on both sides
    expect((await patchStatus(bloodRequest._id, bob, 'accepted')).statusCode).toBe(200);
    for (const user of [bob, rita]) {
      const history = await asUser(user, 'get', `/api/messages/${bloodRequest._id}`);
      expect(history.statusCode).toBe(200);
      expect(history.body.messages).toEqual([]);
    }
  });

  it('getMessages returns only the messages between the requester and the current donor', async () => {
    const rita = await registerUser({ name: 'Rita Requester', bloodGroup: 'A+', location: HOSPITAL });
    const bob = await registerUser({ name: 'Bob Donor' });
    const bloodRequest = await createBloodRequest(rita.id, { status: 'accepted', matchedDonorId: bob.id });
    // Planted as if left behind with a former donor whose account is gone
    const formerDonorId = new mongoose.Types.ObjectId();
    await addMessage(rita.id, formerDonorId, bloodRequest._id, 'Private note for Sita');
    await addMessage(formerDonorId, rita.id, bloodRequest._id, 'Sita to Rita');
    await addMessage(rita.id, bob.id, bloodRequest._id, 'Rita to Bob');
    await addMessage(bob.id, rita.id, bloodRequest._id, 'Bob to Rita');

    for (const user of [bob, rita]) {
      const res = await asUser(user, 'get', `/api/messages/${bloodRequest._id}`);
      expect(res.statusCode).toBe(200);
      // Sorted here: two messages created in the same millisecond have no fixed order
      expect(res.body.messages.map((message) => message.text).sort()).toEqual(['Bob to Rita', 'Rita to Bob']);
    }
  });
});

describe('DELETE /api/users/me: the clean-up after the commit', () => {
  const realTransaction = (...args) => mongoose.connection.constructor.prototype.transaction.apply(mongoose.connection, args);

  it("removes what the deleted user's other requests wrote after the transaction's reads, and tells the other side", async () => {
    const leaver = await registerUser({ name: 'Leela Leaver', bloodGroup: 'O-', location: HOSPITAL });
    const anil = await registerUser({ name: 'Anil Donor' });
    const ravi = await registerUser({ name: 'Ravi Requester', bloodGroup: 'A+', location: HOSPITAL });
    const nina = await registerUser({ name: 'Nina Donor', location: ALSO_NEARBY });
    const raviPending = await createBloodRequest(ravi.id);
    let orphans = null;

    // Writes from Leela's other requests whose own check still found her: after every read and
    // write of the transaction, before its commit, outside its session, so its snapshot cannot
    // see them. Only on the first attempt, in case the driver retries it.
    jest.spyOn(mongoose.connection, 'transaction').mockImplementation((callback, options) =>
      realTransaction(async (session) => {
        const result = await callback(session);
        if (!orphans) {
          orphans = {
            pending: await createBloodRequest(leaver.id),
            acceptedByAnil: await createBloodRequest(leaver.id, { status: 'accepted', matchedDonorId: anil.id }),
            message: await addMessage(leaver.id, ravi.id, raviPending._id, 'Leela to Ravi'),
          };
          await Request.updateOne({ _id: raviPending._id }, { $set: { status: 'accepted', matchedDonorId: leaver.id } });
        }
        return result;
      }, options)
    );
    const socket = spyOnSocket();

    const res = await deleteAccount(leaver);

    expect(res.statusCode).toBe(200);
    expect(orphans).not.toBeNull();
    expect(await Request.exists({ _id: orphans.pending._id })).toBeNull();
    expect(await Request.exists({ _id: orphans.acceptedByAnil._id })).toBeNull();
    expect(await Message.exists({ _id: orphans.message._id })).toBeNull();
    expect(await Request.collection.findOne({ _id: raviPending._id })).toMatchObject({ status: 'pending', matchedDonorId: null });
    expect(await readDatabase()).not.toContain(leaver.id);

    // Status updates are sent before the 200; the alerts below follow it
    expect(socket.statusUpdates().map(({ room, payload }) => ({ room, payload: { ...payload, requestId: String(payload.requestId) } }))).toEqual([
      {
        room: anil.id,
        payload: { requestId: String(orphans.acceptedByAnil._id), status: 'cancelled', reason: 'account_deleted' },
      },
      {
        room: ravi.id,
        payload: { requestId: String(raviPending._id), status: 'pending', reason: 'account_deleted' },
      },
    ]);
    // Ravi's request is announced again: Anil is free again, and Nina always was
    await waitUntil(() => socket.newRequestAlerts().length > 0);
    await delay(SILENCE_WINDOW_MS);
    expect(socket.newRequestAlerts().map(({ room }) => room).sort()).toEqual([anil.id, nina.id].sort());
    expect(socket.notifications()).toHaveLength(4);
  });

  it('tells the requester and alerts each donor once when the transaction and the clean-up both reopen a request', async () => {
    const leaver = await registerUser({ name: 'Leela Leaver' });
    const ravi = await registerUser({ name: 'Ravi Requester', bloodGroup: 'A+', location: HOSPITAL });
    const nina = await registerUser({ name: 'Nina Donor', location: ALSO_NEARBY });
    const raviRequest = await createBloodRequest(ravi.id, { status: 'accepted', matchedDonorId: leaver.id });
    let retake = null;

    // An accept by Leela that was already on its way lands between the commit and the clean-up.
    // The request the transaction put back to pending is hers again, so the clean-up reopens it too.
    jest.spyOn(mongoose.connection, 'transaction').mockImplementation(async (callback, options) => {
      const result = await realTransaction(callback, options);
      retake = await Request.updateOne(
        { _id: raviRequest._id, status: 'pending' },
        { $set: { status: 'accepted', matchedDonorId: leaver.id } }
      );
      return result;
    });
    const socket = spyOnSocket();

    const res = await deleteAccount(leaver);

    expect(res.statusCode).toBe(200);
    expect(retake.modifiedCount).toBe(1);
    expect(await Request.collection.findOne({ _id: raviRequest._id })).toMatchObject({ status: 'pending', matchedDonorId: null });
    expect(await readDatabase()).not.toContain(leaver.id);
    expect(socket.statusUpdates().map(({ room, payload }) => ({ room, payload: { ...payload, requestId: String(payload.requestId) } }))).toEqual([
      {
        room: ravi.id,
        payload: { requestId: String(raviRequest._id), status: 'pending', reason: 'account_deleted' },
      },
    ]);
    await waitUntil(() => socket.newRequestAlerts().length > 0);
    await delay(SILENCE_WINDOW_MS);
    expect(socket.newRequestAlerts().map(({ room, payload }) => ({ room, requestId: payload._id }))).toEqual([
      { room: nina.id, requestId: String(raviRequest._id) },
    ]);
    expect(socket.notifications()).toHaveLength(2);
  });

  it('logs a failed clean-up and still answers 200, with the account erased and the others told', async () => {
    const leaver = await registerUser({ name: 'Leela Leaver', bloodGroup: 'A+', location: HOSPITAL });
    const anil = await registerUser({ name: 'Anil Donor' });
    const leaverAccepted = await createBloodRequest(leaver.id, { status: 'accepted', matchedDonorId: anil.id });
    jest.spyOn(mongoose.connection, 'transaction').mockImplementation(async (callback, options) => {
      const result = await realTransaction(callback, options);
      // The clean-up's first read fails
      jest.spyOn(Request, 'find').mockImplementationOnce(() => {
        throw new Error('forced clean-up failure');
      });
      return result;
    });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const socket = spyOnSocket();

    const res = await deleteAccount(leaver);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ message: 'Your account has been deleted' });
    expect(jwtCookieOf(res)).toMatch(/^jwt=;/);
    expect(consoleError).toHaveBeenCalledWith(
      `deleteAccount: the clean-up after erasing user ${leaver.id} failed:`,
      'forced clean-up failure'
    );
    expect(await readDatabase()).not.toContain(leaver.id);
    expect(socket.notifications()).toEqual([
      {
        room: anil.id,
        event: 'requestStatusUpdate',
        payload: { requestId: String(leaverAccepted._id), status: 'cancelled', reason: 'account_deleted' },
      },
    ]);
  });
});

describe('DELETE /api/users/me: a request the deleted donor had accepted is announced again', () => {
  it('alerts compatible nearby donors, but not the requester or declined, busy, resting, distant or incompatible donors', async () => {
    const rita = await registerUser({ name: 'Rita Requester', bloodGroup: 'A+', location: HOSPITAL });
    const leaver = await registerUser({ name: 'Leela Leaver' });
    const nina = await registerUser({ name: 'Nina Donor', bloodGroup: 'B+', location: ALSO_NEARBY });
    const declan = await registerUser({ name: 'Declan Declined' });
    const bea = await registerUser({ name: 'Bea Busy' });
    const rex = await registerUser({ name: 'Rex Resting' });
    await registerUser({ name: 'Farah Faraway', location: FAR_AWAY });
    await registerUser({ name: 'Ivan Incompatible', bloodGroup: 'A+' });
    await User.findByIdAndUpdate(nina.id, { pushSubscription: PUSH_SUBSCRIPTION });
    await User.findByIdAndUpdate(declan.id, { pushSubscription: PUSH_SUBSCRIPTION });

    const bloodRequest = await createBloodRequest(rita.id);
    expect((await patchStatus(bloodRequest._id, declan, 'declined')).statusCode).toBe(200);
    expect((await patchStatus(bloodRequest._id, leaver, 'accepted')).statusCode).toBe(200);
    await createBloodRequest(rita.id, { status: 'accepted', matchedDonorId: bea.id });
    await createBloodRequest(rita.id, { status: 'fulfilled', matchedDonorId: rex.id, fulfilledAt: new Date(Date.now() - 10 * DAY_MS) });
    const socket = spyOnSocket();

    expect((await deleteAccount(leaver)).statusCode).toBe(200);

    await waitUntil(() => socket.newRequestAlerts().length > 0);
    await delay(SILENCE_WINDOW_MS);
    const alerts = socket.newRequestAlerts();
    expect(alerts.map(({ room }) => room)).toEqual([nina.id]);
    // The same payload createRequest sends: the card's fields and the requester's name, no user ids
    expect(alerts[0].payload).toEqual({
      _id: String(bloodRequest._id),
      bloodGroup: 'B+',
      unitsNeeded: 2,
      hospitalName: 'Erase Test Hospital',
      hospitalLocation: { type: 'Point', coordinates: HOSPITAL },
      urgency: 'high',
      status: 'pending',
      createdAt: bloodRequest.createdAt,
      requesterName: 'Rita Requester',
      matchType: 'exact',
    });
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
    const [subscription, pushPayload] = webpush.sendNotification.mock.calls[0];
    expect(subscription).toEqual(PUSH_SUBSCRIPTION);
    expect(JSON.parse(pushPayload).body).toBe('Rita Requester needs 2 units of B+ at Erase Test Hospital. You are an exact match!');
    // The request itself is back to pending, and Declan's decline is kept
    const stored = await Request.collection.findOne({ _id: bloodRequest._id });
    expect(stored).toMatchObject({ status: 'pending', matchedDonorId: null });
    expect(stored.declinedBy.map(String)).toEqual([declan.id]);
  });

  it('logs a failed announcement, after the 200 has already been sent', async () => {
    const rita = await registerUser({ name: 'Rita Requester', bloodGroup: 'A+', location: HOSPITAL });
    const leaver = await registerUser({ name: 'Leela Leaver' });
    const bloodRequest = await createBloodRequest(rita.id);
    expect((await patchStatus(bloodRequest._id, leaver, 'accepted')).statusCode).toBe(200);
    // The only distinct query after the commit is the announcement's busy-or-resting lookup
    jest.spyOn(Request, 'distinct').mockRejectedValueOnce(new Error('forced announcement failure'));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const socket = spyOnSocket();

    const res = await deleteAccount(leaver);

    expect(res.statusCode).toBe(200);
    await waitUntil(() => consoleError.mock.calls.length > 0);
    expect(consoleError).toHaveBeenCalledWith(
      `deleteAccount: failed to alert donors near reopened request ${bloodRequest._id}:`,
      'forced announcement failure'
    );
    expect(socket.newRequestAlerts()).toEqual([]);
    expect(await Request.collection.findOne({ _id: bloodRequest._id })).toMatchObject({ status: 'pending', matchedDonorId: null });
  });
});
