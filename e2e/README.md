# Browser tests (e2e)

Playwright tests that drive the built client in Chromium against the real server, the way Render runs it: `node server/index.js` with `NODE_ENV=production`, serving `client/dist`. The database is a throwaway in-memory MongoDB replica set, and there are no VAPID keys, so web push stays off. Nothing here reads `server/.env`.

This folder has its own `package.json` and lockfile. Render's build only installs `server/` and `client/`, so it never installs Playwright.

## Run them locally

You need Node 24, the server's dependencies and a fresh client build:

```bash
cd server && npm ci && cd ..
cd client && npm ci && npm run build && cd ..
cd e2e && npm ci && npm test
```

- The tests need Chromium build 1243, the one `@playwright/test` 1.63.0 uses. If `~/Library/Caches/ms-playwright` (macOS) or `~/.cache/ms-playwright` (Linux) doesn't have it, run `npx playwright install chromium` once in `e2e/`. That command can also delete older browser builds from that shared folder, which other projects' Playwright versions may still use.
- Rebuild the client (`npm run build` in `client/`) after changing it: the tests run whatever is in `client/dist`. The server script prints a warning when a file in `client/src`, `client/public`, `client/index.html` or `client/vite.config.js` is newer than the build.
- The server listens on port 8850. If that port is busy the run stops; choose another with `E2E_PORT=8860 npm test`.
- `npm run report` opens the HTML report. After a failure, `test-results/` holds a screenshot of each open page and a trace (`npx playwright show-trace test-results/<test>/trace.zip`).
- Run one file with `npx playwright test tests/live-updates.spec.js`, or one test with `-g "chat messages"`.

## What they cover

| File | Test |
| --- | --- |
| `account.spec.js` | Sign up through the form, including both privacy agreements (it refuses without them), then log out (and check the server ended the session: `/dashboard` now sends the browser to the login page) and log back in |
| `live-updates.spec.js` | Two people in two browsers: a new request reaches a matching donor live; the requester's dashboard updates live when the donor accepts; chat messages arrive live both ways; the donor gets a live notice when the request is marked fulfilled; the donor sees the requester's rating live. Each also checks that the updated page did not reload, nor start to: at the end it runs the page's timers for the next 5 seconds at once (Playwright's clock), so a reload set for shortly after the update is caught too. |
| `shared-request.spec.js` | A shared link (`/r/<token>`) shows the request to someone signed out |
| `privacy-consent.spec.js` | A user who must agree to a newer Privacy Notice gets the consent screen and no socket until they press Continue, then the dashboard and a socket |
| `signed-out.spec.js` | The signed-out home page opens no socket; offline, the overlay shows and `/` reloads from the service worker's precache |
| `block.spec.js` | A donor blocks a requester from the incoming list, and the request stays gone after a reload |

## How they stay independent

The tests share one server and run two at a time, so each test keeps to itself (see `tests/support/app.js`):

- **Accounts:** each test makes its own users through the real sign-up API, or the sign-up form. The one direct database change is in `tests/support/database.js`: it makes a user's privacy agreement out of date, which no API can do.
- **Location:** each test gets its own spot on the map, at least ~46 km from any other test's, so its requests never reach another test's donors (the app alerts donors within 15 km).
- **Rate limits:** the limits are the production ones (for example 10 sign-ups per address per hour). Every browser a test opens sends its own `X-Forwarded-For` address from 198.18.0.0/15, a range reserved for testing. The server trusts one proxy hop, its production default, and nothing sits in front of it here, so that is the address its limiters count. No test comes near a limit on any address.
- **No internet:** map tiles and the Google Fonts stylesheet are answered locally, and any other outside request is refused.

## In CI

The "Browser tests" job in `.github/workflows/ci.yml` installs `server/`, `client/` and `e2e/`, builds the client, installs Chromium and its system libraries (`npx playwright install --with-deps chromium`, CI only), and runs `npm test`. On a failure it uploads `playwright-report/` and `test-results/` as the `playwright-report` artifact.
