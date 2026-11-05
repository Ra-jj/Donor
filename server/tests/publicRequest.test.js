const request = require('supertest');
const mongoose = require('mongoose');
const webpush = require('web-push');
// Mounts the routes on the app that lib/socket's server serves
require('../index');
const { io, server } = require('../lib/socket');
const Request = require('../models/request.model');
const { generateShareToken, isShareTokenFormat } = require('../utils/shareToken');
const { connectDB, closeDB, clearDB } = require('./db');
const { REGISTRATION_CONSENT } = require('./registration');

// A request's share link (/r/<token>): the token, the requester-only POST /api/requests/:id/share-link
// that hands it out, and the public GET /api/public/requests/:token that anyone can call.

// Coordinates are [longitude, latitude]
const HOSPITAL = [77.5946, 12.9716]; // Bangalore
const NEARBY = [77.6, 12.975]; // ~0.7 km from HOSPITAL

const PASSWORD = 'password123';
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const OPEN_MS = 48 * HOUR_MS;
const SHARE_TOKEN_SHAPE = /^[A-Za-z0-9_-]{22}$/;
const OPEN_KEYS = ['bloodGroup', 'expiresAt', 'hospitalName', 'state', 'unitsNeeded', 'urgency'];

let userCount = 0;

beforeAll(async () => {
  await connectDB();
  // Builds every index first, the unique share_token one included
  await Request.init();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
});

beforeEach(() => {
  // protectRoute logs every rejection; nothing here is about them
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  // A new request is announced to nearby donors, push included; never reach a real service
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

// Register through the API and reuse the cookie register sets (login is rate limited)
const registerUser = async ({ bloodGroup = 'O-', location = NEARBY, name } = {}) => {
  userCount += 1;
  const res = await request(server)
    .post('/api/auth/register')
    .send({
      name: name || `Share User ${userCount}`,
      email: `share.user${userCount}@example.com`,
      password: PASSWORD,
      bloodGroup,
      location,
      ...REGISTRATION_CONSENT,
    });
  expect(res.statusCode).toBe(201);
  return { id: res.body.user._id, name: res.body.user.name, cookie: res.headers['set-cookie'] };
};

const registerRequester = (name = 'Rita Requester') => registerUser({ name, bloodGroup: 'A+', location: HOSPITAL });

// Created directly on the model, ageMs old, so each test controls status, donor, age and token
const createBloodRequest = (requesterId, { ageMs = 0, ...overrides } = {}) =>
  Request.create({
    requesterId,
    bloodGroup: 'B+',
    unitsNeeded: 2,
    hospitalName: 'Share Test Hospital',
    hospitalLocation: { type: 'Point', coordinates: HOSPITAL },
    urgency: 'high',
    createdAt: new Date(Date.now() - ageMs),
    ...overrides,
  });

const asUser = (user, method, url) => request(server)[method](url).set('Cookie', user.cookie);
const readPublic = (token) => request(server).get(`/api/public/requests/${token}`);
const postShareLink = (user, requestId) => asUser(user, 'post', `/api/requests/${requestId}/share-link`);
const storedToken = async (requestId) => (await Request.collection.findOne({ _id: requestId })).shareToken;

const expectPublicHeaders = (res) => {
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.headers['x-robots-tag']).toBe('noindex');
};

// Replaces io.to() so a test can see every event the server sends, and to which room
const spyOnSocket = () => {
  const emit = jest.fn();
  jest.spyOn(io, 'to').mockReturnValue({ emit });
  return { payloadsText: () => JSON.stringify(emit.mock.calls) };
};

describe('share tokens', () => {
  it('are 22 base64url characters of 16 random bytes, and pass the format check', () => {
    const tokens = new Set();
    for (let i = 0; i < 200; i += 1) {
      const token = generateShareToken();
      expect(token).toMatch(SHARE_TOKEN_SHAPE);
      expect(isShareTokenFormat(token)).toBe(true);
      expect(Buffer.from(token, 'base64url')).toHaveLength(16);
      tokens.add(token);
    }
    expect(tokens.size).toBe(200);
  });

  it.each([
    ['too short', 'AAAAAAAAAAAAAAAAAAAAA'],
    ['too long', 'AAAAAAAAAAAAAAAAAAAAAAA'],
    ['a character outside base64url', 'AAAAAAAAAAAAAAAAAAAA+A'],
    ['padding', 'AAAAAAAAAAAAAAAAAAAA=A'],
    ['a last character 16 bytes never end in', 'AAAAAAAAAAAAAAAAAAAAAB'],
    ['a request id', '64b7f0c2a1b2c3d4e5f60718'],
    ['not a string', 12345],
  ])('fail the format check with %s', (_label, value) => {
    expect(isShareTokenFormat(value)).toBe(false);
  });

  it('are never in toJSON or toObject, like declinedBy', async () => {
    const requester = await registerRequester();
    const bloodRequest = await createBloodRequest(requester.id, { shareToken: generateShareToken() });

    expect(bloodRequest.shareToken).toMatch(SHARE_TOKEN_SHAPE);
    expect(bloodRequest.toJSON()).not.toHaveProperty('shareToken');
    expect(bloodRequest.toObject()).not.toHaveProperty('shareToken');
    expect(JSON.stringify(bloodRequest)).not.toContain(bloodRequest.shareToken);
  });

  it('are unique: a second request cannot have the same token, while many can have none', async () => {
    const requester = await registerRequester();
    const token = generateShareToken();
    await createBloodRequest(requester.id, { shareToken: token });
    await createBloodRequest(requester.id);
    await createBloodRequest(requester.id);

    await expect(createBloodRequest(requester.id, { shareToken: token })).rejects.toMatchObject({ code: 11000 });
    const shareTokenIndex = (await Request.collection.indexes()).find((index) => index.name === 'share_token');
    expect(shareTokenIndex).toMatchObject({ key: { shareToken: 1 }, unique: true, sparse: true });
  });
});

describe('POST /api/requests (create)', () => {
  it('gives the requester the new request\'s share token on its own, never inside the request', async () => {
    const requester = await registerRequester();

    const res = await asUser(requester, 'post', '/api/requests')
      .send({ bloodGroup: 'B+', unitsNeeded: 2, hospitalName: 'Share Test Hospital', hospitalLocation: HOSPITAL, urgency: 'high' });

    expect(res.statusCode).toBe(201);
    expect(res.body.shareToken).toMatch(SHARE_TOKEN_SHAPE);
    expect(isShareTokenFormat(res.body.shareToken)).toBe(true);
    expect(res.body.request).not.toHaveProperty('shareToken');
    expect(JSON.stringify(res.body.request)).not.toContain(res.body.shareToken);
    expect(await storedToken(new mongoose.Types.ObjectId(res.body.request._id))).toBe(res.body.shareToken);

    // The link works straight away
    const publicRes = await readPublic(res.body.shareToken);
    expect(publicRes.statusCode).toBe(200);
    expect(publicRes.body.state).toBe('open');
  });
});

describe('the share token never reaches anyone else', () => {
  it('is absent from mine, incoming, history, every status response and every socket event', async () => {
    const requester = await registerRequester();
    const donor = await registerUser({ name: 'Dana Donor' });
    const socket = spyOnSocket();

    const createRes = await asUser(requester, 'post', '/api/requests')
      .send({ bloodGroup: 'B+', unitsNeeded: 2, hospitalName: 'Share Test Hospital', hospitalLocation: HOSPITAL, urgency: 'high' });
    expect(createRes.statusCode).toBe(201);
    const token = createRes.body.shareToken;
    const requestId = createRes.body.request._id;
    // A second request, cancelled below, so a cancel response is checked too
    const otherRes = await asUser(requester, 'post', '/api/requests')
      .send({ bloodGroup: 'B+', unitsNeeded: 1, hospitalName: 'Share Test Hospital', hospitalLocation: HOSPITAL, urgency: 'low' });
    const otherToken = otherRes.body.shareToken;
    const tokens = [token, otherToken];

    const expectNoToken = (res) => {
      expect(res.statusCode).toBeLessThan(300);
      expect(res.text).not.toContain('shareToken');
      tokens.forEach((value) => expect(res.text).not.toContain(value));
    };

    // The donor's alert for each new request (newBloodRequest) went out during the creates
    expect(socket.payloadsText()).toContain('newBloodRequest');

    const incoming = await asUser(donor, 'get', '/api/requests/incoming');
    expect(incoming.body.incomingRequests).toHaveLength(2);
    expectNoToken(incoming);
    expectNoToken(await asUser(requester, 'get', '/api/requests/mine'));

    expectNoToken(await asUser(donor, 'patch', `/api/requests/${requestId}/status`).send({ status: 'accepted' }));
    expectNoToken(await asUser(requester, 'patch', `/api/requests/${otherRes.body.request._id}/status`).send({ status: 'cancelled' }));
    expectNoToken(await asUser(requester, 'patch', `/api/requests/${requestId}/fulfill`));
    expectNoToken(await asUser(requester, 'post', `/api/requests/${requestId}/rate`).send({ rating: 5 }));
    expectNoToken(await asUser(requester, 'get', '/api/users/history'));
    expectNoToken(await asUser(donor, 'get', '/api/users/history'));
    expectNoToken(await asUser(donor, 'get', '/api/requests/incoming'));

    // newBloodRequest, the accept, cancel, fulfil and rate updates: none carries a token
    const sentText = socket.payloadsText();
    expect(sentText).toContain('requestStatusUpdate');
    expect(sentText).not.toContain('shareToken');
    tokens.forEach((value) => expect(sentText).not.toContain(value));
  });

  it('is absent from the event the expiry sweep sends', async () => {
    const requester = await registerRequester();
    const stale = await createBloodRequest(requester.id, { ageMs: OPEN_MS + HOUR_MS, shareToken: generateShareToken() });
    const socket = spyOnSocket();

    // The requester's own read closes their expired request and announces it
    const mine = await asUser(requester, 'get', '/api/requests/mine');

    expect(mine.body.requests[0]).toMatchObject({ status: 'cancelled', closedReason: 'expired' });
    expect(socket.payloadsText()).toContain('expired');
    expect(socket.payloadsText()).not.toContain(stale.shareToken);
    expect(mine.text).not.toContain(stale.shareToken);
  });
});

describe('GET /api/public/requests/:token', () => {
  it('shows an open request: exactly its four fields and when it closes, to anyone', async () => {
    const requester = await registerRequester();
    const donor = await registerUser({ name: 'Dana Donor' });
    const createdAt = new Date(Date.now() - 5 * HOUR_MS);
    const bloodRequest = await createBloodRequest(requester.id, {
      createdAt,
      shareToken: generateShareToken(),
      declinedBy: [donor.id],
    });

    const res = await readPublic(bloodRequest.shareToken);

    expect(res.statusCode).toBe(200);
    expectPublicHeaders(res);
    expect(Object.keys(res.body).sort()).toEqual(OPEN_KEYS);
    expect(res.body).toEqual({
      state: 'open',
      bloodGroup: 'B+',
      unitsNeeded: 2,
      hospitalName: 'Share Test Hospital',
      urgency: 'high',
      expiresAt: new Date(createdAt.getTime() + OPEN_MS).toISOString(),
    });
    // Nothing about the requester, the donor who declined, the request's id or its place
    for (const hidden of [requester.id, requester.name, donor.id, String(bloodRequest._id), String(HOSPITAL[0]), 'createdAt', 'declinedBy']) {
      expect(res.text).not.toContain(hidden);
    }
  });

  it('answers the same to a signed-in user', async () => {
    const requester = await registerRequester();
    const visitor = await registerUser({ name: 'Vera Visitor' });
    const bloodRequest = await createBloodRequest(requester.id, { shareToken: generateShareToken() });

    const res = await asUser(visitor, 'get', `/api/public/requests/${bloodRequest.shareToken}`);

    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(OPEN_KEYS);
  });

  it('says only donor_found once a donor has accepted', async () => {
    const requester = await registerRequester();
    const donor = await registerUser({ name: 'Dana Donor' });
    const bloodRequest = await createBloodRequest(requester.id, {
      status: 'accepted',
      matchedDonorId: donor.id,
      shareToken: generateShareToken(),
    });

    const res = await readPublic(bloodRequest.shareToken);

    expect(res.statusCode).toBe(200);
    expectPublicHeaders(res);
    expect(res.body).toEqual({ state: 'donor_found' });
    expect(res.text).not.toContain(donor.name);
  });

  it.each([
    ['fulfilled', { status: 'fulfilled', fulfilledAt: new Date() }],
    ['cancelled', { status: 'cancelled' }],
    ['expired by a sweep', { status: 'cancelled', closedReason: 'expired', ageMs: OPEN_MS + HOUR_MS }],
  ])('says only closed for a %s request', async (_label, overrides) => {
    const requester = await registerRequester();
    const donor = await registerUser({ name: 'Dana Donor' });
    const matchedDonorId = overrides.status === 'fulfilled' ? donor.id : null;
    const bloodRequest = await createBloodRequest(requester.id, { matchedDonorId, shareToken: generateShareToken(), ...overrides });

    const res = await readPublic(bloodRequest.shareToken);

    expect(res.statusCode).toBe(200);
    expectPublicHeaders(res);
    expect(res.body).toEqual({ state: 'closed' });
  });

  it('says closed for a pending request past its 48 hours that no sweep has closed yet, and changes nothing', async () => {
    const requester = await registerRequester();
    const bloodRequest = await createBloodRequest(requester.id, { ageMs: OPEN_MS + MINUTE_MS, shareToken: generateShareToken() });
    const before = JSON.stringify(await Request.collection.findOne({ _id: bloodRequest._id }));

    const res = await readPublic(bloodRequest.shareToken);

    expect(res.body).toEqual({ state: 'closed' });
    expect(JSON.stringify(await Request.collection.findOne({ _id: bloodRequest._id }))).toBe(before);
  });

  it('still shows a request one minute inside its 48 hours as open', async () => {
    const requester = await registerRequester();
    const bloodRequest = await createBloodRequest(requester.id, { ageMs: OPEN_MS - MINUTE_MS, shareToken: generateShareToken() });

    const res = await readPublic(bloodRequest.shareToken);

    expect(res.body.state).toBe('open');
  });

  it('answers 404 for a well-formed token that belongs to no request', async () => {
    const res = await readPublic(generateShareToken());

    expect(res.statusCode).toBe(404);
    expectPublicHeaders(res);
    expect(res.body).toEqual({ message: 'Request not found' });
  });

  it.each([
    ['too short', 'AAAAAAAAAAAAAAAAAAAAA'],
    ['too long', 'AAAAAAAAAAAAAAAAAAAAAAAA'],
    ['a request id', '64b7f0c2a1b2c3d4e5f60718'],
    ['a wrong last character', 'AAAAAAAAAAAAAAAAAAAAAB'],
    ['an encoded slash', 'AAAAAAAAAAAAAAAAAAAA%2FA'],
    ['a query operator', '%7B%22%24ne%22%3A1%7D'],
  ])('answers 400 for a token that is %s, before reading the database', async (_label, token) => {
    const findOne = jest.spyOn(Request, 'findOne');

    const res = await readPublic(token);

    expect(res.statusCode).toBe(400);
    expectPublicHeaders(res);
    expect(res.body).toEqual({ message: 'Invalid link' });
    expect(findOne).not.toHaveBeenCalled();
  });
});

describe('POST /api/requests/:id/share-link', () => {
  it("returns the token an open request already has, to its requester", async () => {
    const requester = await registerRequester();
    const token = generateShareToken();
    const bloodRequest = await createBloodRequest(requester.id, { shareToken: token });

    const res = await postShareLink(requester, bloodRequest._id);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ shareToken: token });
  });

  it('makes a token for an older request that has none, once: later calls get the same one', async () => {
    const requester = await registerRequester();
    const olderRequest = await createBloodRequest(requester.id);
    expect(await Request.collection.findOne({ _id: olderRequest._id })).not.toHaveProperty('shareToken');

    const first = await postShareLink(requester, olderRequest._id);
    const second = await postShareLink(requester, olderRequest._id);

    expect(first.statusCode).toBe(200);
    expect(isShareTokenFormat(first.body.shareToken)).toBe(true);
    expect(second.body).toEqual(first.body);
    expect(await storedToken(olderRequest._id)).toBe(first.body.shareToken);
    expect((await readPublic(first.body.shareToken)).body.state).toBe('open');
  });

  it('gives every one of several calls at the same moment the same token', async () => {
    const requester = await registerRequester();
    const olderRequest = await createBloodRequest(requester.id);

    const responses = await Promise.all(Array.from({ length: 8 }, () => postShareLink(requester, olderRequest._id)));

    expect(responses.map((res) => res.statusCode)).toEqual(Array(8).fill(200));
    const tokens = new Set(responses.map((res) => res.body.shareToken));
    expect(tokens.size).toBe(1);
    expect(await storedToken(olderRequest._id)).toBe([...tokens][0]);
  });

  it("refuses anyone but the requester (403), and gives no token to the request", async () => {
    const requester = await registerRequester();
    const stranger = await registerUser({ name: 'Sam Stranger' });
    const withToken = await createBloodRequest(requester.id, { shareToken: generateShareToken() });
    const withoutToken = await createBloodRequest(requester.id);

    const resWithToken = await postShareLink(stranger, withToken._id);
    const resWithoutToken = await postShareLink(stranger, withoutToken._id);

    for (const res of [resWithToken, resWithoutToken]) {
      expect(res.statusCode).toBe(403);
      expect(res.body).toEqual({ message: 'Only the requester can share this request' });
    }
    expect(resWithToken.text).not.toContain(withToken.shareToken);
    expect(await Request.collection.findOne({ _id: withoutToken._id })).not.toHaveProperty('shareToken');
  });

  it.each([
    ['accepted', { status: 'accepted' }],
    ['fulfilled', { status: 'fulfilled', fulfilledAt: new Date() }],
    ['cancelled', { status: 'cancelled' }],
  ])('refuses a request that is %s (409), with or without a token', async (status, overrides) => {
    const requester = await registerRequester();
    // One donor each: a donor can hold only one accepted request
    const firstDonor = await registerUser({ name: 'Dana Donor' });
    const secondDonor = await registerUser({ name: 'Dev Donor' });
    const donorIdFor = (donor) => (status === 'cancelled' ? null : donor.id);
    const withToken = await createBloodRequest(requester.id, {
      ...overrides,
      matchedDonorId: donorIdFor(firstDonor),
      shareToken: generateShareToken(),
    });
    const withoutToken = await createBloodRequest(requester.id, { ...overrides, matchedDonorId: donorIdFor(secondDonor) });

    const resWithToken = await postShareLink(requester, withToken._id);
    const resWithoutToken = await postShareLink(requester, withoutToken._id);

    for (const res of [resWithToken, resWithoutToken]) {
      expect(res.statusCode).toBe(409);
      expect(res.body).toEqual({ message: `Only an open request can be shared (this one has been ${status})` });
    }
    expect(resWithToken.text).not.toContain(withToken.shareToken);
    expect(await Request.collection.findOne({ _id: withoutToken._id })).not.toHaveProperty('shareToken');
  });

  it('refuses a request past its 48 hours (409), closing it as a sweep would, with no token', async () => {
    const requester = await registerRequester();
    const stale = await createBloodRequest(requester.id, { ageMs: OPEN_MS + MINUTE_MS });

    const res = await postShareLink(requester, stale._id);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ message: 'This request has expired' });
    const stored = await Request.collection.findOne({ _id: stale._id });
    expect(stored).toMatchObject({ status: 'cancelled', closedReason: 'expired' });
    expect(stored).not.toHaveProperty('shareToken');
  });

  it('answers 404 for an unknown id, 400 for a malformed one and 401 without a login', async () => {
    const requester = await registerRequester();
    const bloodRequest = await createBloodRequest(requester.id);

    expect((await postShareLink(requester, new mongoose.Types.ObjectId())).statusCode).toBe(404);
    expect((await postShareLink(requester, 'not-an-id')).statusCode).toBe(400);
    const anonymous = await request(server).post(`/api/requests/${bloodRequest._id}/share-link`);
    expect(anonymous.statusCode).toBe(401);
    expect(await Request.collection.findOne({ _id: bloodRequest._id })).not.toHaveProperty('shareToken');
  });
});

// Last in this file: it uses up the limiter's allowance for this address
describe('the public endpoint rate limit', () => {
  it('answers 429, still with no-store and noindex, once one address has used its 300 calls', async () => {
    const token = generateShareToken();
    const first = await readPublic(token);
    expect(first.headers['ratelimit-limit']).toBe('300');
    const remaining = Number(first.headers['ratelimit-remaining']);
    expect(remaining).toBeGreaterThan(0);

    for (let i = 0; i < remaining; i += 1) {
      // Badly formed tokens count too
      const res = await readPublic(i % 2 === 0 ? token : 'bad');
      expect(res.statusCode).not.toBe(429);
    }
    const limited = await readPublic(token);

    expect(limited.statusCode).toBe(429);
    expectPublicHeaders(limited);
    expect(limited.body).toEqual({ message: 'Too many requests from this network. Please wait a few minutes and try again.' });
    // About 300 calls one after another: more than Jest's default 5 s on a slow CI runner
  }, 30000);
});
