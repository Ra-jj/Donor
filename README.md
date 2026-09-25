# Donor Coordination Platform 🩸

A real-time web application designed to connect people in need of critical supplies and blood with willing donors nearby. Built with a modern, fully-responsive MERN stack architecture, real-time WebSockets, robust geospatial queries, and progressive web app (PWA) capabilities.

### 🔗 [Live Demo](https://rajcodes-donor.onrender.com)

## 🚀 Features
- **Role-Based Workflows:** Seamless experiences for those creating emergency requests and those stepping up to donate.
- **Real-Time Request Feeds:** See new donation requests instantly via Socket.io without refreshing the page.
- **Geolocation Matching:** Users provide their location, allowing the platform to calculate real-world distances using MongoDB `2dsphere` indexes and match donors with nearby emergencies.
- **Coordination Chat:** Built-in real-time messaging between the requester and the matched donor to coordinate drop-offs.
- **Fulfillment & Ratings Lifecycle:** Requesters can mark an accepted request as "Fulfilled" once the donation is complete, and submit a 5-star rating for the donor. 
- **User Profiles & History:** Users can track their "Impact Stats" (lives saved, average rating) and view their historical requests and donations.
- **Premium Custom UI & Dark Mode:** A beautifully customized interface featuring glassmorphism, Motion animations, Phosphor Icons, and a user-toggled Dark Mode preference that persists via cookies.
- **PWA & Offline Support:** Installable as a progressive web app. Features a fully-blocking offline overlay that prevents users from interacting with stale, broken forms during network drops in emergencies.
- **Robust Security:** JWT-based authentication with HTTP-only cookies, password hashing, Zod schema validation for all endpoints, and API rate-limiting to prevent abuse.

## 🛠 Tech Stack
**Frontend:**
- React 19 (Vite)
- Zustand (State Management)
- Tailwind CSS v4 & DaisyUI
- Motion (Animations)
- @phosphor-icons/react (Iconography)
- Vite PWA Plugin (Offline caching)
- Socket.io Client

**Backend:**
- Node.js & Express 5
- MongoDB & Mongoose 
- Socket.io (WebSockets)
- JWT & Bcrypt (Auth)
- Zod (Request Validation)
- Express Rate Limit (DDoS Protection)
- Jest, Supertest & MongoMemoryServer (Testing Suite)

## 💻 Local Development

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
The backend includes a suite of Jest tests covering authentication, blood compatibility algorithms, and request workflows using an in-memory MongoDB server.
```bash
cd server
npm test
```

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
