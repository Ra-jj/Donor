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
- **Premium Custom UI & Dark Mode:** A beautifully customized interface featuring glassmorphism, Framer Motion animations, Phosphor Icons, and a user-toggled Dark Mode preference that persists via cookies.
- **PWA & Offline Support:** Installable as a progressive web app. Features a fully-blocking offline overlay that prevents users from interacting with stale, broken forms during network drops in emergencies.
- **Robust Security:** JWT-based authentication with HTTP-only cookies, password hashing, Zod schema validation for all endpoints, and API rate-limiting to prevent abuse.

## 🛠 Tech Stack
**Frontend:**
- React 19 (Vite)
- Zustand (State Management)
- Tailwind CSS v4 & DaisyUI
- Framer Motion (Animations)
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
```

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
4. Provide the environment variables (`NODE_ENV=production`, `PORT=8000`, `MONGO_URI`, `JWT_SECRET`).
5. Deploy!
