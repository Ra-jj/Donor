import { io } from 'socket.io-client';

const SOCKET_URL = import.meta.env.MODE === "development" ? "http://localhost:8000" : "/"; // Make sure this matches backend PORT

let socket = null;

export const initSocket = (userId) => {
  if (socket) return socket;

  socket = io(SOCKET_URL, {
    query: { userId },
    withCredentials: true,
  });

  socket.on('connect', () => {
    // Socket connected
  });

  socket.on('disconnect', () => {
    // Socket disconnected
  });

  return socket;
};

export const getSocket = () => {
  if (!socket) {
    console.warn('Socket not initialized! Call initSocket first.');
  }
  return socket;
};

export const disconnectSocket = () => {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
};
