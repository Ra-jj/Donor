import { io } from 'socket.io-client';

const SOCKET_URL = import.meta.env.MODE === "development" ? "http://localhost:8000" : "/"; // Make sure this matches backend PORT

// Retry delays after a server-side (middleware) connection error: 1 s, doubling, capped at 30 s
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 30000;
const RETRY_JITTER_RATIO = 0.1;

let socket = null;
// The user this socket was opened for. Used only to decide whether it can be reused; it is
// never sent to the server, which identifies the user from the httpOnly jwt cookie.
let socketUserId = null;
let retryTimer = null;
// Sockets that have connected at least once, so a listener can tell a reconnect from the first connect
const socketsConnectedBefore = new WeakSet();

// Sockets whose last connect attempt(s) failed. Their next connect must refetch even if it is
// their first, since events sent during the failure window were never delivered.
const socketsWithFailedAttempt = new WeakSet();

export const hasSocketConnectedBefore = (someSocket) => socketsConnectedBefore.has(someSocket);
export const hadFailedAttempt = (someSocket) => socketsWithFailedAttempt.has(someSocket);

export const initSocket = (userId) => {
  // The server binds a socket to whoever the cookie named at the handshake, so a socket opened
  // for another user (or one that has been closed for good) must never be handed back.
  // Reusing a live socket for the SAME user keeps React StrictMode's double checkAuth from
  // swapping the socket out from under components that already subscribed to it.
  if (socket && socketUserId === userId && socket.active) return socket;

  disconnectSocket();

  const newSocket = io(SOCKET_URL, {
    withCredentials: true,
  });
  let retryDelayMs = RETRY_BASE_DELAY_MS;

  newSocket.on('connect', () => {
    socketsConnectedBefore.add(newSocket);
    retryDelayMs = RETRY_BASE_DELAY_MS;
    // This listener runs first, and every other 'connect' listener runs synchronously in the
    // same emit, so clearing in a microtask lets each of them read the flag exactly once
    queueMicrotask(() => socketsWithFailedAttempt.delete(newSocket));
  });

  newSocket.on('connect_error', (error) => {
    if (error.message === 'Unauthorized') {
      // A server-side rejection: stop here so the client never retries in a loop
      console.error('Socket connection rejected by server: Unauthorized');
      newSocket.disconnect();
      return;
    }
    socketsWithFailedAttempt.add(newSocket);

    // Still active: a transport failure, which the manager retries by itself. Inactive: the
    // server's middleware returned an error, and socket.io-client never retries that on its own.
    // Retry only while this is still the app's socket, so a logout or user switch stops it.
    if (newSocket.active || socket !== newSocket) return;

    const delayMs = Math.round(retryDelayMs * (1 + Math.random() * RETRY_JITTER_RATIO));
    console.warn(`Socket connection rejected by server: ${error.message}. Retrying in ${delayMs} ms`);
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (socket === newSocket && !newSocket.active) newSocket.connect();
    }, delayMs);
    retryDelayMs = Math.min(retryDelayMs * 2, RETRY_MAX_DELAY_MS);
  });

  socket = newSocket;
  socketUserId = userId;
  return socket;
};

export const getSocket = () => {
  if (!socket) {
    console.warn('Socket not initialized! Call initSocket first.');
  }
  return socket;
};

export const disconnectSocket = () => {
  clearTimeout(retryTimer);
  retryTimer = null;
  if (socket) {
    socket.disconnect();
    socket = null;
    socketUserId = null;
  }
};
