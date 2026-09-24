const request = require('supertest');
const jwt = require('jsonwebtoken');
const { io: ioClient } = require('socket.io-client');
// Mounts the routes on the app that lib/socket's server serves
require('../index');
const { io, server } = require('../lib/socket');
const Request = require('../models/request.model');
const User = require('../models/user.model');
const { connectDB, closeDB, clearDB } = require('./db');

// Coordinates are [longitude, latitude]
const HOSPITAL = [77.5946, 12.9716]; // Bangalore
const NEARBY = [77.6, 12.975]; // ~0.7 km from HOSPITAL

// Long enough for an event already emitted to arrive over loopback
const SILENCE_WINDOW_MS = 300;

let baseUrl;
let openClients = [];
let userCount = 0;

beforeAll(async () => {
  await connectDB();
  await Request.init();
  // The real Socket.io server from lib/socket.js, bound to 127.0.0.1 so no other local app
  // on the same ephemeral port can answer
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  // The server logs every rejection; keep the output clean but let tests read the messages
  jest.spyOn(console, 'warn').mockImplementation(() => {});
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
const registerUser = async ({ bloodGroup, location = NEARBY, name }) => {
  userCount += 1;
  const res = await request(server)
    .post('/api/auth/register')
    .send({
      name: name || `Socket User ${userCount}`,
      email: `socket-user${userCount}@example.com`,
      password: 'password123',
      bloodGroup,
      location,
    });
  expect(res.statusCode).toBe(201);
  const setCookie = res.headers['set-cookie'];
  return {
    id: res.body.user._id,
    name: res.body.user.name,
    cookie: setCookie,
    // Just "jwt=<token>", the form a browser sends in the Cookie header
    socketCookie: setCookie.find((value) => value.startsWith('jwt=')).split(';')[0],
  };
};

const createBloodRequest = (requesterId, overrides = {}) =>
  Request.create({
    requesterId,
    bloodGroup: 'B+',
    unitsNeeded: 2,
    hospitalName: 'Socket Test Hospital',
    hospitalLocation: { type: 'Point', coordinates: HOSPITAL },
    urgency: 'high',
    ...overrides,
  });

// forceNew: each client gets its own connection (io() otherwise shares one per URL).
// reconnection: false so a failed test can never leave a client retrying.
const connectClient = (cookieHeader, options = {}) => {
  const client = ioClient(baseUrl, {
    forceNew: true,
    reconnection: false,
    extraHeaders: cookieHeader ? { Cookie: cookieHeader } : {},
    ...options,
  });
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

// Records every event the client receives, whatever its name
const recordEvents = (client) => {
  const received = [];
  client.onAny((eventName, payload) => received.push({ eventName, payload }));
  return received;
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const expectRejected = async (client, expectedLog) => {
  await expect(waitForConnect(client)).rejects.toThrow('Unauthorized');
  // A middleware rejection leaves the client inactive: it does not retry on its own
  expect(client.connected).toBe(false);
  expect(client.active).toBe(false);
  expect(console.warn).toHaveBeenCalledWith(`socket auth rejected: ${expectedLog}`);
};

describe('Socket.io authentication', () => {
  it('rejects a connection with no cookie (Unauthorized)', async () => {
    await expectRejected(connectClient(null), 'no jwt cookie');
  });

  it('rejects a garbage token', async () => {
    await expectRejected(connectClient('jwt=not-a-real-token'), 'token verification failed: jwt malformed');
  });

  it('rejects a token signed with the wrong secret', async () => {
    const user = await registerUser({ bloodGroup: 'O+' });
    const forged = jwt.sign({ userId: user.id }, 'not-the-server-secret', { expiresIn: '1h' });
    await expectRejected(connectClient(`jwt=${forged}`), 'token verification failed: invalid signature');
  });

  it('rejects an expired token', async () => {
    const user = await registerUser({ bloodGroup: 'O+' });
    const expired = jwt.sign(
      { userId: user.id, exp: Math.floor(Date.now() / 1000) - 60 },
      process.env.JWT_SECRET
    );
    await expectRejected(connectClient(`jwt=${expired}`), 'token verification failed: jwt expired');
  });

  it('rejects a valid token for a user who has been deleted', async () => {
    const user = await registerUser({ bloodGroup: 'O+' });
    await User.deleteOne({ _id: user.id });
    await expectRejected(connectClient(user.socketCookie), "no user exists for the token's userId");
  });

  it("accepts a valid jwt cookie and joins only that user's room", async () => {
    const user = await registerUser({ bloodGroup: 'O+' });
    const client = connectClient(user.socketCookie);
    await waitForConnect(client);

    expect(client.connected).toBe(true);
    const [serverSocket] = await io.in(client.id).fetchSockets();
    expect(serverSocket.data.userId).toBe(user.id);
    // Its own id (socket.io's default room) and the user's room, nothing else
    expect([...serverSocket.rooms].sort()).toEqual([client.id, user.id].sort());
  });

  it("ignores a userId in the handshake query and auth payload: B never receives A's events", async () => {
    const requester = await registerUser({ name: 'Rita Requester', bloodGroup: 'B+', location: HOSPITAL });
    const acceptingDonor = await registerUser({ name: 'Omar Donor', bloodGroup: 'O-' });
    const userA = await registerUser({ name: 'Alice Target', bloodGroup: 'O-' });
    const userB = await registerUser({ name: 'Bob Attacker', bloodGroup: 'O-' });

    // A is the matched donor on one request (so gets chat messages) and the requester of
    // another (so gets the accept notification)
    const chatRequest = await createBloodRequest(requester.id, { status: 'accepted', matchedDonorId: userA.id });
    const requestByA = await createBloodRequest(userA.id);

    // A sends its own id the way the old client bundle did (a PWA can keep serving that bundle),
    // so the only difference between A and B is whose id each one claims
    const clientA = connectClient(userA.socketCookie, { query: { userId: userA.id } });
    // B's own valid cookie, plus A's id everywhere the old code (or a future one) might read it
    const clientB = connectClient(userB.socketCookie, {
      query: { userId: userA.id },
      auth: { userId: userA.id },
    });
    await Promise.all([waitForConnect(clientA), waitForConnect(clientB)]);
    const receivedByB = recordEvents(clientB);

    // Server side: A's room holds only A's socket
    const socketsInRoomA = await io.in(userA.id).fetchSockets();
    expect(socketsInRoomA.map((socket) => socket.id)).toEqual([clientA.id]);

    // Real event 1: the requester sends a chat message to A
    const messageForA = waitForEvent(clientA, 'newMessage');
    const sendRes = await request(server)
      .post(`/api/messages/send/${chatRequest._id}`)
      .set('Cookie', requester.cookie)
      .send({ text: 'Private: meet at gate 3' });
    expect(sendRes.statusCode).toBe(201);
    expect((await messageForA).text).toBe('Private: meet at gate 3');

    // Real event 2: a donor accepts A's request, which notifies the requester (A)
    const statusUpdateForA = waitForEvent(clientA, 'requestStatusUpdate');
    const acceptRes = await request(server)
      .patch(`/api/requests/${requestByA._id}/status`)
      .set('Cookie', acceptingDonor.cookie)
      .send({ status: 'accepted' });
    expect(acceptRes.statusCode).toBe(200);
    expect(await statusUpdateForA).toMatchObject({ status: 'accepted', donorName: 'Omar Donor' });

    await delay(SILENCE_WINDOW_MS);
    expect(receivedByB).toEqual([]);
  });

  it('disconnects the socket when its token expires', async () => {
    const user = await registerUser({ bloodGroup: 'O+' });
    const shortLived = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: 2 });
    const { exp } = jwt.decode(shortLived);

    const client = connectClient(`jwt=${shortLived}`);
    await waitForConnect(client);
    expect(client.connected).toBe(true);

    const reason = await waitForEvent(client, 'disconnect', 4000);
    // exp has 1-second resolution, so allow a little slack either side of it
    expect(Date.now()).toBeGreaterThanOrEqual(exp * 1000 - 50);
    expect(Date.now()).toBeLessThan(exp * 1000 + 1000);
    // Server-initiated, so socket.io-client will not reconnect on its own
    expect(reason).toBe('io server disconnect');
    expect(client.active).toBe(false);
    expect(console.warn).toHaveBeenCalledWith('socket disconnected: token expired');
  }, 10000);
});

describe("responses and events do not expose other users' ids", () => {
  it('newBloodRequest carries only the card fields: no requesterId or declinedBy', async () => {
    const requester = await registerUser({ name: 'Rita Requester', bloodGroup: 'B+', location: HOSPITAL });
    const donor = await registerUser({ name: 'Dana Donor', bloodGroup: 'B+' });

    const donorClient = connectClient(donor.socketCookie);
    await waitForConnect(donorClient);

    const newRequestEvent = waitForEvent(donorClient, 'newBloodRequest');
    const createRes = await request(server)
      .post('/api/requests')
      .set('Cookie', requester.cookie)
      .send({ bloodGroup: 'B+', unitsNeeded: 2, hospitalName: 'Socket Test Hospital', hospitalLocation: HOSPITAL, urgency: 'high' });
    expect(createRes.statusCode).toBe(201);
    expect(createRes.text).not.toContain('declinedBy');

    const payload = await newRequestEvent;
    expect(Object.keys(payload).sort()).toEqual([
      '_id', 'bloodGroup', 'createdAt', 'hospitalLocation', 'hospitalName', 'matchType',
      'requesterName', 'status', 'unitsNeeded', 'urgency',
    ]);
    expect(payload).toMatchObject({
      _id: createRes.body.request._id,
      bloodGroup: 'B+',
      unitsNeeded: 2,
      hospitalName: 'Socket Test Hospital',
      hospitalLocation: { type: 'Point', coordinates: HOSPITAL },
      urgency: 'high',
      status: 'pending',
      requesterName: 'Rita Requester',
      matchType: 'exact',
    });
    expect(JSON.stringify(payload)).not.toContain(requester.id);
  });

  it('declinedBy never appears in decline, incoming, mine, accept, fulfil, rate, cancel or history responses', async () => {
    const requester = await registerUser({ name: 'Rita Requester', bloodGroup: 'B+', location: HOSPITAL });
    const decliningDonor = await registerUser({ name: 'Dave Decliner', bloodGroup: 'O-' });
    const acceptingDonor = await registerUser({ name: 'Anna Acceptor', bloodGroup: 'O-' });
    const bloodRequest = await createBloodRequest(requester.id);
    const otherRequest = await createBloodRequest(requester.id);

    const expectNoDeclinedBy = (res) => {
      expect(res.text).not.toContain('declinedBy');
      expect(res.text).not.toContain(decliningDonor.id);
    };
    const asUser = (user, method, path) => request(server)[method](path).set('Cookie', user.cookie);

    for (const requestToDecline of [bloodRequest, otherRequest]) {
      const declineRes = await asUser(decliningDonor, 'patch', `/api/requests/${requestToDecline._id}/status`)
        .send({ status: 'declined' });
      expect(declineRes.statusCode).toBe(200);
      expectNoDeclinedBy(declineRes);
    }
    // Still stored and still used by the server
    const stored = await Request.findById(bloodRequest._id);
    expect(stored.declinedBy.map(String)).toEqual([decliningDonor.id]);
    const declinerIncoming = await asUser(decliningDonor, 'get', '/api/requests/incoming');
    expect(declinerIncoming.body.incomingRequests).toEqual([]);

    const incomingRes = await asUser(acceptingDonor, 'get', '/api/requests/incoming');
    expect(incomingRes.statusCode).toBe(200);
    expect(incomingRes.body.incomingRequests).toHaveLength(2);
    expectNoDeclinedBy(incomingRes);
    // A stranger's pending request: the requester's name is populated, their user id is not
    expect(incomingRes.body.incomingRequests[0].requesterId).toEqual({ name: 'Rita Requester', profilePic: '' });
    expect(incomingRes.text).not.toContain(requester.id);

    const mineRes = await asUser(requester, 'get', '/api/requests/mine');
    expect(mineRes.body.requests).toHaveLength(2);
    expectNoDeclinedBy(mineRes);

    const acceptRes = await asUser(acceptingDonor, 'patch', `/api/requests/${bloodRequest._id}/status`)
      .send({ status: 'accepted' });
    expect(acceptRes.statusCode).toBe(200);
    expectNoDeclinedBy(acceptRes);

    const cancelRes = await asUser(requester, 'patch', `/api/requests/${otherRequest._id}/status`)
      .send({ status: 'cancelled' });
    expect(cancelRes.statusCode).toBe(200);
    expectNoDeclinedBy(cancelRes);

    const fulfilRes = await asUser(requester, 'patch', `/api/requests/${bloodRequest._id}/fulfill`);
    expect(fulfilRes.statusCode).toBe(200);
    expectNoDeclinedBy(fulfilRes);

    const rateRes = await asUser(requester, 'post', `/api/requests/${bloodRequest._id}/rate`)
      .send({ rating: 5, ratingNote: 'Thank you' });
    expect(rateRes.statusCode).toBe(200);
    expectNoDeclinedBy(rateRes);

    const requesterHistory = await asUser(requester, 'get', '/api/users/history');
    expect(requesterHistory.body.pastRequests).toHaveLength(2);
    expectNoDeclinedBy(requesterHistory);

    const donorHistory = await asUser(acceptingDonor, 'get', '/api/users/history');
    expect(donorHistory.body.pastDonations).toHaveLength(1);
    expectNoDeclinedBy(donorHistory);
  });
});
