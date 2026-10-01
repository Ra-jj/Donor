const fs = require('fs');
const http = require('http');
const path = require('path');
const mongoose = require('mongoose');
const request = require('supertest');
const app = require('../index');
const Request = require('../models/request.model');
const User = require('../models/user.model');
const { PRIVACY_NOTICE_VERSION } = require('../utils/privacyConsent');
const { connectDB, closeDB, clearDB } = require('./db');
const { REGISTRATION_CONSENT } = require('./registration');

// supertest dials 127.0.0.1, so bind there explicitly. request(app) binds `::`, and another
// local app on the same ephemeral port can answer instead.
let server;

beforeAll(async () => {
  await connectDB();
  // Mongoose builds indexes in the background; wait so the geo and unique indexes exist
  await Request.init();
  await User.init();
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

// Coordinates are [longitude, latitude]
const HOSPITAL = [77.5946, 12.9716]; // Bangalore
const NEARBY = [77.6, 12.975]; // ~0.7 km from HOSPITAL

const PASSWORD = 'password123';
const OLDER_VERSION = '2025-01-01';
const ACCEPT_PRIVACY_ERROR = 'Agree to the Privacy Notice to continue';
const CONFIRM_ADULT_ERROR = 'Confirm you are 18 or older to continue';
const CONSENT_FIELD_NAMES = ['privacyConsent', 'privacyConsentHistory', 'adultConfirmedAt', 'needsPrivacyConsent'];

let userCount = 0;

const buildSignUpBody = (overrides = {}) => {
  userCount += 1;
  return {
    name: `Consent User ${userCount}`,
    email: `consent.user${userCount}@example.com`,
    password: PASSWORD,
    bloodGroup: 'O-',
    location: NEARBY,
    ...REGISTRATION_CONSENT,
    ...overrides,
  };
};

// Register through the API and reuse the cookie register sets (login is rate limited)
const registerUser = async (overrides) => {
  const body = buildSignUpBody(overrides);
  const res = await request(server).post('/api/auth/register').send(body);
  expect(res.statusCode).toBe(201);
  return { id: res.body.user._id, name: body.name, email: body.email, cookie: res.headers['set-cookie'], body: res.body };
};

// The stored document as MongoDB has it, without Mongoose defaults filling in missing fields
const readStoredUser = (userId) => User.collection.findOne({ _id: new mongoose.Types.ObjectId(userId) });

// An account from before consent was recorded: neither field exists at all
const makeLegacyAccount = async (userId) => {
  await User.updateOne({ _id: userId }, { $unset: { privacyConsent: 1, adultConfirmedAt: 1 } });
  const stored = await readStoredUser(userId);
  expect(stored).not.toHaveProperty('privacyConsent');
  expect(stored).not.toHaveProperty('adultConfirmedAt');
};

const setAgreedVersion = (userId, version) => User.updateOne({ _id: userId }, { $set: { 'privacyConsent.version': version } });

// A user whose only agreement was to an older notice: the current record and its history entry
const makeOlderVersionAccount = (userId) =>
  User.updateOne(
    { _id: userId },
    { $set: { 'privacyConsent.version': OLDER_VERSION, 'privacyConsentHistory.0.version': OLDER_VERSION } }
  );

const checkAuth = (user) => request(server).get('/api/auth/check').set('Cookie', user.cookie);
const login = (user) => request(server).post('/api/auth/login').send({ email: user.email, password: PASSWORD });
const postConsent = (user, body) => request(server).post('/api/users/privacy-consent').set('Cookie', user.cookie).send(body);

const expectBetween = (isoOrDate, earliestMs, latestMs) => {
  const ms = new Date(isoOrDate).getTime();
  expect(ms).toBeGreaterThanOrEqual(earliestMs);
  expect(ms).toBeLessThanOrEqual(latestMs);
};

const expectNoConsentData = (responseBody) => {
  const serialised = JSON.stringify(responseBody);
  CONSENT_FIELD_NAMES.forEach((fieldName) => expect(serialised).not.toContain(fieldName));
};

// Each bad consent value, alone or with the other; every other field of the sign-up is valid.
// undefined leaves the field out of the JSON body entirely.
const BAD_CONSENT_BODIES = [
  ['acceptPrivacy is missing', { acceptPrivacy: undefined }],
  ['confirmAdult is missing', { confirmAdult: undefined }],
  ['both are missing', { acceptPrivacy: undefined, confirmAdult: undefined }],
  ['acceptPrivacy is false', { acceptPrivacy: false }],
  ['confirmAdult is false', { confirmAdult: false }],
  ['both are false', { acceptPrivacy: false, confirmAdult: false }],
  ['acceptPrivacy is the string "true"', { acceptPrivacy: 'true' }],
  ['confirmAdult is the string "true"', { confirmAdult: 'true' }],
  ['acceptPrivacy is 1', { acceptPrivacy: 1 }],
  ['confirmAdult is null', { confirmAdult: null }],
];

// The field errors the validate middleware reports for one of the bodies above
const expectedConsentErrors = (overrides) => {
  const errors = {};
  if ('acceptPrivacy' in overrides) errors.acceptPrivacy = ACCEPT_PRIVACY_ERROR;
  if ('confirmAdult' in overrides) errors.confirmAdult = CONFIRM_ADULT_ERROR;
  return errors;
};

describe('POST /api/auth/register privacy consent', () => {
  it.each(BAD_CONSENT_BODIES)('refuses a sign-up where %s, and creates no account', async (_label, overrides) => {
    const res = await request(server).post('/api/auth/register').send(buildSignUpBody(overrides));

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: 'Validation failed', errors: expectedConsentErrors(overrides) });
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(await User.countDocuments()).toBe(0);
  });

  it('records the current notice version and the server time, ignoring any the client sends', async () => {
    const earliestMs = Date.now();
    const user = await registerUser({
      privacyConsent: { version: '1999-01-01', acceptedAt: '1999-01-01T00:00:00.000Z' },
      adultConfirmedAt: '1999-01-01T00:00:00.000Z',
      privacyConsentHistory: [{ version: '1999-01-01', acceptedAt: '1999-01-01T00:00:00.000Z' }],
      needsPrivacyConsent: false,
    });
    const latestMs = Date.now();

    const stored = await readStoredUser(user.id);
    expect(stored.privacyConsent).toEqual({ version: PRIVACY_NOTICE_VERSION, acceptedAt: expect.any(Date) });
    expectBetween(stored.privacyConsent.acceptedAt, earliestMs, latestMs);
    expect(stored.adultConfirmedAt).toEqual(stored.privacyConsent.acceptedAt);
    // The history starts with this one agreement
    expect(stored.privacyConsentHistory).toEqual([stored.privacyConsent]);

    expect(user.body.user).toMatchObject({
      privacyConsent: { version: PRIVACY_NOTICE_VERSION, acceptedAt: stored.privacyConsent.acceptedAt.toISOString() },
      adultConfirmedAt: stored.adultConfirmedAt.toISOString(),
      needsPrivacyConsent: false,
    });
    expect(user.body.user).not.toHaveProperty('password');
    expect(user.body.user).not.toHaveProperty('privacyConsentHistory');
  });
});

describe('needsPrivacyConsent in auth responses', () => {
  it('is true for an account from before consent was recorded, on check and on login', async () => {
    const user = await registerUser();
    await makeLegacyAccount(user.id);

    const checkRes = await checkAuth(user);
    expect(checkRes.statusCode).toBe(200);
    expect(checkRes.body.user).toMatchObject({ privacyConsent: null, adultConfirmedAt: null, needsPrivacyConsent: true });

    const loginRes = await login(user);
    expect(loginRes.statusCode).toBe(200);
    expect(loginRes.body.user).toMatchObject({ privacyConsent: null, adultConfirmedAt: null, needsPrivacyConsent: true });
  });

  it('is true for a user who agreed to an older version, on check and on login', async () => {
    const user = await registerUser();
    await setAgreedVersion(user.id, OLDER_VERSION);

    const checkRes = await checkAuth(user);
    expect(checkRes.statusCode).toBe(200);
    expect(checkRes.body.user.needsPrivacyConsent).toBe(true);
    expect(checkRes.body.user.privacyConsent.version).toBe(OLDER_VERSION);

    const loginRes = await login(user);
    expect(loginRes.statusCode).toBe(200);
    expect(loginRes.body.user.needsPrivacyConsent).toBe(true);
    expect(loginRes.body.user.privacyConsent.version).toBe(OLDER_VERSION);
  });

  it('is false for a user who agreed to the current version', async () => {
    const user = await registerUser();

    const checkRes = await checkAuth(user);
    expect(checkRes.statusCode).toBe(200);
    expect(checkRes.body.user.needsPrivacyConsent).toBe(false);
    expect(checkRes.body.user.privacyConsent.version).toBe(PRIVACY_NOTICE_VERSION);
  });

  it('is true when the current version is recorded without the 18+ confirmation', async () => {
    const user = await registerUser();
    await User.updateOne({ _id: user.id }, { $unset: { adultConfirmedAt: 1 } });

    expect((await checkAuth(user)).body.user.needsPrivacyConsent).toBe(true);
  });
});

describe('POST /api/users/privacy-consent', () => {
  it('returns 401 when signed out', async () => {
    const res = await request(server).post('/api/users/privacy-consent').send(REGISTRATION_CONSENT);

    expect(res.statusCode).toBe(401);
    expect(res.body.message).toBe('Unauthorized - No Token Provided');
  });

  it.each(BAD_CONSENT_BODIES)('refuses a body where %s, and records nothing', async (_label, overrides) => {
    const user = await registerUser();
    await makeLegacyAccount(user.id);

    const res = await postConsent(user, { ...REGISTRATION_CONSENT, ...overrides });

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: 'Validation failed', errors: expectedConsentErrors(overrides) });
    const stored = await readStoredUser(user.id);
    expect(stored).not.toHaveProperty('privacyConsent');
    expect(stored).not.toHaveProperty('adultConfirmedAt');
  });

  it('records the current version and the server time for an account from before consent was recorded', async () => {
    const user = await registerUser();
    await makeLegacyAccount(user.id);

    const earliestMs = Date.now();
    const res = await postConsent(user, REGISTRATION_CONSENT);
    const latestMs = Date.now();

    expect(res.statusCode).toBe(200);
    const stored = await readStoredUser(user.id);
    expect(stored.privacyConsent.version).toBe(PRIVACY_NOTICE_VERSION);
    expectBetween(stored.privacyConsent.acceptedAt, earliestMs, latestMs);
    expect(stored.adultConfirmedAt).toEqual(stored.privacyConsent.acceptedAt);

    // The same user object as the profile and auth responses
    expect(res.body.user).toMatchObject({
      _id: user.id,
      name: user.name,
      privacyConsent: { version: PRIVACY_NOTICE_VERSION, acceptedAt: stored.privacyConsent.acceptedAt.toISOString() },
      needsPrivacyConsent: false,
      nextEligibleDonationAt: null,
    });
    expect(res.body.user).not.toHaveProperty('password');
    expect((await checkAuth(user)).body.user.needsPrivacyConsent).toBe(false);
  });

  it('replaces an agreement to an older version with the current one', async () => {
    const user = await registerUser();
    await setAgreedVersion(user.id, OLDER_VERSION);
    const before = await readStoredUser(user.id);

    const res = await postConsent(user, REGISTRATION_CONSENT);

    expect(res.statusCode).toBe(200);
    expect(res.body.user.needsPrivacyConsent).toBe(false);
    const stored = await readStoredUser(user.id);
    expect(stored.privacyConsent.version).toBe(PRIVACY_NOTICE_VERSION);
    expect(stored.privacyConsent.acceptedAt.getTime()).toBeGreaterThanOrEqual(before.privacyConsent.acceptedAt.getTime());
  });

  it('is idempotent: a repeat keeps the first agreement and its time', async () => {
    const user = await registerUser();
    await makeLegacyAccount(user.id);

    const firstRes = await postConsent(user, REGISTRATION_CONSENT);
    const afterFirst = await readStoredUser(user.id);
    const secondRes = await postConsent(user, REGISTRATION_CONSENT);
    const afterSecond = await readStoredUser(user.id);

    expect(firstRes.statusCode).toBe(200);
    expect(secondRes.statusCode).toBe(200);
    expect(afterSecond.privacyConsent).toEqual(afterFirst.privacyConsent);
    expect(afterSecond.adultConfirmedAt).toEqual(afterFirst.adultConfirmedAt);
    expect(secondRes.body.user.privacyConsent).toEqual(firstRes.body.user.privacyConsent);
    expect(secondRes.body.user.needsPrivacyConsent).toBe(false);
  });

  it('ignores a version or time in the body', async () => {
    const user = await registerUser();
    await makeLegacyAccount(user.id);

    const res = await postConsent(user, {
      ...REGISTRATION_CONSENT,
      privacyConsent: { version: OLDER_VERSION, acceptedAt: '2000-01-01T00:00:00.000Z' },
      version: OLDER_VERSION,
      acceptedAt: '2000-01-01T00:00:00.000Z',
      adultConfirmedAt: '2000-01-01T00:00:00.000Z',
    });

    expect(res.statusCode).toBe(200);
    const stored = await readStoredUser(user.id);
    expect(stored.privacyConsent.version).toBe(PRIVACY_NOTICE_VERSION);
    expect(stored.privacyConsent.acceptedAt.getUTCFullYear()).not.toBe(2000);
    expect(stored.adultConfirmedAt.getUTCFullYear()).not.toBe(2000);
  });
});

describe('consent history', () => {
  it('gets one entry at sign-up, the same agreement as privacyConsent', async () => {
    const user = await registerUser();

    const stored = await readStoredUser(user.id);
    expect(stored.privacyConsentHistory).toHaveLength(1);
    expect(stored.privacyConsentHistory[0]).toEqual(stored.privacyConsent);
  });

  it('gets no new entry when the current version is agreed to again', async () => {
    const user = await registerUser();
    const before = await readStoredUser(user.id);

    const res = await postConsent(user, REGISTRATION_CONSENT);

    expect(res.statusCode).toBe(200);
    const stored = await readStoredUser(user.id);
    expect(stored.privacyConsentHistory).toEqual(before.privacyConsentHistory);
    expect(stored.privacyConsent).toEqual(before.privacyConsent);
  });

  it('keeps the older agreement and adds the new one when a new version is agreed to', async () => {
    const user = await registerUser();
    await makeOlderVersionAccount(user.id);
    const before = await readStoredUser(user.id);
    expect(before.privacyConsentHistory).toEqual([before.privacyConsent]);
    expect(before.privacyConsent.version).toBe(OLDER_VERSION);

    const earliestMs = Date.now();
    const firstRes = await postConsent(user, REGISTRATION_CONSENT);
    const latestMs = Date.now();
    // A double click or a second tab: still two entries
    const secondRes = await postConsent(user, REGISTRATION_CONSENT);

    expect(firstRes.statusCode).toBe(200);
    expect(secondRes.statusCode).toBe(200);
    const stored = await readStoredUser(user.id);
    expect(stored.privacyConsent.version).toBe(PRIVACY_NOTICE_VERSION);
    expectBetween(stored.privacyConsent.acceptedAt, earliestMs, latestMs);
    expect(stored.privacyConsentHistory).toEqual([before.privacyConsent, stored.privacyConsent]);
  });

  it('starts with the first agreement of an account from before consent was recorded', async () => {
    const user = await registerUser();
    await makeLegacyAccount(user.id);
    await User.updateOne({ _id: user.id }, { $unset: { privacyConsentHistory: 1 } });
    expect(await readStoredUser(user.id)).not.toHaveProperty('privacyConsentHistory');

    const res = await postConsent(user, REGISTRATION_CONSENT);

    expect(res.statusCode).toBe(200);
    const stored = await readStoredUser(user.id);
    expect(stored.privacyConsentHistory).toEqual([stored.privacyConsent]);
  });

  it('survives a save of a document loaded before the first agreement', async () => {
    const user = await registerUser();
    await makeLegacyAccount(user.id);
    await User.updateOne({ _id: user.id }, { $unset: { privacyConsentHistory: 1 } });
    // Loaded without the field, as /push/subscribe does, then saved after consent is recorded
    const staleDocument = await User.findById(user.id);

    const res = await postConsent(user, REGISTRATION_CONSENT);
    staleDocument.isAvailable = !staleDocument.isAvailable;
    await staleDocument.save();

    expect(res.statusCode).toBe(200);
    expect((await readStoredUser(user.id)).privacyConsentHistory).toHaveLength(1);
  });

  it('is in no response to the user themselves', async () => {
    const user = await registerUser();
    await makeOlderVersionAccount(user.id);

    const responses = [
      await checkAuth(user),
      await login(user),
      await postConsent(user, REGISTRATION_CONSENT),
      await request(server).patch('/api/users/profile').set('Cookie', user.cookie).send({ name: 'Renamed User' }),
    ];

    expect((await readStoredUser(user.id)).privacyConsentHistory).toHaveLength(2);
    responses.forEach((res) => {
      expect(res.statusCode).toBe(200);
      expect(res.body.user.privacyConsent).toBeDefined();
      expect(JSON.stringify(res.body)).not.toContain('privacyConsentHistory');
    });
  });
});

describe('PATCH /api/users/profile and the consent record', () => {
  it('cannot give consent for an account that has none', async () => {
    const user = await registerUser();
    await makeLegacyAccount(user.id);

    const res = await request(server)
      .patch('/api/users/profile')
      .set('Cookie', user.cookie)
      .send({
        name: 'Renamed User',
        privacyConsent: { version: PRIVACY_NOTICE_VERSION, acceptedAt: new Date().toISOString() },
        adultConfirmedAt: new Date().toISOString(),
        needsPrivacyConsent: false,
        acceptPrivacy: true,
        confirmAdult: true,
      });

    // The rest of the update still applies
    expect(res.statusCode).toBe(200);
    expect(res.body.user.name).toBe('Renamed User');
    expect(res.body.user.needsPrivacyConsent).toBe(true);
    const stored = await readStoredUser(user.id);
    expect(stored).not.toHaveProperty('privacyConsent');
    expect(stored).not.toHaveProperty('adultConfirmedAt');
  });

  it('cannot change an existing consent record', async () => {
    const user = await registerUser();
    const before = await readStoredUser(user.id);

    const res = await request(server)
      .patch('/api/users/profile')
      .set('Cookie', user.cookie)
      .send({
        isAvailable: false,
        privacyConsent: { version: 'forged', acceptedAt: '2000-01-01T00:00:00.000Z' },
        adultConfirmedAt: null,
        privacyConsentHistory: [],
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.user.isAvailable).toBe(false);
    const stored = await readStoredUser(user.id);
    expect(stored.privacyConsent).toEqual(before.privacyConsent);
    expect(stored.adultConfirmedAt).toEqual(before.adultConfirmedAt);
    expect(stored.privacyConsentHistory).toEqual(before.privacyConsentHistory);
  });
});

describe("other users' consent records", () => {
  it('never reach another user through requests or history', async () => {
    const requester = await registerUser({ name: 'Rita Requester', bloodGroup: 'A+', location: HOSPITAL });
    const donor = await registerUser({ name: 'Dana Donor', bloodGroup: 'O-', location: NEARBY });

    const createRes = await request(server)
      .post('/api/requests')
      .set('Cookie', requester.cookie)
      .send({ bloodGroup: 'A+', unitsNeeded: 1, hospitalName: 'Consent Hospital', hospitalLocation: HOSPITAL, urgency: 'high' });
    expect(createRes.statusCode).toBe(201);
    expectNoConsentData(createRes.body);

    const incomingRes = await request(server).get('/api/requests/incoming').set('Cookie', donor.cookie);
    expect(incomingRes.statusCode).toBe(200);
    // The requester's name does reach nearby donors, so the populate itself worked
    expect(incomingRes.body.incomingRequests[0].requesterId).toEqual({ name: 'Rita Requester', profilePic: '' });
    expectNoConsentData(incomingRes.body);

    await Request.updateOne(
      { _id: createRes.body.request._id },
      { $set: { status: 'fulfilled', matchedDonorId: donor.id, fulfilledAt: new Date() } }
    );
    for (const user of [requester, donor]) {
      const historyRes = await request(server).get('/api/users/history').set('Cookie', user.cookie);
      expect(historyRes.statusCode).toBe(200);
      expectNoConsentData(historyRes.body);
    }
  });
});

describe('account deletion', () => {
  it('removes the consent record and its history with the account', async () => {
    const user = await registerUser();
    const before = await readStoredUser(user.id);
    expect(before.privacyConsent.version).toBe(PRIVACY_NOTICE_VERSION);
    expect(before.privacyConsentHistory).toHaveLength(1);

    const res = await request(server).delete('/api/users/me').set('Cookie', user.cookie).send({ password: PASSWORD });

    expect(res.statusCode).toBe(200);
    expect(await readStoredUser(user.id)).toBeNull();
    expect(await User.collection.countDocuments({ email: user.email })).toBe(0);
  });
});

describe('notice version', () => {
  it('is the same on the client, which shows it, as on the server, which records it', () => {
    const clientConfigPath = path.join(__dirname, '../../client/src/config/privacy.js');
    const clientConfig = fs.readFileSync(clientConfigPath, 'utf8');
    const match = clientConfig.match(/export const PRIVACY_NOTICE_VERSION = '([^']+)';/);

    expect(match).not.toBeNull();
    expect(match[1]).toBe(PRIVACY_NOTICE_VERSION);
  });
});
