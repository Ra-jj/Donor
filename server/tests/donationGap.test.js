const http = require('http');
const request = require('supertest');
const mongoose = require('mongoose');
const webpush = require('web-push');
const app = require('../index');
const { io } = require('../lib/socket');
const Request = require('../models/request.model');
const User = require('../models/user.model');
const {
  DONATION_GAP_DAYS,
  getTodayInIndiaDateString,
  getDonationGapCutoff,
  computeNextEligibleDonationAt,
  formatIndiaDate,
  describeDonationGap,
} = require('../utils/donationGap');
const { updateProfileSchema } = require('../validators/profileValidator');
const { connectDB, closeDB, clearDB } = require('./db');
const { REGISTRATION_CONSENT } = require('./registration');

const DAY_MS = 24 * 60 * 60 * 1000;
// IST is UTC+5:30 all year. Everything below uses this offset, never the machine's time zone,
// so the suite gives the same result on an IST laptop and on a UTC CI runner.
const INDIA_UTC_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

// 00:00 IST of the IST calendar day that contains the instant
const indiaDayStartMs = (instantMs) =>
  Math.floor((instantMs + INDIA_UTC_OFFSET_MS) / DAY_MS) * DAY_MS - INDIA_UTC_OFFSET_MS;

describe('DONATION_GAP_DAYS', () => {
  it('is 120 days, the longer of the two intervals in G.S.R. 166(E), since sex is not stored', () => {
    expect(DONATION_GAP_DAYS).toBe(120);
  });
});

describe('computeNextEligibleDonationAt', () => {
  it('returns 00:00 IST on the day 120 days after the IST calendar day of the donation', () => {
    // 10:00 IST on 1 January 2026; 1 January + 120 days is 1 May
    const next = computeNextEligibleDonationAt(new Date('2026-01-01T04:30:00.000Z'));
    expect(next.toISOString()).toBe('2026-04-30T18:30:00.000Z'); // 00:00 IST on 1 May 2026
  });

  it('uses the IST calendar day, not the UTC one', () => {
    // 01:30 IST on 2 January, still 1 January in UTC
    expect(computeNextEligibleDonationAt(new Date('2026-01-01T20:00:00.000Z')).toISOString())
      .toBe('2026-05-01T18:30:00.000Z'); // 00:00 IST on 2 May
    // The last millisecond of 1 January in IST
    expect(computeNextEligibleDonationAt(new Date('2026-01-01T18:29:59.999Z')).toISOString())
      .toBe('2026-04-30T18:30:00.000Z'); // 00:00 IST on 1 May
  });

  it('reads a date-only value stored as 00:00 UTC as that same date in IST', () => {
    expect(computeNextEligibleDonationAt(new Date('2026-01-01T00:00:00.000Z')).toISOString())
      .toBe('2026-04-30T18:30:00.000Z');
  });

  it('counts 29 February in a leap year', () => {
    // 2028: 1 January + 120 days is 30 April, not 1 May
    expect(computeNextEligibleDonationAt(new Date('2028-01-01T00:00:00.000Z')).toISOString())
      .toBe('2028-04-29T18:30:00.000Z'); // 00:00 IST on 30 April 2028
  });
});

describe('getDonationGapCutoff', () => {
  it('at 00:00 IST on 1 May frees a donation from any time on 1 January (IST)', () => {
    const cutoff = getDonationGapCutoff(Date.parse('2026-04-30T18:30:00.000Z'));
    expect(cutoff.toISOString()).toBe('2026-01-01T18:30:00.000Z'); // 00:00 IST on 2 January
  });

  it('one millisecond earlier, still 30 April in IST, blocks a donation from 00:00 IST on 1 January', () => {
    const cutoff = getDonationGapCutoff(Date.parse('2026-04-30T18:29:59.999Z'));
    expect(cutoff.toISOString()).toBe('2025-12-31T18:30:00.000Z'); // 00:00 IST on 1 January
  });

  // The two definitions the code relies on must agree everywhere: the cutoff drives the database
  // filters (who is matched, who may accept) and computeNextEligibleDonationAt drives the date
  // the donor is shown
  it('agrees with computeNextEligibleDonationAt for every donation and every moment', () => {
    // Small deterministic generator, so a failure can be reproduced
    let seed = 20260930;
    const nextRandom = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const start = Date.parse('2024-01-01T00:00:00.000Z');
    const disagreements = [];
    for (let i = 0; i < 20000; i += 1) {
      const donationMs = start + Math.floor(nextRandom() * 900 * DAY_MS);
      const nextEligibleMs = computeNextEligibleDonationAt(new Date(donationMs)).getTime();
      // Moments anywhere in the following 200 days, within a day of the boundary, exactly on
      // it, and 1 ms before it
      const nowMsChoices = [
        donationMs + Math.floor(nextRandom() * 200 * DAY_MS),
        nextEligibleMs + Math.floor((nextRandom() - 0.5) * 2 * DAY_MS),
        nextEligibleMs,
        nextEligibleMs - 1,
      ];
      const nowMs = nowMsChoices[i % nowMsChoices.length];
      const isBlockedByCutoff = donationMs >= getDonationGapCutoff(nowMs).getTime();
      const isBlockedByNextEligible = nowMs < nextEligibleMs;
      if (isBlockedByCutoff !== isBlockedByNextEligible) disagreements.push({ donationMs, nowMs });
    }
    expect(disagreements).toEqual([]);
  });
});

describe('dates shown to the donor', () => {
  it('are formatted as the IST calendar date', () => {
    // 18:30 UTC on 30 April is already 1 May in India
    expect(formatIndiaDate(new Date('2026-04-30T18:30:00.000Z'))).toBe('1 May 2026');
    expect(describeDonationGap(new Date('2026-04-30T18:30:00.000Z')))
      .toBe('You donated recently. You can donate again from 1 May 2026.');
  });

  it('use the IST date for "today"', () => {
    expect(getTodayInIndiaDateString(Date.parse('2026-09-30T18:29:59.999Z'))).toBe('2026-09-30');
    expect(getTodayInIndiaDateString(Date.parse('2026-09-30T18:30:00.000Z'))).toBe('2026-10-01');
  });
});

describe('updateProfileSchema lastOutsideDonationDate', () => {
  // 01:30 IST on 1 October 2026, while it is still 30 September in UTC
  const NOW_MS = Date.parse('2026-09-30T20:00:00.000Z');

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const parseDate = (value) => updateProfileSchema.safeParse({ lastOutsideDonationDate: value });
  const errorFor = (value) => {
    const result = parseDate(value);
    expect(result.success).toBe(false);
    expect(result.error.issues).toHaveLength(1);
    expect(result.error.issues[0].path).toEqual(['lastOutsideDonationDate']);
    return result.error.issues[0].message;
  };

  it('stores a YYYY-MM-DD date as 00:00 UTC of that date', () => {
    const result = parseDate('2026-01-15');
    expect(result.success).toBe(true);
    expect(result.data.lastOutsideDonationDate.toISOString()).toBe('2026-01-15T00:00:00.000Z');
  });

  it('accepts null to clear the date, and leaves the field out when it is not sent', () => {
    expect(parseDate(null)).toEqual({ success: true, data: { lastOutsideDonationDate: null } });
    const withoutDate = updateProfileSchema.safeParse({ isAvailable: true });
    expect(withoutDate.success).toBe(true);
    expect(withoutDate.data.lastOutsideDonationDate).toBeUndefined();
  });

  it('accepts today in India, even where it is still yesterday in UTC, and rejects tomorrow', () => {
    expect(parseDate('2026-10-01').success).toBe(true);
    expect(errorFor('2026-10-02')).toBe('Last outside donation date cannot be in the future');
    expect(errorFor('2030-01-01')).toBe('Last outside donation date cannot be in the future');
  });

  it('accepts 1 January 1900 and rejects anything earlier', () => {
    expect(parseDate('1900-01-01').success).toBe(true);
    expect(errorFor('1899-12-31')).toBe('Last outside donation date cannot be before 1900');
    expect(errorFor('0001-01-01')).toBe('Last outside donation date cannot be before 1900');
  });

  it('rejects days that do not exist', () => {
    expect(parseDate('2024-02-29').success).toBe(true);
    ['2025-02-29', '2026-02-30', '2026-04-31', '2026-13-01', '2026-00-10', '2026-01-00'].forEach((value) => {
      expect(errorFor(value)).toBe('Last outside donation date is not a real calendar date');
    });
  });

  it('rejects anything that is not exactly YYYY-MM-DD', () => {
    ['', 'not-a-date', '2026-1-5', '15-01-2026', '2026/01/15', ' 2026-01-15', '2026-01-15T00:00:00.000Z', '+02026-01-15'].forEach((value) => {
      expect(errorFor(value)).toBe('Last outside donation date must be a YYYY-MM-DD date');
    });
    [20260115, true, {}, ['2026-01-15']].forEach((value) => {
      expect(errorFor(value)).toBe('Last outside donation date must be a YYYY-MM-DD date or null');
    });
  });
});

describe('the donation gap through the API', () => {
  // supertest dials 127.0.0.1, so bind there explicitly. request(app) binds `::`, and another
  // local app on the same ephemeral port can answer instead.
  let server;
  let userCount = 0;
  let sendNotificationSpy;
  // Date.now() is frozen at this value in every test here, so the server and the test agree on
  // "today" even if a test runs across midnight IST. Donations are placed in time by writing
  // fulfilledAt directly, never by waiting.
  let NOW;

  // Coordinates are [longitude, latitude]
  const HOSPITAL = [77.5946, 12.9716]; // Bangalore
  const NEARBY = [77.6, 12.975]; // ~0.7 km from HOSPITAL
  const ALSO_NEARBY = [77.58, 12.96]; // ~2 km from HOSPITAL, on a different rounded pin

  beforeAll(async () => {
    await connectDB();
    // Mongoose builds indexes in the background; wait so one_active_donation_per_donor exists
    await Request.init();
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  beforeEach(() => {
    NOW = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    // No real push service calls; see createRequestPrivacy.test.js
    sendNotificationSpy = jest.spyOn(webpush, 'sendNotification').mockResolvedValue({ statusCode: 201 });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await clearDB();
  });

  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await closeDB();
  });

  const daysAgo = (days) => new Date(NOW - days * DAY_MS);
  // The IST calendar date `days` days before today, as an <input type="date"> sends it
  const indiaDateDaysAgo = (days) => getTodayInIndiaDateString(NOW - days * DAY_MS);
  // 00:00 IST on the day the donor may donate again after an outside donation on that date
  const nextEligibleAfterDate = (dateOnly) =>
    computeNextEligibleDonationAt(new Date(`${dateOnly}T00:00:00.000Z`)).toISOString();

  // Register through the API and reuse the cookie register sets. Logging in per
  // test would exhaust the login rate limiter (10 per 15 min per IP).
  const registerUser = async ({ bloodGroup, location = NEARBY, name }) => {
    userCount += 1;
    const email = `gap.user${userCount}@example.com`;
    const res = await request(server)
      .post('/api/auth/register')
      .send({ name: name || `Gap User ${userCount}`, email, password: 'password123', bloodGroup, location, ...REGISTRATION_CONSENT });
    expect(res.statusCode).toBe(201);
    return { id: res.body.user._id, name: res.body.user.name, email, cookie: res.headers['set-cookie'], body: res.body };
  };

  // A+ cannot give to B+, so this requester is never a candidate for the B+ requests below
  const registerRequester = () => registerUser({ name: 'Gap Requester', bloodGroup: 'A+', location: HOSPITAL });

  // Created directly on the model so the test controls status, donor and fulfilledAt
  const createBloodRequest = (requesterId, overrides = {}) =>
    Request.create({
      requesterId,
      bloodGroup: 'B+',
      unitsNeeded: 2,
      hospitalName: 'Gap Test Hospital',
      hospitalLocation: { type: 'Point', coordinates: HOSPITAL },
      urgency: 'high',
      ...overrides,
    });

  // A donation completed through the app, dated by fulfilledAt
  const addInAppDonation = (requesterId, donorId, fulfilledAt) =>
    createBloodRequest(requesterId, { status: 'fulfilled', matchedDonorId: donorId, fulfilledAt });

  const patchStatus = (requestId, cookie, status) =>
    request(server).patch(`/api/requests/${requestId}/status`).set('Cookie', cookie).send({ status });

  const patchFulfill = (requestId, cookie) =>
    request(server).patch(`/api/requests/${requestId}/fulfill`).set('Cookie', cookie);

  const patchProfile = (cookie, body) =>
    request(server).patch('/api/users/profile').set('Cookie', cookie).send(body);

  const getAuthCheck = (cookie) => request(server).get('/api/auth/check').set('Cookie', cookie);

  const getIncoming = (cookie) => request(server).get('/api/requests/incoming').set('Cookie', cookie);

  // Replaces io.to() so a test can see which room was notified and with what payload
  const spyOnSocket = () => {
    const emit = jest.fn();
    const to = jest.spyOn(io, 'to').mockReturnValue({ emit });
    return { to, emit };
  };

  // Creates a B+ request at HOSPITAL through the API; reports who was notified and what the requester saw
  const createAndSeeWhoMatched = async (requesterCookie) => {
    const socket = spyOnSocket();
    const res = await request(server)
      .post('/api/requests')
      .set('Cookie', requesterCookie)
      .send({ bloodGroup: 'B+', unitsNeeded: 1, hospitalName: 'Gap Match Hospital', hospitalLocation: HOSPITAL });
    expect(res.statusCode).toBe(201);
    const notifiedRooms = socket.to.mock.calls
      .filter((call, index) => socket.emit.mock.calls[index][0] === 'newBloodRequest')
      .map(([room]) => room)
      .sort();
    socket.to.mockRestore();
    return { notifiedRooms, matchedDonorCount: res.body.matchedDonorCount, donorPins: res.body.donorPins, requestId: res.body.request._id };
  };

  const subscribeToPush = (donorId) =>
    User.findByIdAndUpdate(donorId, {
      pushSubscription: { endpoint: `https://fcm.googleapis.com/fcm/send/${donorId}`, keys: { p256dh: 'a', auth: 'b' } },
    });

  const expectStillPending = async (requestId) => {
    const stored = await Request.findById(requestId);
    expect(stored.status).toBe('pending');
    expect(stored.matchedDonorId).toBeNull();
  };

  describe('a donation completed through the app', () => {
    it('119 days ago: no alert, not counted or pinned, and Accept is refused (403) before any write', async () => {
      const requester = await registerRequester();
      const restingDonor = await registerUser({ bloodGroup: 'O-', location: NEARBY });
      const otherDonor = await registerUser({ bloodGroup: 'B+', location: ALSO_NEARBY });
      await subscribeToPush(restingDonor.id);
      const fulfilledAt = daysAgo(119);
      await addInAppDonation(requester.id, restingDonor.id, fulfilledAt);

      const matched = await createAndSeeWhoMatched(requester.cookie);

      // The other donor proves the request did reach donors; the resting donor is left out of
      // the socket alert, the push, the count and the pins alike
      expect(matched.notifiedRooms).toEqual([otherDonor.id]);
      expect(matched.matchedDonorCount).toBe(1);
      expect(matched.donorPins).toEqual([{ coordinates: [77.58, 12.96] }]);
      expect(sendNotificationSpy).not.toHaveBeenCalled();

      const pendingRequest = await createBloodRequest(requester.id);
      const findOneAndUpdateSpy = jest.spyOn(Request, 'findOneAndUpdate');
      const socket = spyOnSocket();
      const res = await patchStatus(pendingRequest._id, restingDonor.cookie, 'accepted');

      const expectedNext = computeNextEligibleDonationAt(fulfilledAt);
      expect(res.statusCode).toBe(403);
      expect(res.body).toEqual({
        message: describeDonationGap(expectedNext),
        nextEligibleDonationAt: expectedNext.toISOString(),
      });
      expect(res.body.message).toMatch(/^You donated recently\. You can donate again from \d{1,2} [A-Z][a-z]+ \d{4}\.$/);
      // Refused by the check before the write, so the request was never accepted, even briefly
      expect(findOneAndUpdateSpy).not.toHaveBeenCalled();
      expect(socket.to).not.toHaveBeenCalled();
      await expectStillPending(pendingRequest._id);
      // The gap is derived: the donor's own availability choice is never written
      expect((await User.findById(restingDonor.id)).isAvailable).toBe(true);
    });

    it('121 days ago: alerted, counted and allowed to accept (200)', async () => {
      const requester = await registerRequester();
      const donor = await registerUser({ bloodGroup: 'O-', location: NEARBY });
      await subscribeToPush(donor.id);
      await addInAppDonation(requester.id, donor.id, daysAgo(121));

      const matched = await createAndSeeWhoMatched(requester.cookie);

      expect(matched.notifiedRooms).toEqual([donor.id]);
      expect(matched.matchedDonorCount).toBe(1);
      expect(sendNotificationSpy).toHaveBeenCalledTimes(1);
      expect((await getAuthCheck(donor.cookie)).body.user.nextEligibleDonationAt).toBeNull();
      const res = await patchStatus(matched.requestId, donor.cookie, 'accepted');
      expect(res.statusCode).toBe(200);
      expect(res.body.request.matchedDonorId).toBe(donor.id);
    });

    it('fulfilling through the API starts the gap at once, until 00:00 IST 120 days after that IST day', async () => {
      const requester = await registerRequester();
      const donor = await registerUser({ bloodGroup: 'O-' });
      const heldRequest = await createBloodRequest(requester.id);
      expect((await patchStatus(heldRequest._id, donor.cookie, 'accepted')).statusCode).toBe(200);
      expect((await getAuthCheck(donor.cookie)).body.user.nextEligibleDonationAt).toBeNull();

      expect((await patchFulfill(heldRequest._id, requester.cookie)).statusCode).toBe(200);

      const { fulfilledAt } = await Request.findById(heldRequest._id);
      const expectedNextMs = indiaDayStartMs(fulfilledAt.getTime()) + 120 * DAY_MS;
      expect(computeNextEligibleDonationAt(fulfilledAt).getTime()).toBe(expectedNextMs);
      const check = await getAuthCheck(donor.cookie);
      expect(check.body.user.nextEligibleDonationAt).toBe(new Date(expectedNextMs).toISOString());
      expect(check.body.user.isAvailable).toBe(true);
    });
  });

  describe('the exact boundary', () => {
    it('blocks a donation from 00:00 IST 119 days ago until 00:00 IST tomorrow, and frees one 1 ms earlier', async () => {
      const requester = await registerRequester();
      const blockedDonor = await registerUser({ bloodGroup: 'O-', location: NEARBY });
      const freeDonor = await registerUser({ bloodGroup: 'O-', location: ALSO_NEARBY });
      const todayStartMs = indiaDayStartMs(NOW);
      // First millisecond of the IST day 119 days ago, and the last millisecond of the day before it
      const blockingDonationMs = todayStartMs - 119 * DAY_MS;
      await addInAppDonation(requester.id, blockedDonor.id, new Date(blockingDonationMs));
      await addInAppDonation(requester.id, freeDonor.id, new Date(blockingDonationMs - 1));

      const blockedCheck = await getAuthCheck(blockedDonor.cookie);
      const freeCheck = await getAuthCheck(freeDonor.cookie);
      expect(blockedCheck.body.user.nextEligibleDonationAt).toBe(new Date(todayStartMs + DAY_MS).toISOString());
      expect(freeCheck.body.user.nextEligibleDonationAt).toBeNull();

      const matched = await createAndSeeWhoMatched(requester.cookie);
      expect(matched.notifiedRooms).toEqual([freeDonor.id]);
      expect(matched.matchedDonorCount).toBe(1);

      const blockedRequest = await createBloodRequest(requester.id);
      expect((await patchStatus(blockedRequest._id, blockedDonor.cookie, 'accepted')).statusCode).toBe(403);
      expect((await patchStatus(matched.requestId, freeDonor.cookie, 'accepted')).statusCode).toBe(200);
    });

    it('frees an outside donation dated 120 days ago today, and blocks one dated 119 days ago until tomorrow', async () => {
      const freeDonor = await registerUser({ bloodGroup: 'O-' });
      const blockedDonor = await registerUser({ bloodGroup: 'O-' });

      const freeRes = await patchProfile(freeDonor.cookie, { lastOutsideDonationDate: indiaDateDaysAgo(120) });
      const blockedRes = await patchProfile(blockedDonor.cookie, { lastOutsideDonationDate: indiaDateDaysAgo(119) });

      expect(freeRes.statusCode).toBe(200);
      expect(freeRes.body.user.nextEligibleDonationAt).toBeNull();
      expect(blockedRes.statusCode).toBe(200);
      expect(blockedRes.body.user.nextEligibleDonationAt).toBe(new Date(indiaDayStartMs(NOW) + DAY_MS).toISOString());
    });
  });

  describe('a donation made outside the app', () => {
    it('stores the date as given and applies the same gap: 119 days ago refused, 121 days ago allowed', async () => {
      const requester = await registerRequester();
      const donor = await registerUser({ bloodGroup: 'O-' });
      const recentDate = indiaDateDaysAgo(119);

      const setRes = await patchProfile(donor.cookie, { lastOutsideDonationDate: recentDate });

      expect(setRes.statusCode).toBe(200);
      expect(setRes.body.user.lastOutsideDonationDate).toBe(`${recentDate}T00:00:00.000Z`);
      expect(setRes.body.user.nextEligibleDonationAt).toBe(nextEligibleAfterDate(recentDate));
      expect(setRes.body.user).not.toHaveProperty('password');
      const whileResting = await createAndSeeWhoMatched(requester.cookie);
      expect(whileResting.notifiedRooms).toEqual([]);
      expect(whileResting.matchedDonorCount).toBe(0);
      const refused = await patchStatus(whileResting.requestId, donor.cookie, 'accepted');
      expect(refused.statusCode).toBe(403);
      expect(refused.body.nextEligibleDonationAt).toBe(nextEligibleAfterDate(recentDate));
      await expectStillPending(whileResting.requestId);

      const olderDate = indiaDateDaysAgo(121);
      const olderRes = await patchProfile(donor.cookie, { lastOutsideDonationDate: olderDate });
      expect(olderRes.body.user.nextEligibleDonationAt).toBeNull();
      const afterwards = await createAndSeeWhoMatched(requester.cookie);
      expect(afterwards.notifiedRooms).toEqual([donor.id]);
      expect(afterwards.matchedDonorCount).toBe(1);
      expect((await patchStatus(afterwards.requestId, donor.cookie, 'accepted')).statusCode).toBe(200);
    });

    it('can be cleared with null, which ends the gap it started', async () => {
      const requester = await registerRequester();
      const donor = await registerUser({ bloodGroup: 'O-' });
      expect((await patchProfile(donor.cookie, { lastOutsideDonationDate: indiaDateDaysAgo(10) })).statusCode).toBe(200);
      expect((await createAndSeeWhoMatched(requester.cookie)).notifiedRooms).toEqual([]);

      const clearRes = await patchProfile(donor.cookie, { lastOutsideDonationDate: null });

      expect(clearRes.statusCode).toBe(200);
      expect(clearRes.body.user.lastOutsideDonationDate).toBeNull();
      expect(clearRes.body.user.nextEligibleDonationAt).toBeNull();
      expect((await User.findById(donor.id)).lastOutsideDonationDate).toBeNull();
      expect((await createAndSeeWhoMatched(requester.cookie)).notifiedRooms).toEqual([donor.id]);
    });

    it('leaves the stored date alone when a profile update does not send it', async () => {
      const donor = await registerUser({ bloodGroup: 'O-' });
      const date = indiaDateDaysAgo(10);
      await patchProfile(donor.cookie, { lastOutsideDonationDate: date });

      const res = await patchProfile(donor.cookie, { isAvailable: false });

      expect(res.body.user.lastOutsideDonationDate).toBe(`${date}T00:00:00.000Z`);
      expect(res.body.user.nextEligibleDonationAt).toBe(nextEligibleAfterDate(date));
    });

    it('rejects a future, impossible or malformed date (400) and keeps the stored one', async () => {
      const donor = await registerUser({ bloodGroup: 'O-' });
      const storedDate = indiaDateDaysAgo(30);
      await patchProfile(donor.cookie, { lastOutsideDonationDate: storedDate });
      const cases = [
        [indiaDateDaysAgo(-1), 'Last outside donation date cannot be in the future'],
        ['2026-02-30', 'Last outside donation date is not a real calendar date'],
        ['1899-12-31', 'Last outside donation date cannot be before 1900'],
        ['next tuesday', 'Last outside donation date must be a YYYY-MM-DD date'],
        [1735689600000, 'Last outside donation date must be a YYYY-MM-DD date or null'],
      ];

      for (const [value, message] of cases) {
        const res = await patchProfile(donor.cookie, { lastOutsideDonationDate: value });
        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ message: 'Validation failed', errors: { lastOutsideDonationDate: message } });
      }
      expect((await User.findById(donor.id)).lastOutsideDonationDate.toISOString()).toBe(`${storedDate}T00:00:00.000Z`);
    });

    it('still matches a donor whose document has no lastOutsideDonationDate field at all', async () => {
      // Accounts created before the field was renamed have no value under the new name
      const requester = await registerRequester();
      const donor = await registerUser({ bloodGroup: 'O-' });
      const donorObjectId = new mongoose.Types.ObjectId(donor.id);
      await User.collection.updateOne({ _id: donorObjectId }, { $unset: { lastOutsideDonationDate: '' } });
      expect(await User.collection.findOne({ _id: donorObjectId })).not.toHaveProperty('lastOutsideDonationDate');

      const matched = await createAndSeeWhoMatched(requester.cookie);

      expect(matched.notifiedRooms).toEqual([donor.id]);
      expect((await getAuthCheck(donor.cookie)).body.user.nextEligibleDonationAt).toBeNull();
    });
  });

  // Both donations are inside the gap in each case, so which one is used changes the answer
  describe('the more recent of the two donations wins', () => {
    it('an outside donation after the in-app one', async () => {
      const requester = await registerRequester();
      const donor = await registerUser({ bloodGroup: 'O-' });
      await addInAppDonation(requester.id, donor.id, daysAgo(60));
      const outsideDate = indiaDateDaysAgo(20);

      await patchProfile(donor.cookie, { lastOutsideDonationDate: outsideDate });

      expect((await getAuthCheck(donor.cookie)).body.user.nextEligibleDonationAt).toBe(nextEligibleAfterDate(outsideDate));
      const pendingRequest = await createBloodRequest(requester.id);
      expect((await patchStatus(pendingRequest._id, donor.cookie, 'accepted')).statusCode).toBe(403);
    });

    it('an in-app donation after the outside one', async () => {
      const requester = await registerRequester();
      const donor = await registerUser({ bloodGroup: 'O-' });
      await patchProfile(donor.cookie, { lastOutsideDonationDate: indiaDateDaysAgo(60) });
      const fulfilledAt = daysAgo(20);
      await addInAppDonation(requester.id, donor.id, fulfilledAt);

      expect((await getAuthCheck(donor.cookie)).body.user.nextEligibleDonationAt)
        .toBe(computeNextEligibleDonationAt(fulfilledAt).toISOString());
    });

    it('the latest of several in-app donations', async () => {
      const requester = await registerRequester();
      const donor = await registerUser({ bloodGroup: 'O-' });
      const latest = daysAgo(20);
      await addInAppDonation(requester.id, donor.id, daysAgo(100));
      await addInAppDonation(requester.id, donor.id, latest);
      await addInAppDonation(requester.id, donor.id, daysAgo(60));

      expect((await getAuthCheck(donor.cookie)).body.user.nextEligibleDonationAt)
        .toBe(computeNextEligibleDonationAt(latest).toISOString());
    });
  });

  describe('what does not start a gap', () => {
    it('a cancelled donation', async () => {
      const requester = await registerRequester();
      const donor = await registerUser({ bloodGroup: 'O-' });
      const heldRequest = await createBloodRequest(requester.id);
      expect((await patchStatus(heldRequest._id, donor.cookie, 'accepted')).statusCode).toBe(200);
      expect((await patchStatus(heldRequest._id, requester.cookie, 'cancelled')).statusCode).toBe(200);

      expect((await getAuthCheck(donor.cookie)).body.user.nextEligibleDonationAt).toBeNull();
      const matched = await createAndSeeWhoMatched(requester.cookie);
      expect(matched.notifiedRooms).toEqual([donor.id]);
      expect((await patchStatus(matched.requestId, donor.cookie, 'accepted')).statusCode).toBe(200);
    });

    it('a fulfilled request with no fulfilledAt (the date is unknown)', async () => {
      const requester = await registerRequester();
      const donor = await registerUser({ bloodGroup: 'O-' });
      await addInAppDonation(requester.id, donor.id, null);

      expect((await getAuthCheck(donor.cookie)).body.user.nextEligibleDonationAt).toBeNull();
      expect((await createAndSeeWhoMatched(requester.cookie)).notifiedRooms).toEqual([donor.id]);
    });

    it('another donor\'s donation', async () => {
      const requester = await registerRequester();
      const donor = await registerUser({ bloodGroup: 'O-' });
      const otherDonor = await registerUser({ bloodGroup: 'O-', location: ALSO_NEARBY });
      await addInAppDonation(requester.id, otherDonor.id, daysAgo(5));

      expect((await getAuthCheck(donor.cookie)).body.user.nextEligibleDonationAt).toBeNull();
      expect((await createAndSeeWhoMatched(requester.cookie)).notifiedRooms).toEqual([donor.id]);
    });
  });

  describe('the donor\'s own requests', () => {
    it('are unaffected: a donor inside the gap can still request blood, fulfil it and rate the donor', async () => {
      const someRequester = await registerRequester();
      const restingUser = await registerUser({ bloodGroup: 'O-', location: HOSPITAL });
      const helper = await registerUser({ bloodGroup: 'O-', location: NEARBY });
      await addInAppDonation(someRequester.id, restingUser.id, daysAgo(10));

      const created = await createAndSeeWhoMatched(restingUser.cookie);
      expect(created.notifiedRooms).toEqual([helper.id]);
      expect((await patchStatus(created.requestId, helper.cookie, 'accepted')).statusCode).toBe(200);
      expect((await patchFulfill(created.requestId, restingUser.cookie)).statusCode).toBe(200);
      const rateRes = await request(server)
        .post(`/api/requests/${created.requestId}/rate`)
        .set('Cookie', restingUser.cookie)
        .send({ rating: 5 });
      expect(rateRes.statusCode).toBe(200);
      const mine = await request(server).get('/api/requests/mine').set('Cookie', restingUser.cookie);
      expect(mine.body.requests.map((r) => r.status)).toEqual(['fulfilled']);
      // Requesting blood is not donating: the requester's own gap is unchanged
      expect((await getAuthCheck(restingUser.cookie)).body.user.nextEligibleDonationAt)
        .toBe(computeNextEligibleDonationAt(daysAgo(10)).toISOString());
    });
  });

  describe('GET /api/requests/incoming', () => {
    it('still lists nearby requests and the thank-you card for a donor inside the gap, with nextEligibleDonationAt', async () => {
      const requester = await registerRequester();
      const donor = await registerUser({ bloodGroup: 'O-' });
      const donated = await createBloodRequest(requester.id);
      expect((await patchStatus(donated._id, donor.cookie, 'accepted')).statusCode).toBe(200);
      expect((await patchFulfill(donated._id, requester.cookie)).statusCode).toBe(200);
      const pendingRequest = await createBloodRequest(requester.id);
      const { fulfilledAt } = await Request.findById(donated._id);

      const res = await getIncoming(donor.cookie);

      expect(res.statusCode).toBe(200);
      expect(res.body.hasActiveDonation).toBe(false);
      expect(res.body.nextEligibleDonationAt).toBe(computeNextEligibleDonationAt(fulfilledAt).toISOString());
      expect(res.body.incomingRequests.map((r) => [r._id, r.status]).sort()).toEqual(
        [[String(donated._id), 'fulfilled'], [String(pendingRequest._id), 'pending']].sort()
      );
      // Declining still works inside the gap
      expect((await patchStatus(pendingRequest._id, donor.cookie, 'declined')).statusCode).toBe(200);
    });

    it('returns nextEligibleDonationAt null for a donor who may donate', async () => {
      const donor = await registerUser({ bloodGroup: 'O-' });
      const res = await getIncoming(donor.cookie);
      expect(res.statusCode).toBe(200);
      expect(res.body.nextEligibleDonationAt).toBeNull();
    });
  });

  describe('nextEligibleDonationAt in user responses', () => {
    it('is null on sign-up and present on login, /auth/check and profile updates, never with the password', async () => {
      const donor = await registerUser({ bloodGroup: 'O-' });
      expect(donor.body.user.nextEligibleDonationAt).toBeNull();
      expect(donor.body.user).not.toHaveProperty('password');
      const date = indiaDateDaysAgo(3);
      const expected = nextEligibleAfterDate(date);

      const profileRes = await patchProfile(donor.cookie, { lastOutsideDonationDate: date });
      const checkRes = await getAuthCheck(donor.cookie);
      const loginRes = await request(server).post('/api/auth/login').send({ email: donor.email, password: 'password123' });

      [profileRes, checkRes, loginRes].forEach((res) => {
        expect(res.statusCode).toBe(200);
        expect(res.body.user.nextEligibleDonationAt).toBe(expected);
        expect(res.body.user.lastOutsideDonationDate).toBe(`${date}T00:00:00.000Z`);
        expect(res.body.user).not.toHaveProperty('password');
        expect(res.body.user._id).toBe(donor.id);
      });
    });
  });

  // Donor D holds accepted request A. The requester marks A fulfilled at the same moment D
  // accepts request B. D must end up with A fulfilled and B NOT accepted, whatever the order.
  describe('fulfil of the previous donation racing an accept', () => {
    const setUpRace = async () => {
      const requester = await registerRequester();
      const donor = await registerUser({ bloodGroup: 'O-' });
      const previous = await createBloodRequest(requester.id);
      const next = await createBloodRequest(requester.id);
      expect((await patchStatus(previous._id, donor.cookie, 'accepted')).statusCode).toBe(200);
      return { requester, donor, previous, next };
    };

    it('undoes an accept whose write landed just after the fulfil (403, request back to pending)', async () => {
      const { requester, donor, previous, next } = await setUpRace();
      const realFindOneAndUpdate = Request.findOneAndUpdate.bind(Request);
      let hasInjectedFulfil = false;
      let fulfilRes;
      let acceptWriteResult;

      // The accept's gap check has already run (A was still accepted, so no gap). Run the
      // requester's whole fulfil right before the accept's write, the window that check cannot
      // see. Flag set BEFORE awaiting so the fulfil's own findOneAndUpdate cannot re-inject.
      jest.spyOn(Request, 'findOneAndUpdate').mockImplementation(async (...args) => {
        if (hasInjectedFulfil) return realFindOneAndUpdate(...args);
        hasInjectedFulfil = true;
        fulfilRes = await patchFulfill(previous._id, requester.cookie);
        acceptWriteResult = await realFindOneAndUpdate(...args);
        return acceptWriteResult;
      });
      const socket = spyOnSocket();

      const acceptRes = await patchStatus(next._id, donor.cookie, 'accepted');

      expect(fulfilRes.statusCode).toBe(200);
      // A was no longer accepted, so one_active_donation_per_donor let the write through...
      expect(acceptWriteResult.status).toBe('accepted');
      // ...and the check after it caught the new donation and undid the accept
      const { fulfilledAt } = await Request.findById(previous._id);
      expect(acceptRes.statusCode).toBe(403);
      expect(acceptRes.body.nextEligibleDonationAt).toBe(computeNextEligibleDonationAt(fulfilledAt).toISOString());
      await expectStillPending(next._id);
      expect((await Request.findById(previous._id)).status).toBe('fulfilled');
      // The requester never hears of the undone accept; the donor still hears of the fulfil
      expect(socket.emit).not.toHaveBeenCalledWith('requestStatusUpdate', expect.objectContaining({ status: 'accepted' }));
      expect(socket.emit).toHaveBeenCalledWith('requestStatusUpdate', expect.objectContaining({ status: 'fulfilled' }));
      expect((await User.findById(donor.id)).isAvailable).toBe(true);
    });

    it('refuses an accept whose write landed just before the fulfil (409, active donation)', async () => {
      const { requester, donor, previous, next } = await setUpRace();
      const realFindOneAndUpdate = Request.findOneAndUpdate.bind(Request);
      let hasInjectedFulfil = false;
      let fulfilRes;

      // The accept's write runs first (A is still accepted, so the unique index rejects it),
      // then the fulfil
      jest.spyOn(Request, 'findOneAndUpdate').mockImplementation(async (...args) => {
        if (hasInjectedFulfil) return realFindOneAndUpdate(...args);
        hasInjectedFulfil = true;
        try {
          return await realFindOneAndUpdate(...args);
        } finally {
          fulfilRes = await patchFulfill(previous._id, requester.cookie);
        }
      });

      const acceptRes = await patchStatus(next._id, donor.cookie, 'accepted');

      expect(acceptRes.statusCode).toBe(409);
      expect(acceptRes.body.message).toBe(
        'You already have an active donation. Complete or wait for it to be cancelled before accepting another.'
      );
      expect(fulfilRes.statusCode).toBe(200);
      await expectStillPending(next._id);
      expect((await Request.findById(previous._id)).status).toBe('fulfilled');
    });

    it('never leaves the second request accepted when both are sent at once', async () => {
      const outcomes = [];
      for (let round = 0; round < 8; round += 1) {
        const { requester, donor, previous, next } = await setUpRace();

        const [fulfilRes, acceptRes] = await Promise.all([
          patchFulfill(previous._id, requester.cookie),
          patchStatus(next._id, donor.cookie, 'accepted'),
        ]);

        expect(fulfilRes.statusCode).toBe(200);
        expect([403, 409]).toContain(acceptRes.statusCode);
        await expectStillPending(next._id);
        expect(await Request.countDocuments({ matchedDonorId: donor.id, status: 'accepted' })).toBe(0);
        outcomes.push(acceptRes.statusCode);
      }
      // Which of the two refusals each round got depends on timing; both are correct
      expect(outcomes).toHaveLength(8);
    });

    it('does not undo an accept when its own request is fulfilled right after it (the existing 409)', async () => {
      const requester = await registerRequester();
      const donor = await registerUser({ bloodGroup: 'O-' });
      const bloodRequest = await createBloodRequest(requester.id);
      const realFindOneAndUpdate = Request.findOneAndUpdate.bind(Request);
      let hasInjectedFulfil = false;
      let fulfilRes;

      // Fulfil THIS request between the accept's write and its checks. It is a real donation by
      // this donor, but not a reason to undo the accept that led to it.
      jest.spyOn(Request, 'findOneAndUpdate').mockImplementation(async (...args) => {
        const result = await realFindOneAndUpdate(...args);
        if (!hasInjectedFulfil) {
          hasInjectedFulfil = true;
          fulfilRes = await patchFulfill(bloodRequest._id, requester.cookie);
        }
        return result;
      });

      const acceptRes = await patchStatus(bloodRequest._id, donor.cookie, 'accepted');

      expect(fulfilRes.statusCode).toBe(200);
      expect(acceptRes.statusCode).toBe(409);
      expect(acceptRes.body.message).toBe('This request has already been fulfilled');
      const stored = await Request.findById(bloodRequest._id);
      expect(stored.status).toBe('fulfilled');
      expect(stored.matchedDonorId.toString()).toBe(donor.id);
    });
  });
});
