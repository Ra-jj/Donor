# Donor Coordination Platform 🩸

A real-time web application designed to connect people in need of critical supplies and blood with willing donors nearby. Built with a modern, fully-responsive MERN stack architecture, real-time WebSockets, robust geospatial queries, and progressive web app (PWA) capabilities.

### 🔗 [Live Demo](https://rajcodes-donor.onrender.com)

## 🚀 Features
- **Role-Based Workflows:** Seamless experiences for those creating emergency requests and those stepping up to donate.
- **Real-Time Request Feeds:** See new donation requests instantly via Socket.io without refreshing the page.
- **Geolocation Matching:** Compatible donors within 15 km of the hospital are found with MongoDB `2dsphere` queries. Requesters see how many donors are nearby on a map, with each donor's position rounded to about 1 km and no names.
- **Hospital Search:** Requesters pick the hospital by searching OpenStreetMap Nominatim (India only, one search per second, never search-as-you-type), so their own home location is never sent by mistake. "I'm at the hospital – use my location" remains as a backup.
- **Minimum Gap Between Donations:** Donors who gave whole blood in the last 120 days (India's G.S.R. 166(E)) are not alerted and cannot accept a request. Donations through Donor are counted automatically, and donors can add one made elsewhere.
- **Coordination Chat:** Real-time messaging between the requester and the matched donor while a request is accepted.
- **Fulfillment & Ratings Lifecycle:** Requesters mark an accepted request as fulfilled once the donation is done, and can rate the donor from 1 to 5 stars.
- **User Profiles & History:** Users can see their impact stats (donations, average rating) and their past requests and donations.
- **Account Deletion:** Users can delete their account from Profile, confirmed with their password. The deletion happens at once, in a single transaction. Finished donations stay in the other person's history as "Deleted user"; everything else is erased, and every other session is signed out.
- **Privacy Notice & Consent:** A plain-language notice at `/privacy`, written to India's DPDP Act 2023 / DPDP Rules 2025. Sign-up has separate, unticked "I agree" and "I am 18 or older" checkboxes. Users who agreed to an older version are asked again, and every agreement is recorded with its version and time.
- **Custom UI & Dark Mode:** Glassmorphism, Motion animations, Phosphor Icons, and a dark mode preference that persists via a cookie.
- **PWA & Offline Support:** Installable as a progressive web app, with a blocking offline overlay so nobody submits a stale form during a network drop. A new deploy takes over at once but never reloads a page that is being used. Pages are code-split, and hashed assets are cached for a year.
- **Security:** JWT in an httpOnly, SameSite=Strict cookie, bcrypt password hashes, Zod validation on every endpoint, per-route rate limits, Helmet security headers with a strict Content Security Policy, and a startup check that refuses to run without required settings.

## 🛠 Tech Stack
**Frontend:**
- React 19 (Vite)
- Zustand (State Management)
- Tailwind CSS v4 & DaisyUI
- Motion (Animations)
- @phosphor-icons/react (Iconography)
- Vite PWA Plugin (Offline caching)
- Socket.io Client
- Leaflet + React Leaflet (OpenStreetMap maps), OpenStreetMap Nominatim (place search)

**Backend:**
- Node.js & Express 5
- MongoDB & Mongoose 
- Socket.io (WebSockets)
- JWT & Bcrypt (Auth)
- Zod (Request Validation)
- Express Rate Limit (DDoS Protection)
- Jest, Supertest & MongoMemoryServer (Testing Suite)

## 💻 Local Development

Requires **Node.js 24** (pinned in the root `package.json`, the same version CI and Render use).

### 1. Clone & Install
```bash
git clone https://github.com/Ra-jj/Donor.git
cd Donor

# Install root dependencies
npm install

# Install client and server dependencies
npm run build
```

### 2. Environment Variables
You will need a `.env` file in the `server` directory with the following variables:
```env
PORT=8000
MONGO_URI=your_mongodb_connection_string
JWT_SECRET=your_super_secret_jwt_key
NODE_ENV=development
CLIENT_URL=http://localhost:5173
# Web push (generate a key pair with: npx web-push generate-vapid-keys)
VAPID_PUBLIC_KEY=your_vapid_public_key
VAPID_PRIVATE_KEY=your_vapid_private_key
VAPID_SUBJECT=mailto:you@example.com
```

For local development, point `MONGO_URI` at a separate development database, never the production one.

The client needs a `.env` file in the `client` directory with the same public key, so browsers can subscribe to push notifications:
```env
VITE_VAPID_PUBLIC_KEY=your_vapid_public_key
```

Optional server variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `TRUST_PROXY` | `1` | Express `trust proxy` setting, which decides where `req.ip` (and so every per-IP rate limit) comes from. Accepts a hop count (`0`, `1`, `2`, ...), `true`/`false`, or a comma-separated list of IPs/subnets (e.g. `loopback, 10.0.0.0/8`). `true` trusts every hop, so any client can choose its own `req.ip`, and express-rate-limit logs `ERR_ERL_PERMISSIVE_TRUST_PROXY` for it. |
| `DEBUG_IP_ENDPOINT` | unset (off) | Set to exactly `1` to register `GET /api/debug/ip`, which returns `{ ip, ips, xff }` as Express sees them. For confirming `TRUST_PROXY` after a deploy only; unset it afterwards. |
| `CLIENT_DIST_DIR` | `client/dist` | Tests only: where the production server reads the built client from. Leave unset on Render. |
| `REGISTER_RATE_LIMIT_MAX` | `10` | Sign-ups allowed per IP per hour. When unset and `NODE_ENV=test`, the sign-up limiter is skipped so the test suite can register many users. |

#### Checking `TRUST_PROXY` after a deploy
1. Set `DEBUG_IP_ENDPOINT=1` on Render and redeploy.
2. From a phone on mobile data (not your Wi-Fi), open `https://<your-app>/api/debug/ip`, and compare `ip` with the address shown by a "what is my IP" site on the same phone.
3. If `ip` matches, the hop count is right. If not, find your real address in `xff` and count its position from the right (the last entry is 1). Set `TRUST_PROXY` to that number and repeat step 2. Never set it higher: entries to the left of your real address are whatever the client sent, so they can be faked.
4. Remove `DEBUG_IP_ENDPOINT` and redeploy. With it unset, the route is not registered (in production the path then returns the app's `index.html`).

### 3. Run the App
```bash
# Run both the client and server concurrently
npm run dev
```
- The frontend will start on `http://localhost:5173`
- The backend API will start on `http://localhost:8000`

### 4. Run Tests
The backend has about 300 Jest + Supertest tests, which run against an in-memory MongoDB replica set (so transactions work). They cover:
- authentication and rate limits;
- blood compatibility and the request lifecycle (including races between accept, cancel and fulfil);
- the 120-day donation gap;
- what nearby users are allowed to see;
- account deletion;
- privacy consent;
- socket authentication and security headers.

The tests don't read your `.env` (`tests/setupEnv.js` sets their own values).
```bash
cd server
npm test
```

The client is checked with `npm run lint -- --deny-warnings` and `npm run build` (from `client/`).

### 5. Continuous Integration
`.github/workflows/ci.yml` runs the server tests and the client lint + build on every pull request and every push to `main`. The `main` branch only accepts changes through pull requests that pass both checks. Dependabot opens monthly dependency update PRs, which go through the same checks.

## 🌍 Production Deployment
This application is configured for a single-service full-stack deployment on platforms like Render.
1. Connect your GitHub repository to Render.
2. Set the Build Command to: `npm run build`
3. Set the Start Command to: `npm start`
4. Provide the environment variables:
   - `NODE_ENV=production`, `PORT=8000`, `MONGO_URI`, `JWT_SECRET`. The server refuses to start without `MONGO_URI` and `JWT_SECRET`.
   - For push notifications: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, plus the same public key as `VITE_VAPID_PUBLIC_KEY`, which must be set when `npm run build` runs (Vite builds it into the client). Without the keys, notifications are sent unsigned and rejected by the push service (an error is logged per donor), so they never arrive.
   - `TRUST_PROXY` if the check above shows the default of `1` is wrong.
   - `CLIENT_URL` is not needed: the server serves the client from its own origin, so the browser never makes a cross-origin (CORS) request.
5. Deploy!
6. After the CI workflow (`.github/workflows/ci.yml`) has run once on `main`, set the Render service's **Settings → Auto-Deploy** to **After CI Checks Pass**, so a commit that fails the tests or the build is never deployed.

### Privacy notice
- The contact address shown on `/privacy` is `PRIVACY_CONTACT_EMAIL` in `client/src/config/privacy.js`. Set it to a real, monitored address. Use the same address for `VAPID_SUBJECT` (`mailto:...`).
- Any change to the notice text needs a new version in both `client/src/config/privacy.js` and `server/utils/privacyConsent.js`; a test fails if they differ. Users then agree to the new version at their next visit.
