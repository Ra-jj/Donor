const request = require('supertest');
const mongoose = require('mongoose');
const webpush = require('web-push');
// Mounts the routes on the app that lib/socket's server serves
require('../index');
const { io, server } = require('../lib/socket');
const Block = require('../models/block.model');
const Message = require('../models/message.model');
const Report = require('../models/report.model');
const Request = require('../models/request.model');
const User = require('../models/user.model');
const { MAX_BLOCKS_PER_USER } = require('../utils/blocks');
const { generateShareToken } = require('../utils/shareToken');
const { connectDB, closeDB, clearDB } = require('./db');
const { REGISTRATION_CONSENT } = require('./registration');

// Reports (of a request, of a user) and blocks between users: who may make them, what they change,
// and that nobody learns who reported or blocked them.

// Coordinates are [longitude, latitude]
const HOSPITAL = [77.5946, 12.9716]; // Bangalore
const NEARBY = [77.6, 12.975]; // ~0.7 km from HOSPITAL
const ALSO_NEARBY = [77.58, 12.96]; // ~2 km from HOSPITAL
const FAR_AWAY = [77.8246, 12.9716]; // ~25 km from HOSPITAL, outside the 15 km radius

const PASSWORD = 'password123';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// Long enough for an event already emitted to arrive, and for work started after a response to run
const SILENCE_WINDOW_MS = 300;
const PUSH_ENDPOINT_BASE = 'https://fcm.googleapis.com/fcm/send/';

let userCount = 0;

beforeAll(async () => {
  await connectDB();
  // Every unique index exists before the first test: the duplicate and race tests rely on them
  await Promise.all([Request.init(), Report.init(), Block.init()]);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
});

beforeEach(() => {
  // protectRoute and the post-write checks log; keep the output clean
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  // New and reopened requests are announced to nearby donors, push included; never reach a real service
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
      name: name || `Safety User ${userCount}`,
      email: `safety.user${userCount}@example.com`,
      password: PASSWORD,
      bloodGroup,
      location,
      ...REGISTRATION_CONSENT,
    });
  expect(res.statusCode).toBe(201);
  return { id: res.body.user._id, name: res.body.user.name, cookie: res.headers['set-cookie'] };
};

const registerRequester = (name = 'Rita Requester') => registerUser({ name, bloodGroup: 'A+', location: HOSPITAL });

// A donor with a push subscription, so a test can see whether an alert's push reached them
const withPush = async (user) => {
  await User.findByIdAndUpdate(user.id, {
    pushSubscription: { endpoint: `${PUSH_ENDPOINT_BASE}${user.id}`, keys: { p256dh: 'a', auth: 'b' } },
  });
  return user;
};
const pushedUserIds = () =>
  webpush.sendNotification.mock.calls.map(([subscription]) => subscription.endpoint.slice(PUSH_ENDPOINT_BASE.length));

// Created directly on the model, ageMs old, so each test controls status, donor and age
const createBloodRequest = (requesterId, { ageMs = 0, ...overrides } = {}) =>
  Request.create({
    requesterId,
    bloodGroup: 'B+',
    unitsNeeded: 2,
    hospitalName: 'Safety Test Hospital',
    hospitalLocation: { type: 'Point', coordinates: HOSPITAL },
    urgency: 'high',
    createdAt: new Date(Date.now() - ageMs),
    ...overrides,
  });

const asUser = (user, method, path) => request(server)[method](path).set('Cookie', user.cookie);

const reportRequest = (user, requestId, body = { reason: 'fake' }) =>
  asUser(user, 'post', `/api/requests/${requestId}/report`).send(body);
const reportUser = (user, requestId, body = { reason: 'abusive' }) =>
  asUser(user, 'post', `/api/requests/${requestId}/report-user`).send(body);
const blockOn = (user, requestId) => asUser(user, 'post', `/api/requests/${requestId}/block`);
const listBlocks = (user) => asUser(user, 'get', '/api/users/blocks');
const unblock = (user, blockId) => asUser(user, 'delete', `/api/users/blocks/${blockId}`);
const patchStatus = (user, requestId, status) =>
  asUser(user, 'patch', `/api/requests/${requestId}/status`).send({ status });
const incomingIds = async (user) => {
  const res = await asUser(user, 'get', '/api/requests/incoming');
  expect(res.statusCode).toBe(200);
  return res.body.incomingRequests.map((incoming) => incoming._id);
};
const createViaApi = (user, overrides = {}) =>
  asUser(user, 'post', '/api/requests').send({
    bloodGroup: 'B+',
    unitsNeeded: 1,
    hospitalName: 'New Request Hospital',
    hospitalLocation: HOSPITAL,
    ...overrides,
  });

// Replaces io.to() so a test can see which rooms were notified, with which event and payload
const spyOnSocket = () => {
  const emit = jest.fn();
  const to = jest.spyOn(io, 'to').mockReturnValue({ emit });
  const sent = () =>
    to.mock.calls.map(([room], index) => ({ room: String(room), event: emit.mock.calls[index][0], payload: emit.mock.calls[index][1] }));
  return {
    // Payload ids as strings, so tests compare them with the ids registerUser returns
    statusUpdates: () =>
      sent()
        .filter(({ event }) => event === 'requestStatusUpdate')
        .map(({ room, payload }) => ({ room, payload: { ...payload, requestId: String(payload.requestId) } })),
    alertedRooms: () => sent().filter(({ event }) => event === 'newBloodRequest').map(({ room }) => room),
    raw: sent,
  };
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Polls until check() resolves true. Work after a response (re-alerts, expiry) lands a little later.
const waitUntil = async (check, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms`);
    await delay(10);
  }
};

// Runs action() right after the NEXT call of model[method] has read the database, before its caller
// gets the result: the moment a deletion from another browser window can commit (as in
// accountDeletion.test.js)
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

const storedRequest = (bloodRequest) => Request.collection.findOne({ _id: bloodRequest._id });

// Sets when accounts were created, straight in the database: Mongoose never changes createdAt
const setAccountsCreatedAt = (users, createdAt) =>
  User.collection.updateMany(
    { _id: { $in: users.map(({ id }) => new mongoose.Types.ObjectId(id)) } },
    { $set: { createdAt } }
  );

describe('POST /api/requests/:id/report', () => {
  it('stores a report from a donor who sees the request in their incoming list (201), and hides it from them only', async () => {
    const requester = await registerRequester();
    const reporter = await registerUser({ name: 'Riya Reporter' });
    const otherDonor = await registerUser({ name: 'Omar Other', location: ALSO_NEARBY });
    const bloodRequest = await createBloodRequest(requester.id);
    expect(await incomingIds(reporter)).toEqual([String(bloodRequest._id)]);

    const res = await reportRequest(reporter, bloodRequest._id, { reason: 'fake', note: '  Number never answers  ' });

    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ message: 'Thank you. Your report has been sent.' });
    const reports = await Report.find().lean();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ kind: 'request', reason: 'fake', note: 'Number never answers' });
    expect(String(reports[0].reporterId)).toBe(reporter.id);
    expect(String(reports[0].reportedUserId)).toBe(requester.id);
    expect(String(reports[0].requestId)).toBe(String(bloodRequest._id));
    expect(reports[0].createdAt).toBeInstanceOf(Date);

    // Hidden from the reporter as after a decline; nothing else about the request changed
    expect(await incomingIds(reporter)).toEqual([]);
    expect(await incomingIds(otherDonor)).toEqual([String(bloodRequest._id)]);
    const stored = await storedRequest(bloodRequest);
    expect(stored.status).toBe('pending');
    expect(stored.declinedBy.map(String)).toEqual([reporter.id]);
  });

  it('lets the matched donor report the request (201) without ending the match', async () => {
    const requester = await registerRequester();
    const donor = await registerUser({ name: 'Dana Donor' });
    const bloodRequest = await createBloodRequest(requester.id, { status: 'accepted', matchedDonorId: donor.id });

    const res = await reportRequest(donor, bloodRequest._id, { reason: 'other' });

    expect(res.statusCode).toBe(201);
    expect(await Report.countDocuments({ kind: 'request', reporterId: donor.id })).toBe(1);
    const stored = await storedRequest(bloodRequest);
    expect(stored).toMatchObject({ status: 'accepted' });
    expect(String(stored.matchedDonorId)).toBe(donor.id);
    const chat = await asUser(donor, 'post', `/api/messages/send/${bloodRequest._id}`).send({ text: 'Still coming' });
    expect(chat.statusCode).toBe(201);
  });

  it('refuses the requester (403) and stores nothing', async () => {
    // O- at the hospital: compatible and in range, so only ownership refuses it
    const requester = await registerUser({ name: 'Rita Requester', bloodGroup: 'O-', location: HOSPITAL });
    const bloodRequest = await createBloodRequest(requester.id);

    const res = await reportRequest(requester, bloodRequest._id);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ message: 'You cannot report your own request' });
    expect(await Report.countDocuments()).toBe(0);
    expect((await storedRequest(bloodRequest)).declinedBy).toEqual([]);
  });

  it('refuses a user the request never reaches: an incompatible blood group or a home outside 15 km (403)', async () => {
    const requester = await registerRequester();
    const incompatible = await registerUser({ name: 'Ivan Incompatible', bloodGroup: 'A+' });
    const farAway = await registerUser({ name: 'Fara Faraway', location: FAR_AWAY });
    const bloodRequest = await createBloodRequest(requester.id);

    for (const outsider of [incompatible, farAway]) {
      const res = await reportRequest(outsider, bloodRequest._id);
      expect(res.statusCode).toBe(403);
      expect(res.body).toEqual({ message: 'You can only report a request you can see' });
    }
    expect(await Report.countDocuments()).toBe(0);
    expect((await storedRequest(bloodRequest)).declinedBy).toEqual([]);
  });

  it('answers a repeat 200 and keeps the first report as it was, even when both are sent at once', async () => {
    const requester = await registerRequester();
    const reporter = await registerUser();
    const bloodRequest = await createBloodRequest(requester.id);

    const answers = await Promise.all([
      reportRequest(reporter, bloodRequest._id, { reason: 'spam', note: 'first' }),
      reportRequest(reporter, bloodRequest._id, { reason: 'spam', note: 'first' }),
    ]);
    const repeat = await reportRequest(reporter, bloodRequest._id, { reason: 'abusive', note: 'second' });

    expect(answers.map((res) => res.statusCode).sort()).toEqual([200, 201]);
    expect(repeat.statusCode).toBe(200);
    expect(repeat.body).toEqual({ message: 'You have already reported this request' });
    const reports = await Report.find().lean();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ reason: 'spam', note: 'first' });
    expect((await storedRequest(bloodRequest)).declinedBy.map(String)).toEqual([reporter.id]);
  });

  it('checks the reason and the note (400) and stores nothing for a bad one', async () => {
    const requester = await registerRequester();
    const reporter = await registerUser();
    const bloodRequest = await createBloodRequest(requester.id);

    const badBodies = [
      {},
      { reason: 'rude' },
      { reason: 'fake', note: 'x'.repeat(301) },
      { reason: 'fake', note: 42 },
    ];
    for (const body of badBodies) {
      const res = await reportRequest(reporter, bloodRequest._id, body);
      expect(res.statusCode).toBe(400);
    }
    expect(await Report.countDocuments()).toBe(0);
    expect((await storedRequest(bloodRequest)).declinedBy).toEqual([]);

    // Trimmed before the limit is counted, so 300 characters with spaces around them are fine
    const res = await reportRequest(reporter, bloodRequest._id, { reason: 'other', note: `  ${'y'.repeat(300)}  ` });
    expect(res.statusCode).toBe(201);
    expect((await Report.findOne().lean()).note).toBe('y'.repeat(300));
  });
});

describe('a request reported by 3 different users', () => {
  it('closes as reported, tells its requester and the donors who can see it, and names no reporter anywhere', async () => {
    const requester = await registerRequester();
    const reporters = [
      await registerUser({ name: 'Ann Reporter' }),
      await registerUser({ name: 'Ben Reporter', location: ALSO_NEARBY }),
      await registerUser({ name: 'Cal Reporter' }),
    ];
    const bystander = await registerUser({ name: 'Bea Bystander', location: ALSO_NEARBY });
    const incompatible = await registerUser({ name: 'Ivan Incompatible', bloodGroup: 'A+' });
    const shareToken = generateShareToken();
    const bloodRequest = await createBloodRequest(requester.id, { shareToken });

    await reportRequest(reporters[0], bloodRequest._id, { reason: 'fake', note: 'Ann says fake' });
    await reportRequest(reporters[1], bloodRequest._id, { reason: 'spam' });
    expect((await storedRequest(bloodRequest)).status).toBe('pending');
    expect(await incomingIds(bystander)).toEqual([String(bloodRequest._id)]);

    const socket = spyOnSocket();
    const res = await reportRequest(reporters[2], bloodRequest._id, { reason: 'abusive' });

    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ message: 'Thank you. Your report has been sent.' });
    expect(await storedRequest(bloodRequest)).toMatchObject({ status: 'cancelled', closedReason: 'reported', matchedDonorId: null });

    const requestId = String(bloodRequest._id);
    const updates = socket.statusUpdates();
    expect(updates.filter(({ room }) => room === requester.id)).toEqual([
      { room: requester.id, payload: { requestId, status: 'cancelled', reason: 'reported', hospitalName: 'Safety Test Hospital' } },
    ]);
    // Everyone whose incoming list can hold it, reporters included, gets only its id and why
    const viewerRooms = [...reporters.map(({ id }) => id), bystander.id];
    expect(updates.filter(({ room }) => room !== requester.id).map(({ room }) => room).sort()).toEqual(viewerRooms.sort());
    updates
      .filter(({ room }) => room !== requester.id)
      .forEach(({ payload }) => expect(payload).toEqual({ requestId, status: 'cancelled', reason: 'reported' }));
    expect(updates.some(({ room }) => room === incompatible.id)).toBe(false);
    // No payload names or identifies a reporter
    const payloadsText = JSON.stringify(updates.map(({ payload }) => payload));
    reporters.forEach((reporter) => {
      expect(payloadsText).not.toContain(reporter.id);
      expect(payloadsText).not.toContain(reporter.name);
    });

    // Gone from every list, closed on its public page, and closed to accepts
    expect(await incomingIds(bystander)).toEqual([]);
    expect((await request(server).get(`/api/public/requests/${shareToken}`)).body).toEqual({ state: 'closed' });
    const accept = await patchStatus(bystander, bloodRequest._id, 'accepted');
    expect(accept.statusCode).toBe(409);

    // The requester's own lists say why, and nothing about who
    const mine = await asUser(requester, 'get', '/api/requests/mine');
    expect(mine.body.requests[0]).toMatchObject({ _id: requestId, status: 'cancelled', closedReason: 'reported' });
    const history = await asUser(requester, 'get', '/api/users/history');
    const requesterSees = JSON.stringify([mine.body, history.body]);
    reporters.forEach((reporter) => {
      expect(requesterSees).not.toContain(reporter.id);
      expect(requesterSees).not.toContain(reporter.name);
    });
    expect(requesterSees).not.toContain('Ann says fake');
    expect(requesterSees).not.toContain('declinedBy');
  });

  it('counts each user once: one user reporting three times leaves it open', async () => {
    const requester = await registerRequester();
    const reporter = await registerUser();
    const secondReporter = await registerUser({ location: ALSO_NEARBY });
    const bloodRequest = await createBloodRequest(requester.id);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await reportRequest(reporter, bloodRequest._id);
    }
    await reportRequest(secondReporter, bloodRequest._id);

    expect(await Report.countDocuments()).toBe(2);
    expect((await storedRequest(bloodRequest)).status).toBe('pending');
  });

  it('closes it exactly once when the reports arrive at the same moment', async () => {
    const requester = await registerRequester();
    const reporters = [];
    for (let index = 0; index < 6; index += 1) {
      reporters.push(await registerUser({ location: index % 2 ? NEARBY : ALSO_NEARBY }));
    }

    // Exactly the number needed, then more than it, each sent all at once
    for (const reporterCount of [3, 6]) {
      const bloodRequest = await createBloodRequest(requester.id);
      const socket = spyOnSocket();

      const answers = await Promise.all(
        reporters.slice(0, reporterCount).map((reporter) => reportRequest(reporter, bloodRequest._id))
      );

      expect(answers.map((res) => res.statusCode)).toEqual(Array(reporterCount).fill(201));
      expect(await Report.countDocuments({ requestId: bloodRequest._id })).toBe(reporterCount);
      expect(await storedRequest(bloodRequest)).toMatchObject({ status: 'cancelled', closedReason: 'reported' });
      const closeEvents = socket
        .statusUpdates()
        .filter(({ room, payload }) => room === requester.id && payload.reason === 'reported');
      expect(closeEvents).toHaveLength(1);
      jest.restoreAllMocks();
      jest.spyOn(console, 'warn').mockImplementation(() => {});
    }
  });

  it('stores reports on an accepted, fulfilled or cancelled request without closing it', async () => {
    const requester = await registerRequester();
    const donor = await registerUser({ name: 'Dana Donor' });
    const viewers = [await registerUser(), await registerUser({ location: ALSO_NEARBY })];
    const accepted = await createBloodRequest(requester.id, { status: 'accepted', matchedDonorId: donor.id });
    const fulfilled = await createBloodRequest(requester.id, { status: 'fulfilled', matchedDonorId: donor.id, fulfilledAt: new Date() });
    const cancelled = await createBloodRequest(requester.id, { status: 'cancelled' });
    const socket = spyOnSocket();

    for (const bloodRequest of [accepted, fulfilled, cancelled]) {
      const reporters = bloodRequest === cancelled ? [...viewers, await registerUser()] : [donor, ...viewers];
      for (const reporter of reporters) {
        expect((await reportRequest(reporter, bloodRequest._id)).statusCode).toBe(201);
      }
      expect(await Report.countDocuments({ requestId: bloodRequest._id })).toBe(3);
    }

    expect(await storedRequest(accepted)).toMatchObject({ status: 'accepted' });
    expect(await storedRequest(fulfilled)).toMatchObject({ status: 'fulfilled' });
    const storedCancelled = await storedRequest(cancelled);
    expect(storedCancelled.status).toBe('cancelled');
    expect(storedCancelled).not.toHaveProperty('closedReason');
    expect(socket.statusUpdates()).toEqual([]);
  });

  it('leaves a request already past its open hours to expire, not to the reports', async () => {
    const requester = await registerRequester();
    const reporters = [await registerUser(), await registerUser(), await registerUser({ location: ALSO_NEARBY })];
    // Older than the request, so only its open hours keep these reports from closing it
    await setAccountsCreatedAt(reporters, new Date(Date.now() - 30 * DAY_MS));
    const bloodRequest = await createBloodRequest(requester.id, { ageMs: 49 * HOUR_MS });

    for (const reporter of reporters) {
      expect((await reportRequest(reporter, bloodRequest._id)).statusCode).toBe(201);
    }

    expect((await storedRequest(bloodRequest)).closedReason).not.toBe('reported');
  });
});

describe('only accounts made before the request count toward closing it', () => {
  it('3 accounts made after it was posted do not close it, though each report is stored and hides it', async () => {
    const requester = await registerRequester();
    const bloodRequest = await createBloodRequest(requester.id, { ageMs: HOUR_MS });
    const newcomers = [await registerUser(), await registerUser(), await registerUser({ location: ALSO_NEARBY })];

    for (const newcomer of newcomers) {
      expect((await reportRequest(newcomer, bloodRequest._id)).statusCode).toBe(201);
    }

    expect(await Report.countDocuments({ requestId: bloodRequest._id })).toBe(3);
    const stored = await storedRequest(bloodRequest);
    expect(stored.status).toBe('pending');
    expect(stored.declinedBy.map(String).sort()).toEqual(newcomers.map(({ id }) => id).sort());
    for (const newcomer of newcomers) {
      expect(await incomingIds(newcomer)).toEqual([]);
    }
  });

  it('3 accounts made before it was posted close it', async () => {
    const requester = await registerRequester();
    const bloodRequest = await createBloodRequest(requester.id, { ageMs: HOUR_MS });
    const regulars = [await registerUser(), await registerUser(), await registerUser({ location: ALSO_NEARBY })];
    await setAccountsCreatedAt(regulars, new Date(Date.now() - 30 * DAY_MS));

    for (const regular of regulars) {
      expect((await reportRequest(regular, bloodRequest._id)).statusCode).toBe(201);
    }

    expect(await storedRequest(bloodRequest)).toMatchObject({ status: 'cancelled', closedReason: 'reported' });
  });

  it('2 older accounts and 1 newer do not close it, and a third older one then does', async () => {
    const requester = await registerRequester();
    const bloodRequest = await createBloodRequest(requester.id, { ageMs: HOUR_MS });
    const older = [await registerUser(), await registerUser({ location: ALSO_NEARBY }), await registerUser()];
    const newer = await registerUser();
    await setAccountsCreatedAt(older, new Date(Date.now() - 30 * DAY_MS));

    for (const reporter of [older[0], older[1], newer]) {
      expect((await reportRequest(reporter, bloodRequest._id)).statusCode).toBe(201);
    }
    expect((await storedRequest(bloodRequest)).status).toBe('pending');

    expect((await reportRequest(older[2], bloodRequest._id)).statusCode).toBe(201);
    expect(await storedRequest(bloodRequest)).toMatchObject({ status: 'cancelled', closedReason: 'reported' });
  });
});

describe('POST /api/requests/:id/report-user', () => {
  it('lets the requester report their matched donor (201): stored only, and the match goes on', async () => {
    const requester = await registerRequester();
    const donor = await registerUser({ name: 'Dana Donor' });
    const bloodRequest = await createBloodRequest(requester.id, { status: 'accepted', matchedDonorId: donor.id });
    const socket = spyOnSocket();

    const res = await reportUser(requester, bloodRequest._id, { reason: 'abusive', note: 'Rude on chat', alsoBlock: false });

    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ message: 'Thank you. Your report has been sent.', blocked: false, endedMatch: false });
    const report = await Report.findOne().lean();
    expect(report).toMatchObject({ kind: 'user', reason: 'abusive', note: 'Rude on chat' });
    expect(String(report.reporterId)).toBe(requester.id);
    expect(String(report.reportedUserId)).toBe(donor.id);
    expect(String(report.requestId)).toBe(String(bloodRequest._id));
    expect(await Block.countDocuments()).toBe(0);
    expect(await storedRequest(bloodRequest)).toMatchObject({ status: 'accepted' });
    expect(socket.statusUpdates()).toEqual([]);
  });

  it('lets the matched donor report the requester and block them in one go, which ends the match', async () => {
    const requester = await registerRequester();
    const donor = await registerUser({ name: 'Dana Donor' });
    const bloodRequest = await createBloodRequest(requester.id, { status: 'accepted', matchedDonorId: donor.id });

    const res = await reportUser(donor, bloodRequest._id, { reason: 'fake', alsoBlock: true });

    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ message: 'Thank you. Your report has been sent. They are blocked.', blocked: true, endedMatch: true });
    expect(await Report.countDocuments({ kind: 'user', reporterId: donor.id, reportedUserId: requester.id })).toBe(1);
    expect(await Block.countDocuments({ blockerId: donor.id, blockedId: requester.id })).toBe(1);
    const stored = await storedRequest(bloodRequest);
    expect(stored).toMatchObject({ status: 'pending', matchedDonorId: null });
    expect(stored.declinedBy.map(String)).toEqual([donor.id]);
  });

  it('refuses anyone but the two matched people (403), and a request with no donor yet (409)', async () => {
    const requester = await registerRequester();
    const donor = await registerUser();
    const viewer = await registerUser({ location: ALSO_NEARBY });
    const accepted = await createBloodRequest(requester.id, { status: 'accepted', matchedDonorId: donor.id });
    const pending = await createBloodRequest(requester.id);

    const byViewer = await reportUser(viewer, accepted._id);
    const onPending = await reportUser(requester, pending._id);
    const viewerOnPending = await reportUser(viewer, pending._id);

    expect(byViewer.statusCode).toBe(403);
    expect(byViewer.body).toEqual({ message: 'You can only report the person you were matched with on this request' });
    expect(onPending.statusCode).toBe(409);
    expect(onPending.body).toEqual({ message: 'This request has no donor to report' });
    expect(viewerOnPending.statusCode).toBe(403);
    expect(await Report.countDocuments()).toBe(0);
  });

  it('answers a second report about the same person 200, whichever request it comes from', async () => {
    const requester = await registerRequester();
    const donor = await registerUser();
    const earlier = await createBloodRequest(requester.id, { status: 'fulfilled', matchedDonorId: donor.id, fulfilledAt: new Date() });
    const current = await createBloodRequest(requester.id, { status: 'accepted', matchedDonorId: donor.id });

    const first = await reportUser(requester, earlier._id, { reason: 'abusive' });
    const second = await reportUser(requester, current._id, { reason: 'spam' });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.body.message).toBe('You have already reported this person.');
    expect(await Report.countDocuments()).toBe(1);
  });

  it('refuses an alsoBlock that is not true or false (400)', async () => {
    const requester = await registerRequester();
    const donor = await registerUser();
    const bloodRequest = await createBloodRequest(requester.id, { status: 'accepted', matchedDonorId: donor.id });

    const res = await reportUser(requester, bloodRequest._id, { reason: 'spam', alsoBlock: 'yes' });

    expect(res.statusCode).toBe(400);
    expect(await Report.countDocuments()).toBe(0);
    expect(await Block.countDocuments()).toBe(0);
  });
});

describe('a block: the two are never matched, both ways', () => {
  it('a donor who blocks a requester from their incoming list sees none of their requests, gets no alert, and neither can accept the other', async () => {
    // O- at the hospital: the requester can donate too, so both directions can be checked
    const requester = await withPush(await registerUser({ name: 'Rita Requester', bloodGroup: 'O-', location: HOSPITAL }));
    const donor = await withPush(await registerUser({ name: 'Dana Donor' }));
    const otherDonor = await withPush(await registerUser({ name: 'Omar Other', location: ALSO_NEARBY }));
    const first = await createBloodRequest(requester.id);
    const second = await createBloodRequest(requester.id, { hospitalName: 'Second Hospital' });
    expect((await incomingIds(donor)).sort()).toEqual([String(first._id), String(second._id)].sort());

    const res = await blockOn(donor, first._id);

    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ message: 'Blocked', endedMatch: false });
    expect(await Block.countDocuments({ blockerId: donor.id, blockedId: requester.id })).toBe(1);

    // Incoming list: none of the requester's, and the requester sees none of the donor's
    expect(await incomingIds(donor)).toEqual([]);
    const donorsRequest = await createBloodRequest(donor.id, { hospitalName: 'Donor Asks Hospital' });
    expect(await incomingIds(requester)).not.toContain(String(donorsRequest._id));
    expect(await incomingIds(otherDonor)).toContain(String(donorsRequest._id));

    // Alerts and the count: a new request of the requester reaches the other donor only
    const socket = spyOnSocket();
    const created = await createViaApi(requester);
    expect(created.statusCode).toBe(201);
    expect(created.body.matchedDonorCount).toBe(1);
    expect(socket.alertedRooms()).toEqual([otherDonor.id]);
    expect(pushedUserIds()).toEqual([otherDonor.id]);
    // And a new request of the donor never reaches the requester
    webpush.sendNotification.mockClear();
    const donorCreated = await createViaApi(donor);
    expect(donorCreated.statusCode).toBe(201);
    expect(socket.alertedRooms()).not.toContain(requester.id);
    expect(pushedUserIds()).toEqual([otherDonor.id]);

    // Accept refused at the server, in both directions, without a word about blocking
    const donorAccepts = await patchStatus(donor, first._id, 'accepted');
    const requesterAccepts = await patchStatus(requester, donorsRequest._id, 'accepted');
    for (const refusal of [donorAccepts, requesterAccepts]) {
      expect(refusal.statusCode).toBe(409);
      expect(refusal.body).toEqual({ message: 'This request is no longer available' });
    }
    expect(await storedRequest(first)).toMatchObject({ status: 'pending', matchedDonorId: null });
    expect(await storedRequest(donorsRequest)).toMatchObject({ status: 'pending', matchedDonorId: null });
  });

  it('refuses an accept written after the block was read: the accept is undone and the requester never hears of it', async () => {
    const requester = await registerRequester();
    const donor = await registerUser();
    const bloodRequest = await createBloodRequest(requester.id);
    await Block.create({ blockerId: requester.id, blockedId: donor.id });
    // acceptRequest's read of the blocks sees none, as if the block were written just after it
    const realFind = Block.find.bind(Block);
    jest.spyOn(Block, 'find').mockImplementationOnce((...args) => {
      const query = realFind(...args);
      query.exec = async () => [];
      return query;
    });
    const socket = spyOnSocket();

    const res = await patchStatus(donor, bloodRequest._id, 'accepted');

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ message: 'This request is no longer available' });
    expect(await storedRequest(bloodRequest)).toMatchObject({ status: 'pending', matchedDonorId: null });
    expect(socket.statusUpdates()).toEqual([]);
  });

  it('keeps the blocked person out of the blocker list and every answer they get', async () => {
    const requester = await registerRequester();
    const donor = await registerUser();
    const bloodRequest = await createBloodRequest(requester.id);

    await blockOn(donor, bloodRequest._id);

    const requesterBlocks = await listBlocks(requester);
    expect(requesterBlocks.body).toEqual({ blockedUsers: [] });
    const mine = await asUser(requester, 'get', '/api/requests/mine');
    expect(JSON.stringify(mine.body)).not.toContain(donor.id);
  });

  it('answers a repeat block 200, refuses a stranger (403), and a requester with no donor to block (409)', async () => {
    const requester = await registerRequester();
    const donor = await registerUser();
    const stranger = await registerUser({ bloodGroup: 'A+' });
    const bloodRequest = await createBloodRequest(requester.id);

    expect((await blockOn(donor, bloodRequest._id)).statusCode).toBe(201);
    const repeat = await blockOn(donor, bloodRequest._id);
    const byStranger = await blockOn(stranger, bloodRequest._id);
    const byRequester = await blockOn(requester, bloodRequest._id);

    expect(repeat.statusCode).toBe(200);
    expect(repeat.body).toEqual({ message: 'Already blocked', endedMatch: false });
    expect(byStranger.statusCode).toBe(403);
    expect(byRequester.statusCode).toBe(409);
    expect(byRequester.body).toEqual({ message: 'This request has no donor to block' });
    expect(await Block.countDocuments()).toBe(1);
  });
});

describe('a block during an accepted request between the two', () => {
  it('requester blocks the donor: back to pending with the donor declined, the chat ends, and the donor is told only that it is no longer theirs', async () => {
    const requester = await registerRequester();
    const donor = await withPush(await registerUser({ name: 'Dana Donor' }));
    const nextDonor = await withPush(await registerUser({ name: 'Nina Next', location: ALSO_NEARBY }));
    const bloodRequest = await createBloodRequest(requester.id, { status: 'accepted', matchedDonorId: donor.id });
    await Message.create({ senderId: donor.id, receiverId: requester.id, requestId: bloodRequest._id, text: 'On my way' });
    const socket = spyOnSocket();

    const res = await blockOn(requester, bloodRequest._id);

    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ message: 'Blocked', endedMatch: true });
    const stored = await storedRequest(bloodRequest);
    expect(stored).toMatchObject({ status: 'pending', matchedDonorId: null });
    expect(stored.declinedBy.map(String)).toEqual([donor.id]);

    const requestId = String(bloodRequest._id);
    expect(socket.statusUpdates()).toEqual([
      { room: donor.id, payload: { requestId, status: 'cancelled', reason: 'match_ended' } },
      { room: requester.id, payload: { requestId, status: 'pending', reason: 'blocked' } },
    ]);

    // The chat is over for both of them, as when any match ends
    expect((await asUser(donor, 'get', `/api/messages/${requestId}`)).statusCode).toBe(403);
    expect((await asUser(requester, 'post', `/api/messages/send/${requestId}`).send({ text: 'hi' })).statusCode).toBe(403);

    // Open to other donors again: announced to them after the answer, never to the blocked donor
    await waitUntil(async () => socket.alertedRooms().length > 0);
    await delay(SILENCE_WINDOW_MS);
    expect(socket.alertedRooms()).toEqual([nextDonor.id]);
    expect(pushedUserIds()).toEqual([nextDonor.id]);
    expect(await incomingIds(donor)).toEqual([]);
    expect(await incomingIds(nextDonor)).toEqual([requestId]);
    // And the donor cannot take it back
    expect((await patchStatus(donor, requestId, 'accepted')).statusCode).toBe(409);
  });

  it('donor blocks the requester: treated as the donor withdrawing, and the requester is not told why', async () => {
    const requester = await registerRequester();
    const donor = await registerUser({ name: 'Dana Donor' });
    const nextDonor = await registerUser({ name: 'Nina Next', location: ALSO_NEARBY });
    const bloodRequest = await createBloodRequest(requester.id, { status: 'accepted', matchedDonorId: donor.id });
    const socket = spyOnSocket();

    const res = await blockOn(donor, bloodRequest._id);

    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ message: 'Blocked', endedMatch: true });
    const stored = await storedRequest(bloodRequest);
    expect(stored).toMatchObject({ status: 'pending', matchedDonorId: null });
    expect(stored.declinedBy.map(String)).toEqual([donor.id]);

    const requestId = String(bloodRequest._id);
    expect(socket.statusUpdates()).toEqual([
      { room: donor.id, payload: { requestId, status: 'cancelled', reason: 'blocked' } },
      { room: requester.id, payload: { requestId, status: 'pending', reason: 'donor_withdrew' } },
    ]);
    await waitUntil(async () => socket.alertedRooms().length > 0);
    await delay(SILENCE_WINDOW_MS);
    expect(socket.alertedRooms()).toEqual([nextDonor.id]);
    // The donor is free to accept other requests
    const otherRequest = await createBloodRequest((await registerRequester('Second Requester')).id);
    expect((await patchStatus(donor, otherRequest._id, 'accepted')).statusCode).toBe(200);
  });

  it('closes a reopened request that already has enough reports, instead of announcing it to donors again, and tells its requester only that', async () => {
    const requester = await registerRequester();
    const donor = await registerUser({ name: 'Dana Donor' });
    const viewers = [await registerUser(), await registerUser({ location: ALSO_NEARBY })];
    const bystander = await registerUser({ name: 'Bea Bystander', location: ALSO_NEARBY });
    const bloodRequest = await createBloodRequest(requester.id, { status: 'accepted', matchedDonorId: donor.id });
    // Reports while it is accepted are only stored
    for (const reporter of [donor, ...viewers]) {
      expect((await reportRequest(reporter, bloodRequest._id)).statusCode).toBe(201);
    }
    expect(await storedRequest(bloodRequest)).toMatchObject({ status: 'accepted' });
    const socket = spyOnSocket();

    expect((await blockOn(donor, bloodRequest._id)).statusCode).toBe(201);

    // Closed before the answer
    expect(await storedRequest(bloodRequest)).toMatchObject({ status: 'cancelled', closedReason: 'reported' });
    await delay(SILENCE_WINDOW_MS);
    expect(socket.alertedRooms()).toEqual([]);
    expect(await incomingIds(bystander)).toEqual([]);
    // Never "open to donors again" first: that would not be true for a moment
    const toRequester = socket.statusUpdates().filter(({ room }) => room === requester.id).map(({ payload }) => payload);
    expect(toRequester).toEqual([
      { requestId: String(bloodRequest._id), status: 'cancelled', reason: 'reported', hospitalName: 'Safety Test Hospital' },
    ]);
    // The donor who blocked hears only that it is no longer theirs, as with any block
    const toDonor = socket.statusUpdates().filter(({ room }) => room === donor.id).map(({ payload }) => payload.reason);
    expect(toDonor).toEqual(['blocked']);
  });

  it('closes a reported request the requester reopened by blocking its donor, and their other tabs hear only that', async () => {
    const requester = await registerRequester();
    const donor = await registerUser({ name: 'Dana Donor' });
    const viewers = [await registerUser(), await registerUser(), await registerUser({ location: ALSO_NEARBY })];
    const bloodRequest = await createBloodRequest(requester.id, { status: 'accepted', matchedDonorId: donor.id });
    for (const reporter of viewers) {
      expect((await reportRequest(reporter, bloodRequest._id)).statusCode).toBe(201);
    }
    const socket = spyOnSocket();

    const res = await blockOn(requester, bloodRequest._id);

    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ message: 'Blocked', endedMatch: true });
    expect(await storedRequest(bloodRequest)).toMatchObject({ status: 'cancelled', closedReason: 'reported' });
    await delay(SILENCE_WINDOW_MS);
    expect(socket.alertedRooms()).toEqual([]);
    const requestId = String(bloodRequest._id);
    const toRequester = socket.statusUpdates().filter(({ room }) => room === requester.id).map(({ payload }) => payload);
    expect(toRequester).toEqual([{ requestId, status: 'cancelled', reason: 'reported', hospitalName: 'Safety Test Hospital' }]);
    // The blocked donor is told the match ended, and nothing about the reports
    const toDonor = socket.statusUpdates().filter(({ room }) => room === donor.id).map(({ payload }) => payload);
    expect(toDonor).toEqual([{ requestId, status: 'cancelled', reason: 'match_ended' }]);
  });

  it('still says it is open again when the reports check fails, and closes it after the answer instead', async () => {
    const requester = await registerRequester();
    const donor = await registerUser({ name: 'Dana Donor' });
    const viewers = [await registerUser(), await registerUser(), await registerUser({ location: ALSO_NEARBY })];
    const bloodRequest = await createBloodRequest(requester.id, { status: 'accepted', matchedDonorId: donor.id });
    for (const reporter of viewers) {
      expect((await reportRequest(reporter, bloodRequest._id)).statusCode).toBe(201);
    }
    // The first count of reporters is the check before the requester is told
    jest.spyOn(Report, 'distinct').mockRejectedValueOnce(new Error('forced reports failure'));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const socket = spyOnSocket();

    expect((await blockOn(donor, bloodRequest._id)).statusCode).toBe(201);

    expect(consoleError).toHaveBeenCalledWith(
      `block: failed to check the reports on reopened request ${bloodRequest._id}:`,
      'forced reports failure'
    );
    await waitUntil(async () => (await storedRequest(bloodRequest)).status === 'cancelled');
    expect(await storedRequest(bloodRequest)).toMatchObject({ status: 'cancelled', closedReason: 'reported' });
    await delay(SILENCE_WINDOW_MS);
    expect(socket.alertedRooms()).toEqual([]);
    const toRequester = socket.statusUpdates().filter(({ room }) => room === requester.id).map(({ payload }) => payload.reason);
    expect(toRequester).toEqual(['donor_withdrew', 'reported']);
  });

  it('closes a reopened request already past its open hours as expired, without first saying it is open', async () => {
    const requester = await registerRequester();
    const donor = await registerUser();
    const bloodRequest = await createBloodRequest(requester.id, { status: 'accepted', matchedDonorId: donor.id, ageMs: 50 * HOUR_MS });
    const socket = spyOnSocket();

    expect((await blockOn(donor, bloodRequest._id)).statusCode).toBe(201);

    await waitUntil(async () => (await storedRequest(bloodRequest)).status === 'cancelled');
    expect(await storedRequest(bloodRequest)).toMatchObject({ status: 'cancelled', closedReason: 'expired' });
    const toRequester = socket.statusUpdates().filter(({ room }) => room === requester.id).map(({ payload }) => payload);
    expect(toRequester).toEqual([expect.objectContaining({ status: 'cancelled', reason: 'expired' })]);
    expect(socket.alertedRooms()).toEqual([]);
  });

  it('leaves a request fulfilled before the block as it was', async () => {
    const requester = await registerRequester();
    const donor = await registerUser();
    const fulfilledAt = new Date();
    const bloodRequest = await createBloodRequest(requester.id, { status: 'fulfilled', matchedDonorId: donor.id, fulfilledAt });

    const res = await blockOn(requester, bloodRequest._id);

    expect(res.statusCode).toBe(201);
    expect(res.body.endedMatch).toBe(false);
    const stored = await storedRequest(bloodRequest);
    expect(stored).toMatchObject({ status: 'fulfilled', fulfilledAt });
    expect(String(stored.matchedDonorId)).toBe(donor.id);
  });
});

describe('the Blocked users list and unblocking', () => {
  it('lists the people you blocked, newest first, by first name and date only', async () => {
    const donor = await registerUser({ name: 'Dana Donor' });
    const first = await registerRequester('Rita Sharma Requester');
    const second = await registerRequester('Mohan   Lal');
    await blockOn(donor, (await createBloodRequest(first.id))._id);
    await blockOn(donor, (await createBloodRequest(second.id))._id);

    const res = await listBlocks(donor);

    expect(res.statusCode).toBe(200);
    expect(res.body.blockedUsers.map(({ name }) => name)).toEqual(['Mohan', 'Rita']);
    res.body.blockedUsers.forEach((entry) => {
      expect(Object.keys(entry).sort()).toEqual(['_id', 'blockedAt', 'name']);
      expect(new Date(entry.blockedAt).getTime()).toBeLessThanOrEqual(Date.now());
    });
    // Each _id is the block's own, never the person's
    expect(JSON.stringify(res.body)).not.toContain(first.id);
    expect(JSON.stringify(res.body)).not.toContain(second.id);
  });

  it('starts empty', async () => {
    const user = await registerUser();
    expect((await listBlocks(user)).body).toEqual({ blockedUsers: [] });
  });

  it('unblocks (200): matched again for new requests, while a request the block reopened stays declined', async () => {
    const requester = await registerRequester();
    const donor = await registerUser();
    const reopened = await createBloodRequest(requester.id, { status: 'accepted', matchedDonorId: donor.id });
    const open = await createBloodRequest(requester.id, { hospitalName: 'Open Hospital' });
    await blockOn(requester, reopened._id);
    expect(await incomingIds(donor)).toEqual([]);
    const [{ _id: blockId }] = (await listBlocks(requester)).body.blockedUsers;

    const res = await unblock(requester, blockId);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ message: 'Unblocked' });
    expect(await Block.countDocuments()).toBe(0);
    expect((await listBlocks(requester)).body).toEqual({ blockedUsers: [] });
    expect(await incomingIds(donor)).toEqual([String(open._id)]);
    expect((await patchStatus(donor, open._id, 'accepted')).statusCode).toBe(200);
  });

  it("refuses someone else's block (404, and it stays), an unknown one (404) and a malformed id (400)", async () => {
    const requester = await registerRequester();
    const donor = await registerUser();
    const intruder = await registerUser();
    await blockOn(donor, (await createBloodRequest(requester.id))._id);
    const blockId = String((await Block.findOne().lean())._id);

    const byIntruder = await unblock(intruder, blockId);
    const unknown = await unblock(donor, new mongoose.Types.ObjectId().toString());
    const malformed = await unblock(donor, 'not-an-id');
    const anonymous = await request(server).delete(`/api/users/blocks/${blockId}`);

    expect(byIntruder.statusCode).toBe(404);
    expect(byIntruder.body).toEqual({ message: 'Block not found' });
    expect(unknown.statusCode).toBe(404);
    expect(malformed.statusCode).toBe(400);
    expect(malformed.body).toEqual({ message: 'Invalid block id' });
    expect(anonymous.statusCode).toBe(401);
    expect(await Block.countDocuments()).toBe(1);
  });
});

describe('limits', () => {
  // Blocks of made-up users, written directly: only the count matters to the limit
  const fillBlocks = (blockerId, count) =>
    Block.insertMany(
      Array.from({ length: count }, () => ({ blockerId, blockedId: new mongoose.Types.ObjectId() }))
    );

  it(`refuses a block past ${MAX_BLOCKS_PER_USER} (409) and keeps the count there`, async () => {
    const requester = await registerRequester();
    const donor = await registerUser();
    await fillBlocks(donor.id, MAX_BLOCKS_PER_USER);
    const bloodRequest = await createBloodRequest(requester.id);

    const res = await blockOn(donor, bloodRequest._id);

    expect(res.statusCode).toBe(409);
    expect(res.body.message).toMatch(/You have blocked 200 people/);
    expect(await Block.countDocuments({ blockerId: donor.id })).toBe(MAX_BLOCKS_PER_USER);
    expect(await incomingIds(donor)).toEqual([String(bloodRequest._id)]);
  });

  it('never goes past the limit when several blocks are sent at once at its edge', async () => {
    const donor = await registerUser();
    await fillBlocks(donor.id, MAX_BLOCKS_PER_USER - 1);
    const requests = [];
    for (let index = 0; index < 4; index += 1) {
      requests.push(await createBloodRequest((await registerRequester(`Requester ${index}`)).id));
    }

    const answers = await Promise.all(requests.map((bloodRequest) => blockOn(donor, bloodRequest._id)));

    answers.forEach((res) => expect([201, 409]).toContain(res.statusCode));
    const blockCount = await Block.countDocuments({ blockerId: donor.id });
    expect(blockCount).toBeLessThanOrEqual(MAX_BLOCKS_PER_USER);
    expect(blockCount).toBe(MAX_BLOCKS_PER_USER - 1 + answers.filter((res) => res.statusCode === 201).length);
  });

  it('limits reports to 10 an hour per user (429)', async () => {
    const requester = await registerRequester();
    const reporter = await registerUser();
    const otherReporter = await registerUser();
    const bloodRequest = await createBloodRequest(requester.id);

    const codes = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      codes.push((await reportRequest(reporter, bloodRequest._id)).statusCode);
    }

    expect(codes).toEqual([201, ...Array(9).fill(200), 429]);
    expect((await reportUser(reporter, bloodRequest._id)).statusCode).toBe(429);
    // Per user: someone else can still report
    expect((await reportRequest(otherReporter, bloodRequest._id)).statusCode).toBe(201);
  });

  it('limits blocks and unblocks to 20 every 15 minutes per user (429)', async () => {
    const requester = await registerRequester();
    const donor = await registerUser();
    const bloodRequest = await createBloodRequest(requester.id);

    const codes = [];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      codes.push((await unblock(donor, new mongoose.Types.ObjectId().toString())).statusCode);
    }
    const block = await blockOn(donor, bloodRequest._id);

    expect(codes).toEqual(Array(20).fill(404));
    expect(block.statusCode).toBe(429);
    expect(await Block.countDocuments()).toBe(0);
  });
});

describe('account deletion and blocks or reports', () => {
  const deleteAccount = (user) => asUser(user, 'delete', '/api/users/me').send({ password: PASSWORD });

  it('deletes the blocks made by and against the user, and the reports made by and about them, and nobody else\'s', async () => {
    const leaver = await registerUser({ name: 'Leela Leaver', bloodGroup: 'O-', location: HOSPITAL });
    const anil = await registerUser({ name: 'Anil' });
    const bina = await registerUser({ name: 'Bina' });
    const ravi = await registerRequester('Ravi');
    const leaverRequest = await createBloodRequest(leaver.id);
    const raviRequest = await createBloodRequest(ravi.id);
    const raviAccepted = await createBloodRequest(ravi.id, { status: 'accepted', matchedDonorId: anil.id });

    await Block.create([
      { blockerId: leaver.id, blockedId: anil.id },
      { blockerId: bina.id, blockedId: leaver.id },
      { blockerId: anil.id, blockedId: bina.id },
    ]);
    await Report.create([
      // By the leaver, and about the leaver or their request
      { kind: 'request', reporterId: leaver.id, reportedUserId: ravi.id, requestId: raviRequest._id, reason: 'spam' },
      { kind: 'request', reporterId: anil.id, reportedUserId: leaver.id, requestId: leaverRequest._id, reason: 'fake' },
      { kind: 'user', reporterId: bina.id, reportedUserId: leaver.id, requestId: leaverRequest._id, reason: 'abusive' },
      // Nothing to do with the leaver
      { kind: 'request', reporterId: anil.id, reportedUserId: ravi.id, requestId: raviRequest._id, reason: 'spam' },
      { kind: 'user', reporterId: ravi.id, reportedUserId: anil.id, requestId: raviAccepted._id, reason: 'other' },
    ]);

    const res = await deleteAccount(leaver);

    expect(res.statusCode).toBe(200);
    const blocks = await Block.find().lean();
    expect(blocks.map(({ blockerId, blockedId }) => [String(blockerId), String(blockedId)])).toEqual([[anil.id, bina.id]]);
    const reports = await Report.find().lean();
    expect(reports.map(({ reporterId, reportedUserId }) => `${reporterId}>${reportedUserId}`).sort()).toEqual(
      [`${anil.id}>${ravi.id}`, `${ravi.id}>${anil.id}`].sort()
    );
    const leftovers = JSON.stringify([
      await Block.collection.find({}).toArray(),
      await Report.collection.find({}).toArray(),
    ]);
    expect(leftovers).not.toContain(leaver.id);
  });

  it("closes a reported request that the deleted donor had accepted, and tells its requester only that", async () => {
    const requester = await registerRequester();
    const leaver = await registerUser({ name: 'Leela Leaver' });
    const viewers = [await registerUser(), await registerUser(), await registerUser({ location: ALSO_NEARBY })];
    const bystander = await registerUser({ name: 'Bea Bystander', location: ALSO_NEARBY });
    const bloodRequest = await createBloodRequest(requester.id, { status: 'accepted', matchedDonorId: leaver.id });
    // The leaver's own reports go with their account, so these three are the ones that count
    for (const reporter of viewers) {
      expect((await reportRequest(reporter, bloodRequest._id)).statusCode).toBe(201);
    }
    const socket = spyOnSocket();

    expect((await deleteAccount(leaver)).statusCode).toBe(200);

    // Closed before the answer
    expect(await storedRequest(bloodRequest)).toMatchObject({ status: 'cancelled', closedReason: 'reported', matchedDonorId: null });
    await delay(SILENCE_WINDOW_MS);
    expect(socket.alertedRooms()).toEqual([]);
    expect(await incomingIds(bystander)).toEqual([]);
    // Never "your donor deleted their account, open to donors again" first
    const toRequester = socket.statusUpdates().filter(({ room }) => room === requester.id).map(({ payload }) => payload);
    expect(toRequester).toEqual([
      { requestId: String(bloodRequest._id), status: 'cancelled', reason: 'reported', hospitalName: 'Safety Test Hospital' },
    ]);
  });

  it('removes a block written after the blocker was deleted (401)', async () => {
    const requester = await registerRequester();
    const leaver = await registerUser({ name: 'Leela Leaver' });
    const bloodRequest = await createBloodRequest(requester.id);
    let deletionRes;
    // After blockFromRequest has read the request, before it writes the block
    runOnceAfterNextRead(Request, 'findById', async () => {
      deletionRes = await deleteAccount(leaver);
    });

    const res = await blockOn(leaver, bloodRequest._id);

    expect(deletionRes.statusCode).toBe(200);
    expect(res.statusCode).toBe(401);
    expect(await Block.countDocuments()).toBe(0);
  });

  it('removes a report written after the reported requester was deleted (404)', async () => {
    const leaver = await registerRequester('Leela Leaver');
    const donor = await registerUser();
    const bloodRequest = await createBloodRequest(leaver.id, { status: 'accepted', matchedDonorId: donor.id });
    let deletionRes;
    runOnceAfterNextRead(Request, 'findById', async () => {
      deletionRes = await deleteAccount(leaver);
    });

    const res = await reportRequest(donor, bloodRequest._id);

    expect(deletionRes.statusCode).toBe(200);
    expect(res.statusCode).toBe(404);
    expect(await Report.countDocuments()).toBe(0);
  });

  it('answers 409 and keeps neither report nor block when the reported person is deleted while "also block" runs', async () => {
    const leaver = await registerRequester('Leela Leaver');
    const donor = await registerUser();
    const bloodRequest = await createBloodRequest(leaver.id, { status: 'accepted', matchedDonorId: donor.id });
    let deletionRes;
    // After the report is written and checked, while the block counts the donor's blocks
    runOnceAfterNextRead(Block, 'countDocuments', async () => {
      deletionRes = await deleteAccount(leaver);
    });

    const res = await reportUser(donor, bloodRequest._id, { reason: 'abusive', alsoBlock: true });

    expect(deletionRes.statusCode).toBe(200);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ message: 'This person has deleted their account' });
    expect(await Report.countDocuments()).toBe(0);
    expect(await Block.countDocuments()).toBe(0);
  });

  it('removes a report written after the reporter was deleted (401), and their decline with it', async () => {
    const requester = await registerRequester();
    const leaver = await registerUser({ name: 'Leela Leaver' });
    const bloodRequest = await createBloodRequest(requester.id);
    let deletionRes;
    runOnceAfterNextRead(Request, 'findById', async () => {
      deletionRes = await deleteAccount(leaver);
    });

    const res = await reportRequest(leaver, bloodRequest._id);

    expect(deletionRes.statusCode).toBe(200);
    expect(res.statusCode).toBe(401);
    expect(await Report.countDocuments()).toBe(0);
    expect((await storedRequest(bloodRequest)).declinedBy).toEqual([]);
  });
});
