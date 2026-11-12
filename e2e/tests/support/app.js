// The `app` fixture every test uses, and helpers for the app's live (socket.io) behaviour.
//
// Tests share one server and one database, and run in parallel, so each test keeps to itself:
// - its own spot on the map, at least ~46 km from any other test's. The app alerts compatible
//   donors within 15 km of a request (it searches 17 km, then keeps those within 15), so a request in one test
//   never reaches another test's donor;
// - its own client address for every browser it opens, sent as X-Forwarded-For. The server runs
//   with its production default of one trusted proxy hop and nothing in front of it, so this is
//   the address the rate limiters see, as if each simulated person were on their own network.
//   The limits stay exactly as in production (10 sign-ups and 10 logins per address); each test
//   stays far below them on every address, whatever order the tests run in and however often;
// - its own accounts, made through the real sign-up API (or the sign-up page itself).
import { test as base, expect } from '@playwright/test';

export { expect };

export const PASSWORD = 'e2e-password-1';

// A 1x1 transparent PNG, served for every map tile
const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

// A grid over India in half-degree steps (latitude 8-33, longitude 69-95): neighbouring cells are
// at least ~46 km apart, more than twice the 17 km (15 km plus the 2 km pin margin) within which
// the server looks for donors. A worker index can grow during a run (a new worker starts after a
// failure), so cells are dealt out worker by worker with a stride: two workers never get the same
// cell, and a worker gets through 84 tests before its cells would come round again.
const AREA_ROWS = 51;
const AREA_COLUMNS = 53;
const AREA_STEP_DEGREES = 0.5;
const WORKER_STRIDE = 32;
let areasUsedInThisWorker = 0;

const nextArea = (workerIndex) => {
  const cell = (areasUsedInThisWorker * WORKER_STRIDE + workerIndex) % (AREA_ROWS * AREA_COLUMNS);
  areasUsedInThisWorker += 1;
  return {
    latitude: 8 + (cell % AREA_ROWS) * AREA_STEP_DEGREES,
    longitude: 69 + Math.floor(cell / AREA_ROWS) * AREA_STEP_DEGREES,
  };
};

// 198.18.0.0/15 is reserved for network tests (RFC 2544), so it is nobody's real address. IPv4 on
// purpose: express-rate-limit counts IPv6 addresses per /56 network, not per address.
let addressesUsedInThisWorker = 0;
const nextClientAddress = (workerIndex) => {
  const n = addressesUsedInThisWorker * WORKER_STRIDE + workerIndex;
  addressesUsedInThisWorker += 1;
  return `198.${18 + (Math.floor(n / 65536) % 2)}.${Math.floor(n / 256) % 256}.${n % 256}`;
};

let namesUsedInThisWorker = 0;
const nextUniqueSuffix = (workerIndex) => {
  namesUsedInThisWorker += 1;
  return `w${workerIndex}n${namesUsedInThisWorker}`;
};

// The tests never reach the internet: map tiles and the Google Fonts stylesheet are answered
// here (the page then falls back to system fonts), and anything else off the app's own origin
// (place search) is refused. The service worker's own requests are all same-origin.
const keepRequestsLocal = async (context, appOrigin) => {
  await context.route(
    (url) => url.origin !== appOrigin,
    (route) => {
      const { hostname } = new URL(route.request().url());
      if (hostname === 'tile.openstreetmap.org') {
        return route.fulfill({ status: 200, contentType: 'image/png', body: TRANSPARENT_PNG });
      }
      if (hostname === 'fonts.googleapis.com') {
        return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
      }
      return route.abort('blockedbyclient');
    },
  );
};

// One API call made with a browser's own cookies and client address. Throws with the server's
// answer, so a failed setup step says what went wrong.
const callApi = async (context, method, url, data) => {
  const response = await context.request.fetch(url, { method, data });
  if (!response.ok()) {
    throw new Error(`${method} ${url} answered ${response.status()}: ${await response.text()}`);
  }
  return response.json();
};

/**
 * Resolves once the server has accepted the page's socket.io connection: its CONNECT
 * acknowledgement ("40{...}") arrived, over HTTP long-polling or the WebSocket. By then the server
 * has put the socket in the user's room, so events sent from now on reach this page. Call it
 * before the navigation that opens the socket, or the acknowledgement can be missed.
 */
export const waitForLiveConnection = (page, timeoutMs = 15_000) =>
  new Promise((resolve, reject) => {
    const CONNECT_ACK = /(^|\u001e)40\{/;
    let timer = null;
    const stop = () => {
      clearTimeout(timer);
      page.off('response', onResponse);
      page.off('websocket', onWebSocket);
    };
    const onResponse = async (response) => {
      if (!response.url().includes('/socket.io/') || response.request().method() !== 'GET') return;
      const body = await response.text().catch(() => '');
      if (CONNECT_ACK.test(body)) {
        stop();
        resolve();
      }
    };
    const onWebSocket = (webSocket) => {
      if (!webSocket.url().includes('/socket.io/')) return;
      webSocket.on('framereceived', ({ payload }) => {
        if (CONNECT_ACK.test(String(payload))) {
          stop();
          resolve();
        }
      });
    };
    page.on('response', onResponse);
    page.on('websocket', onWebSocket);
    timer = setTimeout(() => {
      stop();
      reject(new Error(`the server did not accept a socket.io connection from ${page.url()} within ${timeoutMs / 1000} s`));
    }, timeoutMs);
  });

/** Opens a page and waits until it is connected for live updates */
export const gotoLive = async (page, path) => {
  const connected = waitForLiveConnection(page);
  await page.goto(path);
  await connected;
};

/**
 * Records the page's own socket.io traffic: every HTTP request to /socket.io/ and every WebSocket.
 * Start it before the page loads. The service worker never requests /socket.io/.
 */
export const recordSocketTraffic = (page) => {
  const traffic = { requests: [], webSockets: [] };
  page.on('request', (request) => {
    if (request.url().includes('/socket.io/')) traffic.requests.push(`${request.method()} ${request.url()}`);
  });
  page.on('websocket', (webSocket) => {
    if (webSocket.url().includes('/socket.io/')) traffic.webSockets.push(webSocket.url());
  });
  return traffic;
};

/**
 * Waits until the service worker controls the page. The app registers it only once the first
 * screen is up and the browser is idle, so this is also the point by which a socket opened while
 * the app started would already have sent its first request.
 */
export const waitForServiceWorkerControl = (page) =>
  page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 30_000 });

// How far ahead expectNoReload runs the page's timers
const PENDING_TIMERS_WINDOW_MS = 5_000;

/**
 * Opens a page for live updates, like gotoLive, and starts watching it for reloads until
 * expectNoReload. Use it instead of gotoLive for a page whose update must arrive without one.
 *
 * - Playwright's clock goes on the page before it loads. Time on the page still passes as usual,
 *   but expectNoReload can then run at once every timer the page has set for the next few
 *   seconds, so a reload scheduled for a moment after an update starts before the check rather
 *   than after the test has ended.
 * - The document gets a mark. A reload, or any other page load, replaces the document and the mark
 *   goes with it.
 * - Every navigation to another document is counted as it begins, through the Navigation API's
 *   'navigate' event. Route changes inside the app (same document) are not counted.
 */
export const gotoLiveAndWatchForReloads = async (page, path) => {
  await page.clock.install();
  await gotoLive(page, path);
  await page.evaluate(() => {
    window.__e2eDocumentMark = true;
    window.__e2eDocumentLoadsStarted = 0;
    window.navigation.addEventListener('navigate', (event) => {
      if (!event.destination.sameDocument) window.__e2eDocumentLoadsStarted += 1;
    });
  });
};

/** Fails if the page reloaded, or began to, since gotoLiveAndWatchForReloads */
export const expectNoReload = async (page) => {
  await page.clock.runFor(PENDING_TIMERS_WINDOW_MS);
  const state = await page
    .evaluate(() => ({
      isSameDocument: window.__e2eDocumentMark === true,
      documentLoadsStarted: window.__e2eDocumentLoadsStarted ?? null,
    }))
    // The page's document went away while being asked: a load had begun
    .catch((error) => ({ isSameDocument: false, documentLoadsStarted: null, error: error.message.split('\n')[0] }));
  expect(
    state,
    `${page.url()} reloaded or began loading a page since it was opened; the update should have arrived without one`,
  ).toEqual({ isSameDocument: true, documentLoadsStarted: 0 });
};

export const test = base.extend({
  app: async ({ browser, baseURL }, use, testInfo) => {
    const area = nextArea(testInfo.workerIndex);
    const appOrigin = new URL(baseURL).origin;
    const contexts = [];

    const openContext = async () => {
      const context = await browser.newContext({
        baseURL,
        geolocation: area,
        permissions: ['geolocation'],
        extraHTTPHeaders: { 'X-Forwarded-For': nextClientAddress(testInfo.workerIndex) },
      });
      contexts.push(context);
      await keepRequestsLocal(context, appOrigin);
      return context;
    };

    const app = {
      newEmail: (label) => `${label}.${nextUniqueSuffix(testInfo.workerIndex)}@example.com`,

      newHospitalName: () => `Test Hospital ${nextUniqueSuffix(testInfo.workerIndex)}`,

      /** A browser of its own with nobody signed in */
      openVisitor: async () => {
        const context = await openContext();
        return { context, page: await context.newPage() };
      },

      /**
       * A new account living in this test's area, made through the sign-up API from a browser of
       * its own, which that sign-up's cookie then signs in. Returns the person, their browser
       * (one page, not opened yet) and API shortcuts for steps a test does not exercise itself.
       */
      signUp: async ({ name, bloodGroup }) => {
        const context = await openContext();
        const email = app.newEmail(name.split(' ')[0].toLowerCase());
        const { user } = await callApi(context, 'POST', '/api/auth/register', {
          name,
          email,
          password: PASSWORD,
          bloodGroup,
          location: [area.longitude, area.latitude],
          acceptPrivacy: true,
          confirmAdult: true,
        });
        return {
          id: user._id,
          name,
          email,
          context,
          page: await context.newPage(),
          /** POST /api/requests at this test's area; returns { request, shareToken, ... } */
          createRequest: ({ hospitalName, bloodGroup: neededGroup = 'A+', unitsNeeded = 1, urgency = 'high' }) =>
            callApi(context, 'POST', '/api/requests', {
              bloodGroup: neededGroup,
              unitsNeeded,
              hospitalName,
              hospitalLocation: [area.longitude, area.latitude],
              urgency,
            }),
          acceptRequest: (requestId) =>
            callApi(context, 'PATCH', `/api/requests/${requestId}/status`, { status: 'accepted' }),
          fulfilRequest: (requestId) => callApi(context, 'PATCH', `/api/requests/${requestId}/fulfill`),
        };
      },
    };

    await use(app);

    for (const context of contexts) await context.close();
  },
});
