const http = require('http');
const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../index');
const { io } = require('../lib/socket');
const Request = require('../models/request.model');
const User = require('../models/user.model');
const { connectDB, closeDB, clearDB } = require('./db');

// supertest dials 127.0.0.1, so bind there explicitly. request(app) binds `::`, and another
// local app on the same ephemeral port can answer instead.
let server;

beforeAll(async () => {
  await connectDB();
  // Mongoose builds indexes in the background; wait so one_active_donation_per_donor
  // exists before the first test, or the active-donation tests could race the index build
  await Request.init();
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
});

afterEach(async () => {
  jest.restoreAllMocks();
  await clearDB();
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await closeDB();
});

// Coordinates are [longitude, latitude]
const HOSPITAL = [77.5946, 12.9716]; // Bangalore
const NEARBY = [77.6, 12.975]; // ~0.7 km from HOSPITAL
const FAR_AWAY = [77.8246, 12.9716]; // ~25 km from HOSPITAL, outside the 15 km radius

let userCount = 0;

// Register through the API and reuse the cookie register sets. Logging in per
// test would exhaust the login rate limiter (10 per 15 min per IP).
const registerUser = async ({ bloodGroup, location = NEARBY, name }) => {
  userCount += 1;
  const res = await request(server)
    .post('/api/auth/register')
    .send({
      name: name || `User ${userCount}`,
      email: `user${userCount}@example.com`,
      password: 'password123',
      bloodGroup,
      location,
    });
  expect(res.statusCode).toBe(201);
  return { id: res.body.user._id, name: res.body.user.name, cookie: res.headers['set-cookie'] };
};

// Created directly on the model so these tests do not depend on the createRequest response
const createBloodRequest = (requesterId, overrides = {}) =>
  Request.create({
    requesterId,
    bloodGroup: 'B+',
    unitsNeeded: 2,
    hospitalName: 'Test Hospital',
    hospitalLocation: { type: 'Point', coordinates: HOSPITAL },
    urgency: 'high',
    ...overrides,
  });

const patchStatus = (requestId, cookie, status) =>
  request(server)
    .patch(`/api/requests/${requestId}/status`)
    .set('Cookie', cookie)
    .send({ status });

const patchFulfill = (requestId, cookie) =>
  request(server)
    .patch(`/api/requests/${requestId}/fulfill`)
    .set('Cookie', cookie);

// Replaces io.to() so a test can see which room was notified and with what payload
const spyOnSocket = () => {
  const emit = jest.fn();
  const to = jest.spyOn(io, 'to').mockReturnValue({ emit });
  return { to, emit };
};

describe('PATCH /api/requests/:id/status', () => {
  let requester;

  beforeEach(async () => {
    requester = await registerUser({ name: 'Requester', bloodGroup: 'B+', location: HOSPITAL });
  });

  describe('validation', () => {
    it('rejects status "fulfilled" (400) and leaves the request unchanged', async () => {
      const donor = await registerUser({ bloodGroup: 'O-' });
      const bloodRequest = await createBloodRequest(requester.id, {
        status: 'accepted',
        matchedDonorId: donor.id,
      });

      const res = await patchStatus(bloodRequest._id, requester.cookie, 'fulfilled');

      expect(res.statusCode).toBe(400);
      expect(res.body.errors).toHaveProperty('status', 'Status must be accepted, declined, or cancelled');
      const stored = await Request.findById(bloodRequest._id);
      expect(stored.status).toBe('accepted');
      expect(stored.fulfilledAt).toBeNull();
    });

    it('rejects a missing status (400)', async () => {
      const bloodRequest = await createBloodRequest(requester.id);

      const res = await request(server)
        .patch(`/api/requests/${bloodRequest._id}/status`)
        .set('Cookie', requester.cookie)
        .send({});

      expect(res.statusCode).toBe(400);
      expect(res.body.errors).toHaveProperty('status');
    });
  });

  describe('accepted', () => {
    it('returns 404 for a request that does not exist', async () => {
      const donor = await registerUser({ bloodGroup: 'O-' });

      const res = await patchStatus(new mongoose.Types.ObjectId(), donor.cookie, 'accepted');

      expect(res.statusCode).toBe(404);
    });

    it('does not let the requester accept their own request (403)', async () => {
      // The requester is B+ and at the hospital, so ownership is the only failing rule
      const bloodRequest = await createBloodRequest(requester.id);

      const res = await patchStatus(bloodRequest._id, requester.cookie, 'accepted');

      expect(res.statusCode).toBe(403);
      expect(res.body.message).toBe('You cannot accept your own request');
      const stored = await Request.findById(bloodRequest._id);
      expect(stored.status).toBe('pending');
      expect(stored.matchedDonorId).toBeNull();
    });

    it('does not let a donor with an incompatible blood group accept (403)', async () => {
      const donor = await registerUser({ bloodGroup: 'A+' });
      const bloodRequest = await createBloodRequest(requester.id, { bloodGroup: 'O-' });

      const res = await patchStatus(bloodRequest._id, donor.cookie, 'accepted');

      expect(res.statusCode).toBe(403);
      expect(res.body.message).toBe('Your blood group is not compatible with this request');
      const stored = await Request.findById(bloodRequest._id);
      expect(stored.status).toBe('pending');
      expect(stored.matchedDonorId).toBeNull();
    });

    it('does not let a donor farther than 15 km accept (403)', async () => {
      const donor = await registerUser({ bloodGroup: 'O-', location: FAR_AWAY });
      const bloodRequest = await createBloodRequest(requester.id);

      const res = await patchStatus(bloodRequest._id, donor.cookie, 'accepted');

      expect(res.statusCode).toBe(403);
      expect(res.body.message).toMatch(/outside your 15 km/);
      const stored = await Request.findById(bloodRequest._id);
      expect(stored.status).toBe('pending');
      expect(stored.matchedDonorId).toBeNull();
    });

    it('lets a compatible nearby donor accept (200) and marks them unavailable', async () => {
      const donor = await registerUser({ bloodGroup: 'O-' });
      const bloodRequest = await createBloodRequest(requester.id);
      const socket = spyOnSocket();

      const res = await patchStatus(bloodRequest._id, donor.cookie, 'accepted');

      expect(res.statusCode).toBe(200);
      // Proves findOneAndUpdate returned the document AFTER the update
      expect(res.body.request.status).toBe('accepted');
      expect(res.body.request.matchedDonorId).toBe(donor.id);

      const stored = await Request.findById(bloodRequest._id);
      expect(stored.status).toBe('accepted');
      expect(stored.matchedDonorId.toString()).toBe(donor.id);
      const storedDonor = await User.findById(donor.id);
      expect(storedDonor.isAvailable).toBe(false);

      expect(socket.to).toHaveBeenCalledWith(requester.id);
      expect(socket.emit).toHaveBeenCalledWith('requestStatusUpdate', expect.objectContaining({
        status: 'accepted',
        donorName: donor.name,
      }));
    });

    it('rejects a second donor once the request is accepted (409) without notifying anyone', async () => {
      const firstDonor = await registerUser({ bloodGroup: 'O-' });
      const secondDonor = await registerUser({ bloodGroup: 'B+' });
      const bloodRequest = await createBloodRequest(requester.id);

      const firstRes = await patchStatus(bloodRequest._id, firstDonor.cookie, 'accepted');
      expect(firstRes.statusCode).toBe(200);

      const socket = spyOnSocket();
      const secondRes = await patchStatus(bloodRequest._id, secondDonor.cookie, 'accepted');

      expect(secondRes.statusCode).toBe(409);
      expect(secondRes.body.message).toBe('This request has already been accepted by another donor');
      expect(socket.to).not.toHaveBeenCalled();

      const stored = await Request.findById(bloodRequest._id);
      expect(stored.matchedDonorId.toString()).toBe(firstDonor.id);
      const storedSecondDonor = await User.findById(secondDonor.id);
      expect(storedSecondDonor.isAvailable).toBe(true);
    });

    it('tells a donor who accepts twice that they already accepted (409)', async () => {
      const donor = await registerUser({ bloodGroup: 'O-' });
      const bloodRequest = await createBloodRequest(requester.id);

      await patchStatus(bloodRequest._id, donor.cookie, 'accepted');
      const res = await patchStatus(bloodRequest._id, donor.cookie, 'accepted');

      expect(res.statusCode).toBe(409);
      expect(res.body.message).toBe('You have already accepted this request');
    });

    it('lets exactly one of two concurrent donors accept (one 200, one 409)', async () => {
      const donorA = await registerUser({ bloodGroup: 'O-' });
      const donorB = await registerUser({ bloodGroup: 'B+' });
      const bloodRequest = await createBloodRequest(requester.id);

      const responses = await Promise.all([
        patchStatus(bloodRequest._id, donorA.cookie, 'accepted'),
        patchStatus(bloodRequest._id, donorB.cookie, 'accepted'),
      ]);

      const statusCodes = responses.map((res) => res.statusCode).sort();
      expect(statusCodes).toEqual([200, 409]);

      // The stored match must be the donor who got the 200, and only they are unavailable
      const winner = responses[0].statusCode === 200 ? donorA : donorB;
      const loser = winner === donorA ? donorB : donorA;
      const stored = await Request.findById(bloodRequest._id);
      expect(stored.matchedDonorId.toString()).toBe(winner.id);
      expect((await User.findById(winner.id)).isAvailable).toBe(false);
      expect((await User.findById(loser.id)).isAvailable).toBe(true);
    });

    it('does not let a donor with an active donation accept another request (409)', async () => {
      const donor = await registerUser({ bloodGroup: 'O-' });
      const firstRequest = await createBloodRequest(requester.id);
      const secondRequest = await createBloodRequest(requester.id);
      expect((await patchStatus(firstRequest._id, donor.cookie, 'accepted')).statusCode).toBe(200);

      const res = await patchStatus(secondRequest._id, donor.cookie, 'accepted');

      expect(res.statusCode).toBe(409);
      expect(res.body.message).toBe(
        'You already have an active donation. Complete or wait for it to be cancelled before accepting another.'
      );
      const storedSecond = await Request.findById(secondRequest._id);
      expect(storedSecond.status).toBe('pending');
      expect(storedSecond.matchedDonorId).toBeNull();
    });

    it('lets one donor accepting two requests at once win only one (one 200, one 409)', async () => {
      const donor = await registerUser({ bloodGroup: 'O-' });
      const firstRequest = await createBloodRequest(requester.id);
      const secondRequest = await createBloodRequest(requester.id);

      const responses = await Promise.all([
        patchStatus(firstRequest._id, donor.cookie, 'accepted'),
        patchStatus(secondRequest._id, donor.cookie, 'accepted'),
      ]);

      expect(responses.map((res) => res.statusCode).sort()).toEqual([200, 409]);
      const loserRes = responses.find((res) => res.statusCode === 409);
      expect(loserRes.body.message).toBe(
        'You already have an active donation. Complete or wait for it to be cancelled before accepting another.'
      );

      const acceptedCount = await Request.countDocuments({ matchedDonorId: donor.id, status: 'accepted' });
      expect(acceptedCount).toBe(1);
      const loserRequest = responses[0].statusCode === 409 ? firstRequest : secondRequest;
      const storedLoser = await Request.findById(loserRequest._id);
      expect(storedLoser.status).toBe('pending');
      expect(storedLoser.matchedDonorId).toBeNull();
    });

    it.each(['fulfilled', 'cancelled'])('lets a donor accept another request once their donation is %s (200)', async (outcome) => {
      const donor = await registerUser({ bloodGroup: 'O-' });
      const firstRequest = await createBloodRequest(requester.id);
      const secondRequest = await createBloodRequest(requester.id);
      expect((await patchStatus(firstRequest._id, donor.cookie, 'accepted')).statusCode).toBe(200);

      const endRes = outcome === 'fulfilled'
        ? await patchFulfill(firstRequest._id, requester.cookie)
        : await patchStatus(firstRequest._id, requester.cookie, 'cancelled');
      expect(endRes.statusCode).toBe(200);

      const res = await patchStatus(secondRequest._id, donor.cookie, 'accepted');

      expect(res.statusCode).toBe(200);
      expect((await Request.findById(secondRequest._id)).matchedDonorId.toString()).toBe(donor.id);
      expect((await User.findById(donor.id)).isAvailable).toBe(false);
    });

    it('sends no stale accept when the requester cancels right after the accept commits (409, donor available)', async () => {
      const donor = await registerUser({ bloodGroup: 'O-' });
      const bloodRequest = await createBloodRequest(requester.id);
      const realTransaction = mongoose.connection.transaction.bind(mongoose.connection);
      let hasInjectedCancel = false;
      let cancelRes;

      // With both writes in one transaction, the only gap left is between the accept's
      // commit and its emit. Run the requester's whole cancel in exactly that gap.
      // Flag set BEFORE awaiting so the cancel's own transaction cannot re-inject.
      jest.spyOn(mongoose.connection, 'transaction').mockImplementation(async (fn, options) => {
        const result = await realTransaction(fn, options);
        if (!hasInjectedCancel) {
          hasInjectedCancel = true;
          cancelRes = await patchStatus(bloodRequest._id, requester.cookie, 'cancelled');
        }
        return result;
      });
      const socket = spyOnSocket();

      const acceptRes = await patchStatus(bloodRequest._id, donor.cookie, 'accepted');

      expect(cancelRes.statusCode).toBe(200);
      expect(acceptRes.statusCode).toBe(409);
      expect(acceptRes.body.message).toBe('This request has already been cancelled');
      expect((await Request.findById(bloodRequest._id)).status).toBe('cancelled');
      // The cancel's own transaction restored the donor in the same commit
      expect((await User.findById(donor.id)).isAvailable).toBe(true);
      // The requester must not get a stale 'accepted' event; the donor still hears about the cancel
      expect(socket.emit).not.toHaveBeenCalledWith(
        'requestStatusUpdate',
        expect.objectContaining({ status: 'accepted' })
      );
      expect(socket.to).toHaveBeenCalledWith(donor.id);
      expect(socket.emit).toHaveBeenCalledWith('requestStatusUpdate', expect.objectContaining({ status: 'cancelled' }));
    });

    it('serialises a cancel sent while the accept transaction is still open (donor ends available)', async () => {
      const donor = await registerUser({ bloodGroup: 'O-' });
      const bloodRequest = await createBloodRequest(requester.id);
      const realFindByIdAndUpdate = User.findByIdAndUpdate.bind(User);
      let cancelPromise;

      // Send the cancel after the accept has written the request but before it commits.
      // It is not awaited here: the cancel hits a write conflict on the request and the
      // driver retries it until the accept commits, so awaiting it here would deadlock.
      jest.spyOn(User, 'findByIdAndUpdate').mockImplementation(async (id, update, ...rest) => {
        if (update && update.isAvailable === false && !cancelPromise) {
          // .then() is what makes supertest actually send the request
          cancelPromise = patchStatus(bloodRequest._id, requester.cookie, 'cancelled').then((res) => res);
        }
        return realFindByIdAndUpdate(id, update, ...rest);
      });

      const acceptRes = await patchStatus(bloodRequest._id, donor.cookie, 'accepted');
      const cancelRes = await cancelPromise;

      // The accept committed first; whether its response saw the cancel depends on timing
      expect([200, 409]).toContain(acceptRes.statusCode);
      expect(cancelRes.statusCode).toBe(200);
      expect((await Request.findById(bloodRequest._id)).status).toBe('cancelled');
      expect((await User.findById(donor.id)).isAvailable).toBe(true);
    });
  });

  describe('cancelled', () => {
    it('does not let a stranger cancel someone else\'s request (403)', async () => {
      const stranger = await registerUser({ bloodGroup: 'O-' });
      const bloodRequest = await createBloodRequest(requester.id);

      const res = await patchStatus(bloodRequest._id, stranger.cookie, 'cancelled');

      expect(res.statusCode).toBe(403);
      expect(res.body.message).toBe('Only the requester can cancel this request');
      const stored = await Request.findById(bloodRequest._id);
      expect(stored.status).toBe('pending');
    });

    it('lets the requester cancel an accepted request (200) and frees the donor', async () => {
      const donor = await registerUser({ bloodGroup: 'O-' });
      const bloodRequest = await createBloodRequest(requester.id);
      const acceptRes = await patchStatus(bloodRequest._id, donor.cookie, 'accepted');
      expect(acceptRes.statusCode).toBe(200);
      expect((await User.findById(donor.id)).isAvailable).toBe(false);

      const socket = spyOnSocket();
      const res = await patchStatus(bloodRequest._id, requester.cookie, 'cancelled');

      expect(res.statusCode).toBe(200);
      expect(res.body.request.status).toBe('cancelled');
      expect((await Request.findById(bloodRequest._id)).status).toBe('cancelled');
      expect((await User.findById(donor.id)).isAvailable).toBe(true);

      expect(socket.to).toHaveBeenCalledWith(donor.id);
      expect(socket.emit).toHaveBeenCalledWith('requestStatusUpdate', {
        requestId: expect.anything(),
        status: 'cancelled',
        requesterName: requester.name,
      });
    });

    it.each(['cancelled', 'fulfilled'])('rejects cancelling a request that is already %s (409)', async (finalStatus) => {
      const donor = await registerUser({ bloodGroup: 'O-' });
      const bloodRequest = await createBloodRequest(requester.id, {
        status: finalStatus,
        matchedDonorId: finalStatus === 'fulfilled' ? donor.id : null,
      });

      const res = await patchStatus(bloodRequest._id, requester.cookie, 'cancelled');

      expect(res.statusCode).toBe(409);
      expect(res.body.message).toBe(`This request has already been ${finalStatus}`);
      expect((await Request.findById(bloodRequest._id)).status).toBe(finalStatus);
    });
  });

  describe('declined', () => {
    it('records a donor only once when they decline twice', async () => {
      const donor = await registerUser({ bloodGroup: 'O-' });
      const bloodRequest = await createBloodRequest(requester.id);

      const firstRes = await patchStatus(bloodRequest._id, donor.cookie, 'declined');
      const secondRes = await patchStatus(bloodRequest._id, donor.cookie, 'declined');

      expect(firstRes.statusCode).toBe(200);
      expect(secondRes.statusCode).toBe(200);
      const stored = await Request.findById(bloodRequest._id);
      expect(stored.declinedBy.map((id) => id.toString())).toEqual([donor.id]);
      expect(stored.status).toBe('pending');
    });

    it('returns only a message, not the request, on success', async () => {
      const donor = await registerUser({ bloodGroup: 'O-' });
      const bloodRequest = await createBloodRequest(requester.id);

      const res = await patchStatus(bloodRequest._id, donor.cookie, 'declined');

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ message: 'Request declined by you' });
    });

    it('does not let the requester decline their own request (403)', async () => {
      const bloodRequest = await createBloodRequest(requester.id);

      const res = await patchStatus(bloodRequest._id, requester.cookie, 'declined');

      expect(res.statusCode).toBe(403);
      expect((await Request.findById(bloodRequest._id)).declinedBy).toHaveLength(0);
    });

    it('rejects declining a request that is no longer pending (409) and records nothing', async () => {
      const acceptingDonor = await registerUser({ bloodGroup: 'O-' });
      const decliningDonor = await registerUser({ bloodGroup: 'B+' });
      const bloodRequest = await createBloodRequest(requester.id);
      expect((await patchStatus(bloodRequest._id, acceptingDonor.cookie, 'accepted')).statusCode).toBe(200);

      const res = await patchStatus(bloodRequest._id, decliningDonor.cookie, 'declined');

      expect(res.statusCode).toBe(409);
      expect((await Request.findById(bloodRequest._id)).declinedBy).toHaveLength(0);
    });
  });
});

describe('request and donor writes commit together or not at all', () => {
  let requester;
  let donor;
  let consoleErrorSpy;

  beforeEach(async () => {
    requester = await registerUser({ name: 'Requester', bloodGroup: 'B+', location: HOSPITAL });
    donor = await registerUser({ bloodGroup: 'O-' });
    // The controller logs the simulated failure; keep the test output clean but still check it
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  // Makes the donor availability write fail inside the transaction, after the request write
  const failDonorWriteSetting = (isAvailable) => {
    const realFindByIdAndUpdate = User.findByIdAndUpdate.bind(User);
    jest.spyOn(User, 'findByIdAndUpdate').mockImplementation(async (id, update, ...rest) => {
      if (update && update.isAvailable === isAvailable) {
        throw new Error('Simulated donor write failure');
      }
      return realFindByIdAndUpdate(id, update, ...rest);
    });
  };

  const acceptThroughApi = async (bloodRequest) => {
    const res = await patchStatus(bloodRequest._id, donor.cookie, 'accepted');
    expect(res.statusCode).toBe(200);
  };

  it('rolls back the accept when the donor write fails (500, still pending, no event)', async () => {
    const bloodRequest = await createBloodRequest(requester.id);
    failDonorWriteSetting(false);
    const socket = spyOnSocket();

    const res = await patchStatus(bloodRequest._id, donor.cookie, 'accepted');

    expect(res.statusCode).toBe(500);
    const stored = await Request.findById(bloodRequest._id);
    expect(stored.status).toBe('pending');
    expect(stored.matchedDonorId).toBeNull();
    expect((await User.findById(donor.id)).isAvailable).toBe(true);
    expect(socket.to).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith('Error in updateRequestStatus:', 'Simulated donor write failure');
  });

  it('rolls back the cancel when the donor write fails (500, still accepted, no event)', async () => {
    const bloodRequest = await createBloodRequest(requester.id);
    await acceptThroughApi(bloodRequest);
    failDonorWriteSetting(true);
    const socket = spyOnSocket();

    const res = await patchStatus(bloodRequest._id, requester.cookie, 'cancelled');

    expect(res.statusCode).toBe(500);
    const stored = await Request.findById(bloodRequest._id);
    expect(stored.status).toBe('accepted');
    expect(stored.matchedDonorId.toString()).toBe(donor.id);
    expect((await User.findById(donor.id)).isAvailable).toBe(false);
    expect(socket.to).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith('Error in updateRequestStatus:', 'Simulated donor write failure');
  });

  it('rolls back the fulfil when the donor write fails (500, still accepted, no event)', async () => {
    const bloodRequest = await createBloodRequest(requester.id);
    await acceptThroughApi(bloodRequest);
    failDonorWriteSetting(true);
    const socket = spyOnSocket();

    const res = await patchFulfill(bloodRequest._id, requester.cookie);

    expect(res.statusCode).toBe(500);
    const stored = await Request.findById(bloodRequest._id);
    expect(stored.status).toBe('accepted');
    expect(stored.fulfilledAt).toBeNull();
    expect((await User.findById(donor.id)).isAvailable).toBe(false);
    expect(socket.to).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith('Error in fulfillRequest:', 'Simulated donor write failure');
  });
});

describe('PATCH /api/requests/:id/fulfill', () => {
  let requester;
  let donor;
  let bloodRequest;

  // Every test starts from a request the donor has accepted through the API
  beforeEach(async () => {
    requester = await registerUser({ name: 'Requester', bloodGroup: 'B+', location: HOSPITAL });
    donor = await registerUser({ bloodGroup: 'O-' });
    bloodRequest = await createBloodRequest(requester.id);
    const acceptRes = await patchStatus(bloodRequest._id, donor.cookie, 'accepted');
    expect(acceptRes.statusCode).toBe(200);
  });

  it('lets the requester fulfil an accepted request (200) and frees the donor', async () => {
    const socket = spyOnSocket();

    const res = await patchFulfill(bloodRequest._id, requester.cookie);

    expect(res.statusCode).toBe(200);
    expect(res.body.message).toBe('Request marked as fulfilled');
    // Proves findOneAndUpdate returned the document AFTER the update
    expect(res.body.request.status).toBe('fulfilled');
    expect(res.body.request.fulfilledAt).not.toBeNull();
    expect((await User.findById(donor.id)).isAvailable).toBe(true);
    expect(socket.to).toHaveBeenCalledWith(donor.id);
    expect(socket.emit).toHaveBeenCalledWith('requestStatusUpdate', {
      requestId: expect.anything(),
      status: 'fulfilled',
      requesterName: requester.name,
    });
  });

  it('rejects fulfilling a cancelled request (400) and leaves it cancelled', async () => {
    expect((await patchStatus(bloodRequest._id, requester.cookie, 'cancelled')).statusCode).toBe(200);

    const res = await patchFulfill(bloodRequest._id, requester.cookie);

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toBe('Only accepted requests can be marked as fulfilled');
    const stored = await Request.findById(bloodRequest._id);
    expect(stored.status).toBe('cancelled');
    expect(stored.fulfilledAt).toBeNull();
  });

  it('does not overwrite a cancel that lands between a read and the fulfil write', async () => {
    const realFindById = Request.findById.bind(Request);
    let hasInjectedCancel = false;
    let cancelRes;

    // A read-check-save fulfil calls findById first. Cancel right after that read and hand
    // back the stale 'accepted' document, so a non-atomic fulfil would save over the cancel.
    // The atomic fulfil never calls findById on its success path, so no cancel happens.
    jest.spyOn(Request, 'findById').mockImplementation(async (...args) => {
      const staleDoc = await realFindById(...args);
      // Flag set BEFORE awaiting: a cancel that itself calls findById must not re-inject
      if (!hasInjectedCancel) {
        hasInjectedCancel = true;
        cancelRes = await patchStatus(bloodRequest._id, requester.cookie, 'cancelled');
      }
      return staleDoc;
    });

    const fulfilRes = await patchFulfill(bloodRequest._id, requester.cookie);

    const stored = await realFindById(bloodRequest._id); // bypass the spy
    const cancelSucceeded = Boolean(cancelRes && cancelRes.statusCode === 200);
    // If the cancel went through, it must still be the stored status and the fulfil must have failed
    expect(stored.status).toBe(cancelSucceeded ? 'cancelled' : 'fulfilled');
    expect(fulfilRes.statusCode).toBe(cancelSucceeded ? 400 : 200);
  });

  it('fulfils an accepted request that has no matched donor (200, not 500)', async () => {
    const unmatchedRequest = await createBloodRequest(requester.id, { status: 'accepted', matchedDonorId: null });
    const socket = spyOnSocket();

    const res = await patchFulfill(unmatchedRequest._id, requester.cookie);

    expect(res.statusCode).toBe(200);
    expect(res.body.request.status).toBe('fulfilled');
    expect(socket.to).not.toHaveBeenCalled();
  });

  it('does not let anyone but the requester fulfil (403)', async () => {
    const res = await patchFulfill(bloodRequest._id, donor.cookie);

    expect(res.statusCode).toBe(403);
    expect(res.body.message).toBe('Only the requester can mark this as fulfilled');
    expect((await Request.findById(bloodRequest._id)).status).toBe('accepted');
  });

  it('returns 404 for a request that does not exist', async () => {
    const res = await patchFulfill(new mongoose.Types.ObjectId(), requester.cookie);

    expect(res.statusCode).toBe(404);
    expect(res.body.message).toBe('Request not found');
  });
});
