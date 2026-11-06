const fs = require('fs');
const http = require('http');
const path = require('path');
const mongoose = require('mongoose');
const request = require('supertest');
const webpush = require('web-push');
const app = require('../index');
const Request = require('../models/request.model');
const User = require('../models/user.model');
const {
  computeNextEligibleDonationAt,
  findNextEligibleDonationAt,
  withDonationEligibility,
} = require('../utils/donationGap');
const {
  REMINDER_WINDOW_DAYS,
  REMINDER_FIRST_HOUR_IST,
  REMINDER_END_HOUR_IST,
  SWEEP_INTERVAL_MS,
  LAZY_SWEEP_MIN_GAP_MS,
  buildDonationReminderPayload,
  isReminderHourInIndia,
  sendDonationReminders,
  sendDonationRemindersIfDue,
  startDonationReminderSweeps,
} = require('../utils/donationReminders');
const { connectDB, closeDB, clearDB } = require('./db');
const { REGISTRATION_CONSENT } = require('./registration');

// Time is controlled through the donation dates written on create and through the sweep's nowMs.
// No fake timers: the driver and Mongoose need the real clock. Only the lazy trigger's tests, which
// go through routes that read the clock themselves, move Date.now() (setClockTo below).

// Coordinates are [longitude, latitude]
const HOSPITAL = [77.5946, 12.9716]; // Bangalore
const NEARBY = [77.6, 12.975]; // ~0.7 km from HOSPITAL

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// An instant from a wall-clock time in India (UTC+5:30 all year), e.g. '2026-05-01T09:00'
const ist = (wallTime) => Date.parse(`${wallTime}:00+05:30`);

// A donation at 10:00 IST on 1 January 2026 allows the next from 00:00 IST on 1 May 2026
const DONATED_AT = new Date(ist('2026-01-01T10:00'));
const ELIGIBLE_AT = new Date(ist('2026-05-01T00:00'));
// An outside donation date as the profile stores it: 00:00 UTC of the day picked, 1 January here
const OUTSIDE_DONATION_DATE = new Date('2026-01-01T00:00:00.000Z');

// Same shapes a browser's PushSubscription.toJSON() produces
const P256DH = Buffer.alloc(65, 4).toString('base64url');
const AUTH = Buffer.alloc(16, 7).toString('base64url');

// supertest dials 127.0.0.1, so bind there explicitly. request(app) binds `::`, and another
// local app on the same ephemeral port can answer instead.
let server;
let userCount = 0;
let sendNotificationSpy;
let consoleErrorSpy;
const savedVapidKeys = {};

beforeAll(async () => {
  await connectDB();
  // Builds every index first, { lastOutsideDonationDate } included
  await Request.init();
  await User.init();
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
});

beforeEach(() => {
  // tests/setupEnv.js leaves web push unconfigured; the sweep sends nothing without both keys
  savedVapidKeys.public = process.env.VAPID_PUBLIC_KEY;
  savedVapidKeys.private = process.env.VAPID_PRIVATE_KEY;
  process.env.VAPID_PUBLIC_KEY = 'test-vapid-public-key';
  process.env.VAPID_PRIVATE_KEY = 'test-vapid-private-key';
  // Never reach a real push service
  sendNotificationSpy = jest.spyOn(webpush, 'sendNotification').mockResolvedValue({ statusCode: 201 });
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  process.env.VAPID_PUBLIC_KEY = savedVapidKeys.public;
  process.env.VAPID_PRIVATE_KEY = savedVapidKeys.private;
  jest.restoreAllMocks();
  await clearDB();
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await closeDB();
});

const subscriptionFor = (endpointId) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/reminder-${endpointId}`,
  expirationTime: null,
  keys: { p256dh: P256DH, auth: AUTH },
});

// Straight on the model: these donors never log in, so the password is never checked
const createDonor = async ({ subscribed = true, lastOutsideDonationDate = null, subscription } = {}) => {
  userCount += 1;
  return User.create({
    name: `Reminder Donor ${userCount}`,
    email: `reminder.donor${userCount}@example.com`,
    password: 'not-a-real-hash',
    bloodGroup: 'O-',
    location: { type: 'Point', coordinates: NEARBY },
    pushSubscription: subscribed ? subscription || subscriptionFor(userCount) : null,
    lastOutsideDonationDate,
  });
};

// A donation completed through Donor: a fulfilled request with this donor as its donor
const recordDonation = (donorId, fulfilledAt, { requesterId = new mongoose.Types.ObjectId() } = {}) =>
  Request.create({
    requesterId,
    bloodGroup: 'B+',
    unitsNeeded: 1,
    hospitalName: 'Reminder Test Hospital',
    hospitalLocation: { type: 'Point', coordinates: HOSPITAL },
    status: 'fulfilled',
    matchedDonorId: donorId,
    fulfilledAt,
  });

const runAt = (wallTime) => sendDonationReminders({ nowMs: ist(wallTime) });

// The endpoints sent to, in order: one per push
const sentEndpoints = () => sendNotificationSpy.mock.calls.map(([subscription]) => subscription.endpoint);

const storedReminderFor = async (donorId) => (await User.collection.findOne({ _id: donorId })).donationReminderSentFor;

describe('the reminder itself', () => {
  it('says the donor can donate again from today, and a tap opens the dashboard', async () => {
    const donor = await createDonor();
    await recordDonation(donor._id, DONATED_AT);

    const reminded = await runAt('2026-05-01T09:00');

    expect(reminded.map(String)).toEqual([String(donor._id)]);
    expect(sendNotificationSpy).toHaveBeenCalledTimes(1);
    const [subscription, payload] = sendNotificationSpy.mock.calls[0];
    // The subscription as stored: the claim's own fresh read of it
    expect(subscription).toEqual(donor.pushSubscription);
    expect(JSON.parse(payload)).toEqual({
      title: 'You can donate again',
      body: 'You can donate blood again from today. Thank you for helping.',
      icon: '/pwa-192x192.png',
      // client/src/sw.js opens data.url when the notification is tapped
      data: { url: '/dashboard' },
    });
    // Names no one: the same payload for every donor
    expect(payload).toBe(buildDonationReminderPayload());
    expect(payload).not.toContain(donor.name);
    expect(payload).not.toContain(String(donor._id));
    // The moment it was for is recorded, so it is never sent again
    expect(await storedReminderFor(donor._id)).toEqual(ELIGIBLE_AT);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('agrees with the gap the accept rule uses: the moment it is for is when the donor may donate again', async () => {
    const donor = await createDonor();
    await recordDonation(donor._id, DONATED_AT);

    expect(computeNextEligibleDonationAt(DONATED_AT)).toEqual(ELIGIBLE_AT);
    // Resting until that moment, free from it
    expect(await findNextEligibleDonationAt(donor._id, null, { nowMs: ELIGIBLE_AT.getTime() - 1 })).toEqual(ELIGIBLE_AT);
    expect(await findNextEligibleDonationAt(donor._id, null, { nowMs: ELIGIBLE_AT.getTime() })).toBeNull();
  });

  it('is left out of the donor\'s own profile response', async () => {
    const donor = await createDonor();
    await User.updateOne({ _id: donor._id }, { $set: { donationReminderSentFor: ELIGIBLE_AT } });

    const profile = await withDonationEligibility(await User.findById(donor._id));

    expect(profile).not.toHaveProperty('donationReminderSentFor');
    expect(profile).toHaveProperty('pushSubscription');
  });
});

describe('the time window', () => {
  it(`goes out from the moment the gap ends until ${REMINDER_WINDOW_DAYS} days after it, never before`, async () => {
    expect(REMINDER_WINDOW_DAYS).toBe(3);
    const early = await createDonor();
    await recordDonation(early._id, DONATED_AT);

    // The evening before: still inside the gap
    expect(await runAt('2026-04-30T20:00')).toEqual([]);
    expect(sendNotificationSpy).not.toHaveBeenCalled();

    // The last daytime run inside the 3 days after 00:00 IST on 1 May
    expect((await runAt('2026-05-03T20:59')).map(String)).toEqual([String(early._id)]);
  });

  it(`sends nothing once more than ${REMINDER_WINDOW_DAYS} days have passed since the gap ended`, async () => {
    const late = await createDonor();
    await recordDonation(late._id, DONATED_AT);

    // The first daytime run after 00:00 IST on 4 May, 3 days and 8 hours after the gap ended
    expect(await runAt('2026-05-04T08:00')).toEqual([]);
    expect(sendNotificationSpy).not.toHaveBeenCalled();
    expect(await storedReminderFor(late._id)).toBeUndefined();
  });

  it('sends nothing to donors whose gap ended long ago, so a first run (after a deploy) is not a flood', async () => {
    for (let index = 0; index < 5; index += 1) {
      const donor = await createDonor();
      // 200 to 240 days ago: each gap ended 80 to 120 days ago
      await recordDonation(donor._id, new Date(ist('2026-05-01T09:00') - (200 + index * 10) * DAY_MS));
    }
    const outsideOnly = await createDonor({ lastOutsideDonationDate: new Date('2025-06-01T00:00:00.000Z') });

    expect(await runAt('2026-05-01T09:00')).toEqual([]);
    expect(sendNotificationSpy).not.toHaveBeenCalled();
    expect(await storedReminderFor(outsideOnly._id)).toBeUndefined();
  });

  it(`goes out only from ${REMINDER_FIRST_HOUR_IST}:00 until ${REMINDER_END_HOUR_IST}:00 India time`, async () => {
    expect([REMINDER_FIRST_HOUR_IST, REMINDER_END_HOUR_IST]).toEqual([8, 21]);
    expect(isReminderHourInIndia(ist('2026-05-01T07:59'))).toBe(false);
    expect(isReminderHourInIndia(ist('2026-05-01T08:00'))).toBe(true);
    expect(isReminderHourInIndia(ist('2026-05-01T20:59'))).toBe(true);
    expect(isReminderHourInIndia(ist('2026-05-01T21:00'))).toBe(false);

    const donor = await createDonor();
    await recordDonation(donor._id, DONATED_AT);

    // Midnight, when the gap ends, and the small hours: nothing, and nothing claimed
    expect(await runAt('2026-05-01T00:00')).toEqual([]);
    expect(await runAt('2026-05-01T07:59')).toEqual([]);
    expect(await storedReminderFor(donor._id)).toBeUndefined();
    expect(sendNotificationSpy).not.toHaveBeenCalled();

    expect((await runAt('2026-05-01T08:00')).map(String)).toEqual([String(donor._id)]);
  });
});

describe('once per gap', () => {
  it('is sent once, however many times the sweep runs inside the window', async () => {
    const donor = await createDonor();
    await recordDonation(donor._id, DONATED_AT);

    for (const wallTime of ['2026-05-01T08:00', '2026-05-01T08:30', '2026-05-01T15:00', '2026-05-02T10:00', '2026-05-03T20:30']) {
      await runAt(wallTime);
    }

    expect(sentEndpoints()).toEqual([donor.pushSubscription.endpoint]);
  });

  it('is sent once per donor when several sweeps run at the same moment (two servers, or overlapping runs)', async () => {
    const donors = [];
    for (let index = 0; index < 3; index += 1) {
      const donor = await createDonor();
      await recordDonation(donor._id, DONATED_AT);
      donors.push(donor);
    }

    const runs = await Promise.all(Array.from({ length: 6 }, () => runAt('2026-05-01T09:00')));

    // Each donor was claimed by exactly one of the runs
    expect(runs.flat().map(String).sort()).toEqual(donors.map((donor) => String(donor._id)).sort());
    expect(sentEndpoints().sort()).toEqual(donors.map((donor) => donor.pushSubscription.endpoint).sort());
  });

  it('is sent again after a later donation through Donor, once that gap ends too', async () => {
    const donor = await createDonor();
    await recordDonation(donor._id, DONATED_AT);
    await runAt('2026-05-01T09:00');

    // Donates again on 10 May; the new gap ends at 00:00 IST on 7 September
    await recordDonation(donor._id, new Date(ist('2026-05-10T11:00')));
    expect(await runAt('2026-05-10T12:00')).toEqual([]);
    expect(await runAt('2026-09-06T20:00')).toEqual([]);
    expect((await runAt('2026-09-07T09:00')).map(String)).toEqual([String(donor._id)]);
    expect(await runAt('2026-09-08T09:00')).toEqual([]);

    expect(sentEndpoints()).toEqual([donor.pushSubscription.endpoint, donor.pushSubscription.endpoint]);
    expect(await storedReminderFor(donor._id)).toEqual(new Date(ist('2026-09-07T00:00')));
  });

  it('is not sent while a newer donation still holds the donor in a new gap', async () => {
    const throughDonor = await createDonor();
    await recordDonation(throughDonor._id, DONATED_AT);
    await recordDonation(throughDonor._id, new Date(ist('2026-04-20T10:00')));
    // An outside donation reported after the one through Donor
    const reportedOutside = await createDonor({ lastOutsideDonationDate: new Date('2026-04-25T00:00:00.000Z') });
    await recordDonation(reportedOutside._id, DONATED_AT);

    expect(await runAt('2026-05-01T09:00')).toEqual([]);
    expect(sendNotificationSpy).not.toHaveBeenCalled();
  });

  it('is sent again when the outside donation date is moved later, but not when it is moved earlier', async () => {
    const donor = await createDonor({ lastOutsideDonationDate: OUTSIDE_DONATION_DATE });
    await runAt('2026-05-01T09:00');

    // The donor corrects it to the next day: the gap now ends on 2 May
    await User.updateOne({ _id: donor._id }, { $set: { lastOutsideDonationDate: new Date('2026-01-02T00:00:00.000Z') } });
    expect((await runAt('2026-05-02T09:00')).map(String)).toEqual([String(donor._id)]);

    // And back to 1 January: a gap that ended before the one just reminded of gets nothing
    await User.updateOne({ _id: donor._id }, { $set: { lastOutsideDonationDate: OUTSIDE_DONATION_DATE } });
    expect(await runAt('2026-05-02T10:00')).toEqual([]);

    expect(sendNotificationSpy).toHaveBeenCalledTimes(2);
    expect(await storedReminderFor(donor._id)).toEqual(new Date(ist('2026-05-02T00:00')));
  });
});

describe('who gets it', () => {
  it('reaches a donor whose only donation is an outside one they entered', async () => {
    const donor = await createDonor({ lastOutsideDonationDate: OUTSIDE_DONATION_DATE });

    expect((await runAt('2026-05-01T09:00')).map(String)).toEqual([String(donor._id)]);
    expect(await storedReminderFor(donor._id)).toEqual(ELIGIBLE_AT);
  });

  it('reaches the donor of a donation whose requester deleted their account', async () => {
    const donor = await createDonor();
    // Kept, anonymised, by deleteAccount: requesterId null
    await recordDonation(donor._id, DONATED_AT, { requesterId: null });

    expect((await runAt('2026-05-01T09:00')).map(String)).toEqual([String(donor._id)]);
  });

  it('skips a donor without a push subscription, and claims nothing for them', async () => {
    const donor = await createDonor({ subscribed: false });
    await recordDonation(donor._id, DONATED_AT);
    const outsideOnly = await createDonor({ subscribed: false, lastOutsideDonationDate: OUTSIDE_DONATION_DATE });

    expect(await runAt('2026-05-01T09:00')).toEqual([]);
    expect(sendNotificationSpy).not.toHaveBeenCalled();
    expect(await storedReminderFor(donor._id)).toBeUndefined();
    expect(await storedReminderFor(outsideOnly._id)).toBeUndefined();

    // Turns notifications on the next day, still inside the window
    await User.updateOne({ _id: donor._id }, { $set: { pushSubscription: subscriptionFor('late') } });
    expect((await runAt('2026-05-02T09:00')).map(String)).toEqual([String(donor._id)]);
  });

  it('skips a donor who switched "Available to donate" off, without even trying to claim them', async () => {
    const donor = await createDonor();
    await recordDonation(donor._id, DONATED_AT);
    const outsideOnly = await createDonor({ lastOutsideDonationDate: OUTSIDE_DONATION_DATE });
    await User.updateMany({ _id: { $in: [donor._id, outsideOnly._id] } }, { $set: { isAvailable: false } });
    const claimSpy = jest.spyOn(User, 'findOneAndUpdate');

    expect(await runAt('2026-05-01T09:00')).toEqual([]);
    expect(sendNotificationSpy).not.toHaveBeenCalled();
    expect(claimSpy).not.toHaveBeenCalled();
    expect(await storedReminderFor(donor._id)).toBeUndefined();
    expect(await storedReminderFor(outsideOnly._id)).toBeUndefined();

    // Switched back on the next day, still inside the window
    await User.updateOne({ _id: donor._id }, { $set: { isAvailable: true } });
    expect((await runAt('2026-05-02T09:00')).map(String)).toEqual([String(donor._id)]);
  });

  it('skips a donor who switches "Available to donate" off after the sweep read them', async () => {
    const donor = await createDonor();
    await recordDonation(donor._id, DONATED_AT);
    // The sweep's read of candidates, followed at once by the donor switching availability off
    const originalFind = User.find.bind(User);
    let candidatesRead = [];
    jest.spyOn(User, 'find').mockImplementation((filter) => ({
      select: (fields) => ({
        lean: async () => {
          candidatesRead = await originalFind(filter).select(fields).lean();
          await User.updateOne({ _id: donor._id }, { $set: { isAvailable: false } });
          return candidatesRead;
        },
      }),
    }));

    expect(await runAt('2026-05-01T09:00')).toEqual([]);

    // They were a candidate when read, so only the claim's own condition kept the push from going
    expect(candidatesRead.map((candidate) => String(candidate._id))).toEqual([String(donor._id)]);
    expect(sendNotificationSpy).not.toHaveBeenCalled();
    expect(await storedReminderFor(donor._id)).toBeUndefined();
  });

  it('skips someone who has never donated', async () => {
    await createDonor();

    expect(await runAt('2026-05-01T09:00')).toEqual([]);
    expect(sendNotificationSpy).not.toHaveBeenCalled();
  });

  it('does not count a request that is not fulfilled, or someone else\'s donation', async () => {
    const donor = await createDonor();
    const other = await createDonor();
    await recordDonation(other._id, DONATED_AT);
    await Request.create({
      requesterId: new mongoose.Types.ObjectId(),
      bloodGroup: 'B+',
      unitsNeeded: 1,
      hospitalName: 'Reminder Test Hospital',
      hospitalLocation: { type: 'Point', coordinates: HOSPITAL },
      status: 'cancelled',
      matchedDonorId: donor._id,
      fulfilledAt: DONATED_AT,
    });

    expect((await runAt('2026-05-01T09:00')).map(String)).toEqual([String(other._id)]);
  });
});

describe('without web push', () => {
  it('sends and claims nothing without the VAPID keys, and sends once they are set inside the window', async () => {
    process.env.VAPID_PUBLIC_KEY = '';
    process.env.VAPID_PRIVATE_KEY = '';
    const donor = await createDonor();
    await recordDonation(donor._id, DONATED_AT);
    const findSpy = jest.spyOn(User, 'find');

    expect(await runAt('2026-05-01T09:00')).toEqual([]);
    expect(sendNotificationSpy).not.toHaveBeenCalled();
    expect(await storedReminderFor(donor._id)).toBeUndefined();
    // It does not even look for donors
    expect(findSpy).not.toHaveBeenCalled();

    process.env.VAPID_PUBLIC_KEY = 'test-vapid-public-key';
    expect(await runAt('2026-05-01T10:00')).toEqual([]);
    process.env.VAPID_PRIVATE_KEY = 'test-vapid-private-key';
    expect((await runAt('2026-05-01T11:00')).map(String)).toEqual([String(donor._id)]);
  });
});

describe('failed sends', () => {
  it.each([410, 404])('removes a subscription the push service answers %i for, and does not try again', async (statusCode) => {
    const donor = await createDonor();
    await recordDonation(donor._id, DONATED_AT);
    sendNotificationSpy.mockRejectedValue(Object.assign(new Error('Push subscription has unsubscribed or expired.'), { statusCode }));

    expect((await runAt('2026-05-01T09:00')).map(String)).toEqual([String(donor._id)]);

    const stored = await User.collection.findOne({ _id: donor._id });
    expect(stored.pushSubscription).toBeNull();
    expect(stored.donationReminderSentFor).toEqual(ELIGIBLE_AT);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      `Failed to send the donation reminder to donor ${donor._id}:`,
      'Push subscription has unsubscribed or expired.'
    );

    // A new subscription the same day still gets nothing: this gap's reminder was used
    await User.updateOne({ _id: donor._id }, { $set: { pushSubscription: subscriptionFor('renewed') } });
    expect(await runAt('2026-05-01T10:00')).toEqual([]);
    expect(sendNotificationSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps the subscription after any other failure', async () => {
    const donor = await createDonor();
    await recordDonation(donor._id, DONATED_AT);
    sendNotificationSpy.mockRejectedValue(Object.assign(new Error('Received unexpected response code'), { statusCode: 500 }));

    await runAt('2026-05-01T09:00');

    expect((await User.collection.findOne({ _id: donor._id })).pushSubscription).toEqual(donor.pushSubscription);
  });

  it('keeps a new subscription saved while a failing send was on its way', async () => {
    const donor = await createDonor();
    await recordDonation(donor._id, DONATED_AT);
    const renewed = subscriptionFor('saved-meanwhile');
    sendNotificationSpy.mockImplementation(async () => {
      await User.updateOne({ _id: donor._id }, { $set: { pushSubscription: renewed } });
      throw Object.assign(new Error('Push subscription has unsubscribed or expired.'), { statusCode: 410 });
    });

    await runAt('2026-05-01T09:00');

    expect((await User.collection.findOne({ _id: donor._id })).pushSubscription).toEqual(renewed);
  });

  it('removes a stored subscription whose endpoint is not an allowed push service, without sending', async () => {
    const donor = await createDonor({
      subscription: { endpoint: 'https://169.254.169.254/latest', expirationTime: null, keys: { p256dh: P256DH, auth: AUTH } },
    });
    await recordDonation(donor._id, DONATED_AT);

    expect(await runAt('2026-05-01T09:00')).toEqual([]);

    expect(sendNotificationSpy).not.toHaveBeenCalled();
    const stored = await User.collection.findOne({ _id: donor._id });
    expect(stored.pushSubscription).toBeNull();
    expect(stored).not.toHaveProperty('donationReminderSentFor');
  });
});

describe('finding donors', () => {
  it('reads users through indexes, never the whole collection', async () => {
    const donor = await createDonor({ lastOutsideDonationDate: OUTSIDE_DONATION_DATE });
    await recordDonation(donor._id, DONATED_AT);
    const findSpy = jest.spyOn(User, 'find');

    await runAt('2026-05-01T09:00');

    // The sweep's one read of users, explained instead of run
    expect(findSpy).toHaveBeenCalledTimes(1);
    const [filter] = findSpy.mock.calls[0];
    findSpy.mockRestore();
    const explained = await User.find(filter).explain('queryPlanner');
    const winningPlan = JSON.stringify(explained.queryPlanner.winningPlan);
    expect(winningPlan).toContain('IXSCAN');
    expect(winningPlan).not.toContain('COLLSCAN');
  });
});

describe('the lazy trigger (sendDonationRemindersIfDue)', () => {
  const realDateNow = Date.now.bind(Date);
  // Date.now() reads from instantMs on, still advancing. Only Date.now: the driver and Mongoose
  // keep the real clock. Each test below starts in a later year-2030 month than the one before, so
  // none is held back by the gap after an earlier test's sweep.
  const setClockTo = (instantMs) => {
    const offsetMs = realDateNow() - instantMs;
    jest.spyOn(Date, 'now').mockImplementation(() => realDateNow() - offsetMs);
  };

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitUntil = async (condition, timeoutMs = 3000) => {
    const deadline = realDateNow() + timeoutMs;
    while (!condition()) {
      if (realDateNow() > deadline) throw new Error(`condition not met within ${timeoutMs} ms`);
      await delay(10);
    }
  };

  // A donation whose gap ends at 00:00 IST on indiaDate (YYYY-MM-DD): 10:00 IST, 120 days before
  const donationEndingGapOn = (indiaDate) => new Date(ist(`${indiaDate}T10:00`) - 120 * DAY_MS);

  const createDonorWithReminderDue = async (indiaDate) => {
    const donor = await createDonor();
    await recordDonation(donor._id, donationEndingGapOn(indiaDate));
    return donor;
  };

  // Through the API, for a login cookie, with the clock already set: the token is dated by it
  const registerDonorWithReminderDue = async (indiaDate) => {
    userCount += 1;
    const res = await request(server)
      .post('/api/auth/register')
      .send({
        name: `Lazy Donor ${userCount}`,
        email: `lazy.donor${userCount}@example.com`,
        password: 'password123',
        bloodGroup: 'O-',
        location: NEARBY,
        ...REGISTRATION_CONSENT,
      });
    expect(res.statusCode).toBe(201);
    const id = new mongoose.Types.ObjectId(String(res.body.user._id));
    const subscription = subscriptionFor(`lazy-${userCount}`);
    await User.updateOne({ _id: id }, { $set: { pushSubscription: subscription } });
    await recordDonation(id, donationEndingGapOn(indiaDate));
    return { id, cookie: res.headers['set-cookie'], subscription };
  };

  const asDonor = (donor, url) => request(server).get(url).set('Cookie', donor.cookie);

  it('sweeps at most once per 10 minutes', async () => {
    expect(LAZY_SWEEP_MIN_GAP_MS).toBe(10 * MINUTE_MS);
    const startMs = ist('2030-05-01T09:00');
    const first = await createDonorWithReminderDue('2030-05-01');

    expect((await sendDonationRemindersIfDue(startMs)).map(String)).toEqual([String(first._id)]);

    const second = await createDonorWithReminderDue('2030-05-01');
    const findSpy = jest.spyOn(User, 'find');
    expect(await sendDonationRemindersIfDue(startMs + LAZY_SWEEP_MIN_GAP_MS - 1)).toEqual([]);
    // Not even a read
    expect(findSpy).not.toHaveBeenCalled();
    expect(sentEndpoints()).toEqual([first.pushSubscription.endpoint]);

    expect((await sendDonationRemindersIfDue(startMs + LAZY_SWEEP_MIN_GAP_MS)).map(String)).toEqual([String(second._id)]);
  });

  it('counts the startup and interval sweeps in that gap', async () => {
    setClockTo(ist('2030-06-01T09:00'));
    const donor = await createDonorWithReminderDue('2030-06-01');
    const { firstSweep, stop } = startDonationReminderSweeps();
    stop();
    expect((await firstSweep).map(String)).toEqual([String(donor._id)]);

    await createDonorWithReminderDue('2030-06-01');
    expect(await sendDonationRemindersIfDue(ist('2030-06-01T09:09'))).toEqual([]);
    expect(sendNotificationSpy).toHaveBeenCalledTimes(1);
  });

  it('joins a sweep that is already running instead of starting another', async () => {
    const startMs = ist('2030-07-01T09:00');
    const donor = await createDonorWithReminderDue('2030-07-01');
    const findSpy = jest.spyOn(User, 'find');

    const running = sendDonationRemindersIfDue(startMs);
    const joining = sendDonationRemindersIfDue(startMs + 1);

    expect(joining).toBe(running);
    expect((await running).map(String)).toEqual([String(donor._id)]);
    expect(findSpy).toHaveBeenCalledTimes(1);
    expect(sendNotificationSpy).toHaveBeenCalledTimes(1);
  });

  it('is started by checkAuth (every page load), which answers without waiting for it', async () => {
    setClockTo(ist('2030-08-01T09:00'));
    const donor = await registerDonorWithReminderDue('2030-08-01');
    // The sweep's first read waits until released, so the sweep stays running
    let releaseSweep;
    const sweepReleased = new Promise((resolve) => {
      releaseSweep = resolve;
    });
    const realDistinct = Request.distinct.bind(Request);
    const distinctSpy = jest.spyOn(Request, 'distinct').mockImplementation(async (...args) => {
      await sweepReleased;
      return realDistinct(...args);
    });

    let res;
    try {
      res = await Promise.race([asDonor(donor, '/api/auth/check'), delay(2000).then(() => 'still waiting after 2 s')]);
    } finally {
      releaseSweep();
    }

    expect(res).not.toBe('still waiting after 2 s');
    expect(res.statusCode).toBe(200);
    expect(res.body.user._id).toBe(String(donor.id));
    // checkAuth started the sweep before answering, and the sweep the answer did not wait for sends
    expect(distinctSpy).toHaveBeenCalledTimes(1);
    await waitUntil(() => sendNotificationSpy.mock.calls.length === 1);
    expect(sentEndpoints()).toEqual([donor.subscription.endpoint]);
    expect(await storedReminderFor(donor.id)).toEqual(new Date(ist('2030-08-01T00:00')));
  });

  it('is started by the incoming requests list too', async () => {
    setClockTo(ist('2030-09-01T09:00'));
    const donor = await registerDonorWithReminderDue('2030-09-01');

    const res = await asDonor(donor, '/api/requests/incoming');

    expect(res.statusCode).toBe(200);
    await waitUntil(() => sendNotificationSpy.mock.calls.length === 1);
    expect(sentEndpoints()).toEqual([donor.subscription.endpoint]);
  });

  it('does not break checkAuth or the incoming list when the sweep fails', async () => {
    setClockTo(ist('2030-10-01T09:00'));
    const donor = await registerDonorWithReminderDue('2030-10-01');
    jest.spyOn(Request, 'distinct').mockRejectedValue(new Error('forced reminder sweep failure'));
    const sweepFailures = () =>
      consoleErrorSpy.mock.calls.filter(([message]) => message === 'Sending donation reminders failed:').length;

    const checkRes = await asDonor(donor, '/api/auth/check');
    expect(checkRes.statusCode).toBe(200);
    expect(checkRes.body.user._id).toBe(String(donor.id));
    await waitUntil(() => sweepFailures() === 1);

    // Past the gap, so the list starts a sweep of its own
    setClockTo(ist('2030-10-01T09:11'));
    const incomingRes = await asDonor(donor, '/api/requests/incoming');
    expect(incomingRes.statusCode).toBe(200);
    expect(Array.isArray(incomingRes.body.incomingRequests)).toBe(true);
    await waitUntil(() => sweepFailures() === 2);

    expect(consoleErrorSpy).toHaveBeenCalledWith('Sending donation reminders failed:', 'forced reminder sweep failure');
    expect(sendNotificationSpy).not.toHaveBeenCalled();
  });
});

describe('sweep schedule', () => {
  it('sweeps once at startup, then on an unref\'d 30-minute interval that stop() clears', async () => {
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval');

    const { firstSweep, stop } = startDonationReminderSweeps();
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

    expect(SWEEP_INTERVAL_MS).toBe(30 * MINUTE_MS);
    expect(timer).not.toBeNull();
    // Unref'd: it never keeps Node (or Jest) running
    expect(hadRef).toBe(false);
    expect(Array.isArray(await firstSweep)).toBe(true);
    expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
  });

  it('is started by index.js once the database is connected', () => {
    const indexSource = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
    const startServer = indexSource.slice(indexSource.indexOf('const startServer'));

    expect(startServer.indexOf('await connectDB()')).toBeGreaterThan(-1);
    expect(startServer.indexOf('startDonationReminderSweeps()')).toBeGreaterThan(startServer.indexOf('await connectDB()'));
  });
});
