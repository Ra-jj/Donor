const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const mongoose = require('mongoose');
const request = require('supertest');
const app = require('../index');
const Request = require('../models/request.model');
const User = require('../models/user.model');
const { connectDB, closeDB, clearDB } = require('./db');
const { REGISTRATION_CONSENT } = require('./registration');

// Profile's donation badges (client/src/components/DonationBadges.jsx) count donor.livesSaved from
// GET /api/users/stats: donations completed through Donor only. Both halves are checked here: what
// the server counts, and the client's milestones for a count.

// Coordinates are [longitude, latitude]
const HOSPITAL = [77.5946, 12.9716]; // Bangalore
const NEARBY = [77.6, 12.975]; // ~0.7 km from HOSPITAL

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

afterEach(async () => {
  await clearDB();
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await closeDB();
});

// Register through the API and reuse the cookie register sets (login is rate limited)
const registerUser = async () => {
  userCount += 1;
  const res = await request(server)
    .post('/api/auth/register')
    .send({
      name: `Badge User ${userCount}`,
      email: `badge.user${userCount}@example.com`,
      password: 'password123',
      bloodGroup: 'O-',
      location: NEARBY,
      ...REGISTRATION_CONSENT,
    });
  expect(res.statusCode).toBe(201);
  return { id: res.body.user._id, cookie: res.headers['set-cookie'] };
};

const createBloodRequest = (overrides) =>
  Request.create({
    requesterId: new mongoose.Types.ObjectId(),
    bloodGroup: 'B+',
    unitsNeeded: 1,
    hospitalName: 'Badge Test Hospital',
    hospitalLocation: { type: 'Point', coordinates: HOSPITAL },
    ...overrides,
  });

describe('the count the badges use (GET /api/users/stats, donor.livesSaved)', () => {
  it('counts only requests fulfilled with this user as the donor, anonymised ones included', async () => {
    const donor = await registerUser();
    const someoneElse = await registerUser();
    // Two donations through Donor, one of them for a requester who has since deleted their account
    await createBloodRequest({ status: 'fulfilled', matchedDonorId: donor.id, fulfilledAt: new Date() });
    await createBloodRequest({ status: 'fulfilled', requesterId: null, matchedDonorId: donor.id, fulfilledAt: new Date() });
    // Not donations of theirs
    await createBloodRequest({ status: 'accepted', matchedDonorId: donor.id });
    await createBloodRequest({ status: 'cancelled', matchedDonorId: donor.id });
    await createBloodRequest({ status: 'fulfilled', matchedDonorId: someoneElse.id, fulfilledAt: new Date() });
    await createBloodRequest({ status: 'fulfilled', requesterId: donor.id, matchedDonorId: someoneElse.id, fulfilledAt: new Date() });
    // Self-reported, so never counted
    await User.updateOne({ _id: donor.id }, { $set: { lastOutsideDonationDate: new Date('2026-01-01T00:00:00.000Z') } });

    const res = await request(server).get('/api/users/stats').set('Cookie', donor.cookie);

    expect(res.statusCode).toBe(200);
    expect(res.body.donor.livesSaved).toBe(2);
  });
});

describe('the milestones (client/src/lib/donationBadges.js)', () => {
  // The client module is ESM; with its two exports made plain declarations it runs as a script
  const loadClientBadges = () => {
    const source = fs.readFileSync(path.join(__dirname, '../../client/src/lib/donationBadges.js'), 'utf8');
    const context = vm.createContext({});
    vm.runInContext(
      `${source.replace(/^export /gm, '')}\nthis.exports = { DONATION_BADGES, describeDonationBadges };`,
      context
    );
    return context.exports;
  };

  it('are 1, 3, 5 and 10 donations', () => {
    const { DONATION_BADGES } = loadClientBadges();

    expect(DONATION_BADGES.map(({ count, name }) => [count, name])).toEqual([
      [1, 'First donation'],
      [3, '3 donations'],
      [5, '5 donations'],
      [10, '10 donations'],
    ]);
  });

  it.each([
    [0, [], ['First donation', 1]],
    [1, ['First donation'], ['3 donations', 2]],
    [2, ['First donation'], ['3 donations', 1]],
    [3, ['First donation', '3 donations'], ['5 donations', 2]],
    [4, ['First donation', '3 donations'], ['5 donations', 1]],
    [5, ['First donation', '3 donations', '5 donations'], ['10 donations', 5]],
    [9, ['First donation', '3 donations', '5 donations'], ['10 donations', 1]],
    [10, ['First donation', '3 donations', '5 donations', '10 donations'], null],
    [12, ['First donation', '3 donations', '5 donations', '10 donations'], null],
  ])('with %i donations: earned %j, next %j', (donationCount, earnedNames, next) => {
    const { describeDonationBadges } = loadClientBadges();

    const badges = describeDonationBadges(donationCount);

    expect(badges.earned.map(({ name }) => name)).toEqual(earnedNames);
    expect(badges.next && [badges.next.name, badges.next.remaining]).toEqual(next);
  });
});
