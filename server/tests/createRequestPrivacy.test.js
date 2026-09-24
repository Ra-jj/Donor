const http = require('http');
const request = require('supertest');
const webpush = require('web-push');
const app = require('../index');
const { io } = require('../lib/socket');
const Request = require('../models/request.model');
const User = require('../models/user.model');
const {
  PIN_CANDIDATE_MARGIN_KM,
  roundCoordinate,
  roundCoordinatePair,
  buildDonorPins,
  angularDistanceRadians,
} = require('../utils/locationPrivacy');
const { connectDB, closeDB, clearDB } = require('./db');

// A number that prints with at most 2 decimal places, e.g. 77.6, -23.55 or 180
const AT_MOST_TWO_DECIMALS = /^-?\d+(\.\d{1,2})?$/;

// Same values as RADIUS_KM and EARTH_RADIUS_KM in request.controller.js
const RADIUS_KM = 15;
const EARTH_RADIUS_KM = 6378.1;

describe('roundCoordinate', () => {
  // Chosen rounding: half away from zero on the decimal value as written
  it('rounds halves away from zero, symmetrically for negative coordinates', () => {
    expect(roundCoordinate(12.345)).toBe(12.35);
    expect(roundCoordinate(-12.345)).toBe(-12.35);
    // 46.625 is exact in binary, so this is a true half; Math.round(-4662.5) alone would give -46.62
    expect(roundCoordinate(46.625)).toBe(46.63);
    expect(roundCoordinate(-46.625)).toBe(-46.63);
    // 1.005 * 100 is 100.49999999999999 in floating point; the helper still treats it as a half
    expect(roundCoordinate(1.005)).toBe(1.01);
  });

  it('rounds ordinary coordinates to the nearest 0.01', () => {
    expect(roundCoordinate(77.5946)).toBe(77.59);
    expect(roundCoordinate(12.9716)).toBe(12.97);
    expect(roundCoordinate(-46.6389)).toBe(-46.64);
    expect(roundCoordinate(-23.5449)).toBe(-23.54);
    expect(roundCoordinate(180)).toBe(180);
    expect(roundCoordinate(-180)).toBe(-180);
  });

  it('strips floating-point noise instead of returning values like 77.59000000001', () => {
    expect(roundCoordinate(77.59000000001)).toBe(77.59);
    expect(roundCoordinate(0.1 + 0.2)).toBe(0.3);
  });

  it('returns 0, never -0, for tiny negative values', () => {
    // toBe uses Object.is, so a -0 result would fail here
    expect(roundCoordinate(-0.001)).toBe(0);
    expect(roundCoordinate(-0)).toBe(0);
  });

  it('always returns a value that serialises with at most 2 decimals, moves it by at most 0.005 and is stable when re-rounded', () => {
    const failures = [];
    // Accumulating 0.0137 builds up floating-point noise on purpose, giving messy inputs
    for (let value = -180; value <= 180; value += 0.0137) {
      const rounded = roundCoordinate(value);
      const serialised = JSON.stringify(rounded);
      if (
        !AT_MOST_TWO_DECIMALS.test(serialised) ||
        Math.abs(rounded - value) > 0.005 + 1e-9 ||
        // The controller rounds points, then buildDonorPins rounds them again
        roundCoordinate(rounded) !== rounded
      ) {
        failures.push({ value, serialised });
      }
    }
    expect(failures).toEqual([]);
  });

  it('throws a TypeError for anything that is not a finite number', () => {
    [NaN, Infinity, -Infinity, '12.3', undefined, null].forEach((badValue) => {
      expect(() => roundCoordinate(badValue)).toThrow(TypeError);
    });
  });
});

describe('buildDonorPins', () => {
  it('rounds each pair, merges pairs that land on the same pin, and sorts by longitude then latitude', () => {
    const pins = buildDonorPins([
      [77.6012, 12.9751],
      [-46.6351, -23.5472],
      [77.6031, 12.9788], // rounds to the same pin as the first pair
      [77.6049, 12.9612], // same rounded longitude as the first pair, lower latitude
    ]);

    expect(pins).toEqual([
      { coordinates: [-46.64, -23.55] },
      { coordinates: [77.6, 12.96] },
      { coordinates: [77.6, 12.98] },
    ]);
  });

  it('returns an identical result for reversed input, so input order (exact-home index order) never leaks', () => {
    const pairs = [
      [77.6012, 12.9751],
      [-46.6351, -23.5472],
      [77.5655, 12.9352],
      [77.6031, 12.9788],
      [77.6049, 12.9612],
      [-46.625, -23.5449],
    ];
    expect(buildDonorPins([...pairs].reverse())).toEqual(buildDonorPins(pairs));
  });

  it('skips entries that are not a pair of finite numbers', () => {
    const pins = buildDonorPins([undefined, null, 'x', [1], [1, 2, 3], [NaN, 2], [1, '2'], [10.004, 20.006]]);
    expect(pins).toEqual([{ coordinates: [10, 20.01] }]);
  });

  it('returns an empty array when there are no donors', () => {
    expect(buildDonorPins([])).toEqual([]);
  });
});

describe('roundCoordinatePair', () => {
  it('rounds both coordinates of a [longitude, latitude] pair', () => {
    expect(roundCoordinatePair([77.5912, 13.1035])).toEqual([77.59, 13.1]);
    expect(roundCoordinatePair([-46.625, -23.5449])).toEqual([-46.63, -23.54]);
  });

  it('returns null for anything that is not a pair of finite numbers', () => {
    [undefined, null, 'x', [1], [1, 2, 3], [NaN, 2], [1, '2']].forEach((badPair) => {
      expect(roundCoordinatePair(badPair)).toBeNull();
    });
  });
});

describe('angularDistanceRadians', () => {
  it('matches known great-circle angles', () => {
    // 1 degree along a meridian is exactly pi/180 radians
    expect(angularDistanceRadians([0, 0], [0, 1])).toBeCloseTo(Math.PI / 180, 12);
    // A quarter and a half of the way round the equator
    expect(angularDistanceRadians([0, 0], [90, 0])).toBeCloseTo(Math.PI / 2, 12);
    expect(angularDistanceRadians([0, 0], [180, 0])).toBeCloseTo(Math.PI, 12);
    // Every meridian meets at the pole
    expect(angularDistanceRadians([10, 90], [-120, 90])).toBeCloseTo(0, 12);
    // The antimeridian: 179.5 E to 179.5 W is 1 degree, not 359
    expect(angularDistanceRadians([179.5, 0], [-179.5, 0])).toBeCloseTo(Math.PI / 180, 12);
  });

  it('matches a known real-world distance: London to Paris is about 343.56 km on a 6371 km sphere', () => {
    const london = [-0.1278, 51.5074];
    const paris = [2.3522, 48.8566];
    expect(angularDistanceRadians(london, paris) * 6371).toBeCloseTo(343.56, 1);
    expect(angularDistanceRadians(paris, london)).toBe(angularDistanceRadians(london, paris));
  });

  it('puts a point RADIUS_KM due north on the edge of a $centerSphere of RADIUS_KM / EARTH_RADIUS_KM', () => {
    const radiusInRadians = RADIUS_KM / EARTH_RADIUS_KM;
    const edgeLatitude = 12.9675 + (radiusInRadians * 180) / Math.PI;
    expect(angularDistanceRadians([77.59, 12.9675], [77.59, edgeLatitude])).toBeCloseTo(radiusInRadians, 12);
  });
});

describe('PIN_CANDIDATE_MARGIN_KM', () => {
  it('is larger than the furthest that rounding to 2 decimals can move a point (~0.79 km)', () => {
    let largestShiftKm = 0;
    // A shift of 0.005 degrees on both axes is the worst case for any cell; check every latitude band
    for (let latitude = -89.995; latitude <= 89.995; latitude += 0.01) {
      const shiftKm = angularDistanceRadians([10, latitude], [10.005, latitude + 0.005]) * EARTH_RADIUS_KM;
      largestShiftKm = Math.max(largestShiftKm, shiftKm);
    }
    expect(largestShiftKm).toBeGreaterThan(0.78);
    expect(largestShiftKm).toBeLessThan(0.79);
    expect(PIN_CANDIDATE_MARGIN_KM).toBeGreaterThan(largestShiftKm);
  });
});

describe('POST /api/requests donor privacy', () => {
  // supertest dials 127.0.0.1, so bind there explicitly. request(app) binds `::`, and another
  // local app on the same ephemeral port can answer instead.
  let server;
  let userCount = 0;
  let sendNotificationSpy;

  beforeAll(async () => {
    await connectDB();
    // Mongoose builds indexes in the background; wait so the unique indexes exist before the first test
    await Request.init();
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  beforeEach(() => {
    // Without this mock, a well-formed subscription would be sent to the real push service over
    // the network (web-push sends even with no VAPID keys, which tests/setupEnv.js leaves unset),
    // and the malformed test keys below make the real call reject and log an error.
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

  // Register through the API and reuse the cookie register sets. Logging in per
  // test would exhaust the login rate limiter (10 per 15 min per IP).
  const registerUser = async ({ name, bloodGroup, location }) => {
    userCount += 1;
    const email = `${name.toLowerCase().replace(/\s+/g, '.')}.${userCount}@example.com`;
    const res = await request(server)
      .post('/api/auth/register')
      .send({ name, email, password: 'password123', bloodGroup, location });
    expect(res.statusCode).toBe(201);
    return { id: res.body.user._id, name, email, location, cookie: res.headers['set-cookie'] };
  };

  const createBloodRequest = (cookie, bloodGroup, hospitalLocation) =>
    request(server)
      .post('/api/requests')
      .set('Cookie', cookie)
      .send({
        bloodGroup,
        unitsNeeded: 2,
        hospitalName: 'Privacy Test Hospital',
        hospitalLocation,
        urgency: 'high',
      });

  // Proves no donor detail made it into the response, wherever it might be nested
  const expectNoDonorDetailsIn = (responseText, donors) => {
    donors.forEach((donor) => {
      expect(responseText).not.toContain(donor.id);
      expect(responseText).not.toContain(donor.email);
      expect(responseText).not.toContain(donor.name);
      // Exact home coordinates
      expect(responseText).not.toContain(String(donor.location[0]));
      expect(responseText).not.toContain(String(donor.location[1]));
    });
  };

  const expectPinsHaveAtMostTwoDecimals = (pins) => {
    pins.forEach((pin) => {
      expect(Object.keys(pin)).toEqual(['coordinates']);
      expect(pin.coordinates).toHaveLength(2);
      pin.coordinates.forEach((value) => {
        expect(typeof value).toBe('number');
        expect(String(value)).toMatch(AT_MOST_TWO_DECIMALS);
      });
    });
  };

  it('returns only a donor count and rounded, deduplicated pins, while still notifying every donor', async () => {
    // Coordinates are [longitude, latitude]
    const HOSPITAL = [77.5946, 12.9716]; // Bangalore
    const PUSH_SUBSCRIPTION = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/x',
      keys: { p256dh: 'a', auth: 'b' },
    };

    // The requester is O+, which could donate to B+, so the count also proves they are excluded
    const requester = await registerUser({ name: 'Rita Requester', bloodGroup: 'O+', location: HOSPITAL });

    // Alice and Bruno both round to the pin [77.6, 12.98]; Chloe rounds to [77.57, 12.94]
    const alice = await registerUser({ name: 'Alice Samepin', bloodGroup: 'O-', location: [77.6012, 12.9751] });
    const bruno = await registerUser({ name: 'Bruno Samepin', bloodGroup: 'B+', location: [77.6031, 12.9788] });
    const chloe = await registerUser({ name: 'Chloe Pushsub', bloodGroup: 'B-', location: [77.5655, 12.9352] });
    // A+ cannot donate to B+
    const dmitri = await registerUser({ name: 'Dmitri Wrongtype', bloodGroup: 'A+', location: [77.5988, 12.9699] });
    // Compatible, but about 25 km from the hospital
    const elena = await registerUser({ name: 'Elena Faraway', bloodGroup: 'O-', location: [77.8246, 12.9811] });

    // Written directly on the model, as the /api/push/subscribe route would store it
    await User.findByIdAndUpdate(chloe.id, { pushSubscription: PUSH_SUBSCRIPTION });
    const storedChloe = await User.findById(chloe.id).lean();
    expect(storedChloe.pushSubscription).toEqual(PUSH_SUBSCRIPTION);

    // Replaces io.to() so the test can see which rooms were notified and with which matchType
    const emit = jest.fn();
    const socketTo = jest.spyOn(io, 'to').mockReturnValue({ emit });

    const res = await createBloodRequest(requester.cookie, 'B+', HOSPITAL);

    expect(res.statusCode).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual(['donorPins', 'matchedDonorCount', 'message', 'request']);
    expect(res.body).not.toHaveProperty('matchedDonors');
    expect(res.body).not.toHaveProperty('matchedDonorDetails');

    expect(res.body.matchedDonorCount).toBe(3);
    // Exact order: sorted by longitude, then latitude
    expect(res.body.donorPins).toEqual([{ coordinates: [77.57, 12.94] }, { coordinates: [77.6, 12.98] }]);
    expectPinsHaveAtMostTwoDecimals(res.body.donorPins);

    // Check the raw JSON text so a leak in any nested field is caught
    expectNoDonorDetailsIn(res.text, [alice, bruno, chloe, dmitri, elena]);
    expect(res.text).not.toMatch(/"pushSubscription"\s*:/);
    expect(res.text).not.toMatch(/"endpoint"\s*:/);
    expect(res.text).not.toContain('fcm.googleapis.com');
    expect(res.text).not.toContain('p256dh');

    // Every matched donor still gets the live socket event, with the right match type
    const matchTypeByRoom = Object.fromEntries(
      socketTo.mock.calls.map(([room], index) => [room, emit.mock.calls[index][1].matchType])
    );
    expect(matchTypeByRoom).toEqual({
      [alice.id]: 'compatible',
      [bruno.id]: 'exact',
      [chloe.id]: 'compatible',
    });
    emit.mock.calls.forEach(([eventName]) => expect(eventName).toBe('newBloodRequest'));

    // Chloe is the only donor with a subscription, so she is the only push recipient
    expect(sendNotificationSpy).toHaveBeenCalledTimes(1);
    const [subscription, payload] = sendNotificationSpy.mock.calls[0];
    expect(subscription).toEqual(PUSH_SUBSCRIPTION);
    expect(JSON.parse(payload)).toMatchObject({
      body: 'Rita Requester needs 2 units of B+ at Privacy Test Hospital. You are a compatible match!',
    });
  });

  it('rounds negative coordinates away from zero and merges donors on the same pin', async () => {
    const HOSPITAL = [-46.6333, -23.5505]; // São Paulo

    const requester = await registerUser({ name: 'Sofia Requester', bloodGroup: 'A+', location: HOSPITAL });
    // Both round to [-46.64, -23.55]
    const firstDonor = await registerUser({ name: 'Gustavo Southpin', bloodGroup: 'O-', location: [-46.6351, -23.5472] });
    const secondDonor = await registerUser({ name: 'Helena Southpin', bloodGroup: 'O-', location: [-46.6389, -23.5461] });
    // -46.625 is an exact half: it must become -46.63, not -46.62
    const thirdDonor = await registerUser({ name: 'Ivo Halfway', bloodGroup: 'O-', location: [-46.625, -23.5449] });

    const res = await createBloodRequest(requester.cookie, 'O-', HOSPITAL);

    expect(res.statusCode).toBe(201);
    expect(res.body.matchedDonorCount).toBe(3);
    // Exact order: sorted by longitude, then latitude
    expect(res.body.donorPins).toEqual([{ coordinates: [-46.64, -23.55] }, { coordinates: [-46.63, -23.54] }]);
    expectPinsHaveAtMostTwoDecimals(res.body.donorPins);
    expectNoDonorDetailsIn(res.text, [firstDonor, secondDonor, thirdDonor]);
    expect(sendNotificationSpy).not.toHaveBeenCalled();
  });

  it('returns a zero count and no pins when no compatible donor is in range', async () => {
    const HOSPITAL = [77.5946, 12.9716];
    const requester = await registerUser({ name: 'Tara Requester', bloodGroup: 'B+', location: HOSPITAL });
    // O+ cannot donate to O-
    await registerUser({ name: 'Umar Wrongtype', bloodGroup: 'O+', location: [77.6, 12.975] });

    const res = await createBloodRequest(requester.cookie, 'O-', HOSPITAL);

    expect(res.statusCode).toBe(201);
    expect(res.body.matchedDonorCount).toBe(0);
    expect(res.body.donorPins).toEqual([]);
  });

  // Notifications use EXACT homes; the count and pins use ROUNDED homes only.
  // Every donor below sits due north or south of EDGE_HOSPITAL at a longitude that rounds to
  // 77.59, so each distance is essentially the latitude gap (0.01 degrees is ~1.11 km):
  //   - the exact 15 km edge is at latitude 13.1022 (north) and 12.8328 (south);
  //   - north homes from 13.095 to 13.105 round to 13.10, which is 14.75 km away (inside);
  //   - south homes from 12.825 to 12.835 round to 12.83, which is 15.31 km away (outside).
  // Each home is at least ~140 m from the exact edge and ~250 m from a rounding boundary.
  describe('near the 15 km edge', () => {
    const EDGE_HOSPITAL = [77.59, 12.9675];

    const spyOnSocket = () => jest.spyOn(io, 'to').mockReturnValue({ emit: jest.fn() });

    const registerRequester = () =>
      // A+ cannot donate to B+, so the requester is never a candidate
      registerUser({ name: 'Vera Requester', bloodGroup: 'A+', location: EDGE_HOSPITAL });

    const subscribeToPush = async (donorId, endpointSuffix) => {
      const subscription = {
        endpoint: `https://fcm.googleapis.com/fcm/send/${endpointSuffix}`,
        keys: { p256dh: 'a', auth: 'b' },
      };
      await User.findByIdAndUpdate(donorId, { pushSubscription: subscription });
      return subscription;
    };

    it('counts and pins a donor whose exact home is just outside 15 km but whose rounded point is inside, without notifying them', async () => {
      const requester = await registerRequester();
      // Exactly 15.14 km away; rounds to [77.59, 13.1], 14.75 km away
      const donor = await registerUser({ name: 'Wes Justoutside', bloodGroup: 'O-', location: [77.5912, 13.1035] });
      await subscribeToPush(donor.id, 'just-outside');
      const socketTo = spyOnSocket();

      const res = await createBloodRequest(requester.cookie, 'B+', EDGE_HOSPITAL);

      expect(res.statusCode).toBe(201);
      expect(res.body.matchedDonorCount).toBe(1);
      expect(res.body.donorPins).toEqual([{ coordinates: [77.59, 13.1] }]);
      expect(socketTo).not.toHaveBeenCalled();
      expect(sendNotificationSpy).not.toHaveBeenCalled();
    });

    it('notifies a donor whose exact home is just inside 15 km but whose rounded point is outside, without counting or pinning them', async () => {
      const requester = await registerRequester();
      // Exactly 14.84 km away; rounds to [77.59, 12.83], 15.31 km away
      const donor = await registerUser({ name: 'Xena Justinside', bloodGroup: 'O-', location: [77.5887, 12.8342] });
      const subscription = await subscribeToPush(donor.id, 'just-inside');
      const socketTo = spyOnSocket();

      const res = await createBloodRequest(requester.cookie, 'B+', EDGE_HOSPITAL);

      expect(res.statusCode).toBe(201);
      expect(res.body.matchedDonorCount).toBe(0);
      expect(res.body.donorPins).toEqual([]);
      expect(socketTo).toHaveBeenCalledTimes(1);
      expect(socketTo).toHaveBeenCalledWith(donor.id);
      expect(sendNotificationSpy).toHaveBeenCalledTimes(1);
      expect(sendNotificationSpy).toHaveBeenCalledWith(subscription, expect.any(String));
    });

    it('neither notifies nor counts a donor who is only inside the wider candidate search', async () => {
      const requester = await registerRequester();
      // 16.41 km away exactly and 16.42 km once rounded to [77.59, 12.82]: inside the
      // RADIUS_KM + PIN_CANDIDATE_MARGIN_KM query, but outside 15 km both ways
      const donor = await registerUser({ name: 'Yuri Ringonly', bloodGroup: 'O-', location: [77.5905, 12.8201] });
      await subscribeToPush(donor.id, 'ring-only');
      const socketTo = spyOnSocket();

      const res = await createBloodRequest(requester.cookie, 'B+', EDGE_HOSPITAL);

      expect(res.statusCode).toBe(201);
      expect(res.body.matchedDonorCount).toBe(0);
      expect(res.body.donorPins).toEqual([]);
      expect(socketTo).not.toHaveBeenCalled();
      expect(sendNotificationSpy).not.toHaveBeenCalled();
    });

    // The key property: the response depends only on rounded homes. Two donors whose exact
    // homes differ, one inside and one outside 15 km, but which round to the same point must
    // look identical to the requester. Otherwise the count would reveal the exact edge.
    it.each([
      {
        pinSide: 'inside',
        insideHome: [77.5931, 13.0991], // 14.65 km exactly
        outsideHome: [77.5868, 13.1035], // 15.14 km exactly
        // Both round to [77.59, 13.1], 14.75 km away, so both are counted
        expectedVisible: { matchedDonorCount: 1, donorPins: [{ coordinates: [77.59, 13.1] }] },
      },
      {
        pinSide: 'outside',
        insideHome: [77.5887, 12.8342], // 14.84 km exactly
        outsideHome: [77.5921, 12.8313], // 15.16 km exactly
        // Both round to [77.59, 12.83], 15.31 km away, so neither is counted
        expectedVisible: { matchedDonorCount: 0, donorPins: [] },
      },
    ])(
      'returns the same count and pins for two donors on one rounded point $pinSide 15 km, one exactly inside and one exactly outside',
      async ({ insideHome, outsideHome, expectedVisible }) => {
        const requester = await registerRequester();
        const insideDonor = await registerUser({ name: 'Zoe Insidehome', bloodGroup: 'O-', location: insideHome });
        const outsideDonor = await registerUser({ name: 'Zack Outsidehome', bloodGroup: 'O-', location: outsideHome });
        const socketTo = spyOnSocket();
        const visiblePart = (res) => ({ matchedDonorCount: res.body.matchedDonorCount, donorPins: res.body.donorPins });

        // Only one of the two donors is available for each request, so each request sees exactly one
        await User.findByIdAndUpdate(outsideDonor.id, { isAvailable: false });
        const withInsideDonor = await createBloodRequest(requester.cookie, 'B+', EDGE_HOSPITAL);
        const notifiedWithInsideDonor = socketTo.mock.calls.map(([room]) => room);

        socketTo.mockClear();
        await User.findByIdAndUpdate(insideDonor.id, { isAvailable: false });
        await User.findByIdAndUpdate(outsideDonor.id, { isAvailable: true });
        const withOutsideDonor = await createBloodRequest(requester.cookie, 'B+', EDGE_HOSPITAL);
        const notifiedWithOutsideDonor = socketTo.mock.calls.map(([room]) => room);

        expect(withInsideDonor.statusCode).toBe(201);
        expect(withOutsideDonor.statusCode).toBe(201);
        // Notifications prove the two homes really are on opposite sides of the exact edge...
        expect(notifiedWithInsideDonor).toEqual([insideDonor.id]);
        expect(notifiedWithOutsideDonor).toEqual([]);
        // ...yet the requester sees exactly the same thing either way
        expect(visiblePart(withOutsideDonor)).toEqual(visiblePart(withInsideDonor));
        expect(visiblePart(withInsideDonor)).toEqual(expectedVisible);
      }
    );
  });
});
