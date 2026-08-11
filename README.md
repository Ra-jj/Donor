# Donor Coordination Platform 🩸

A real-time web application designed to connect hospitals in need of critical supplies/blood with willing donors. Built with a modern, fully-responsive MERN stack architecture and real-time WebSockets.

## 🚀 Features
- **Role-Based Dashboards:** Separate experiences for Hospitals (creating requests) and Donors (accepting requests).
- **Real-Time Request Feeds:** See new donation requests instantly via Socket.io without refreshing.
- **Coordination Chat:** Built-in real-time messaging between the hospital and the matched donor to coordinate drop-offs.
- **Urgency Tags:** Requests are tagged with Low, Medium, or High urgency for immediate prioritization.
- **Modern UI:** Built with Tailwind CSS and DaisyUI for a beautiful, responsive, and accessible interface.
- **Secure Authentication:** JWT-based authentication with HTTP-only cookies.

## 🛠 Tech Stack
**Frontend:**
- React 19 (Vite)
- Zustand (State Management)
- Tailwind CSS & DaisyUI
- React Router DOM
- Socket.io Client

**Backend:**
- Node.js & Express 5
- MongoDB & Mongoose
- Socket.io (WebSockets)
- JWT (JSON Web Tokens)
- Bcrypt (Password Hashing)

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

## 🌍 Production Deployment
This application is configured for a single-service full-stack deployment on platforms like Render.
1. Connect your GitHub repository to Render.
2. Set the Build Command to: `npm run build`
3. Set the Start Command to: `npm start`
4. Provide the environment variables (`NODE_ENV=production`, `PORT=8000`, `MONGO_URI`, `JWT_SECRET`).
5. Deploy!
