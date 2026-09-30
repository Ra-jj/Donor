import { create } from 'zustand';
import { axiosInstance } from '../lib/axios';
import { initSocket, disconnectSocket } from '../lib/socket';
import toast from 'react-hot-toast';

// Shown inside the delete-account dialog, which stays open, so each says what to do next
const describeDeleteAccountError = (error) => {
  if (!error.response) return 'No response from the server. Please try again.';
  const { status, data } = error.response;
  if (data?.errors?.password) return data.errors.password;
  if (status >= 500) return 'Account deletion failed on the server. Please try again.';
  // 403 wrong password and 429 too many attempts carry their own message
  return data?.message || `Account deletion failed (HTTP ${status}). Please try again.`;
};

// Every window of this browser shares one jwt cookie, so a deletion signs all of them out, but
// only the window that sent it hears the answer. This channel tells the others. One object both
// sends and receives: a BroadcastChannel never gets its own messages, but a second object with
// the same name in this same window would.
const authChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('donor-auth') : null;

// True while this window's own DELETE is on its way: its answer, not another window's notice, then
// decides what this window shows
let isDeletingInThisWindow = false;

const announceAccountDeleted = () => {
  authChannel?.postMessage({ type: 'account-deleted' });
};

export const useAuthStore = create((set, get) => ({
  authUser: null,
  isCheckingAuth: true,

  checkAuth: async () => {
    try {
      const res = await axiosInstance.get('/auth/check');
      // Socket first, so components rendered for this user subscribe to this user's socket.
      // initSocket reuses a live socket only if it was opened for this same user.
      initSocket(res.data.user._id);
      set({ authUser: res.data.user });
    } catch (error) {
      // 401 just means "not logged in", which is normal on public pages
      if (error.response?.status !== 401) {
        console.error('Error in checkAuth:', error);
      }
      set({ authUser: null });
    } finally {
      set({ isCheckingAuth: false });
    }
  },

  register: async (data) => {
    try {
      const res = await axiosInstance.post('/auth/register', data);
      // The server just set a new jwt cookie, so always open a new socket authenticated by it
      disconnectSocket();
      initSocket(res.data.user._id);
      set({ authUser: res.data.user });
      toast.success('Account created successfully');
      return { success: true };
    } catch (error) {
      if (error.response?.data?.errors) {
        return { success: false, errors: error.response.data.errors };
      }
      toast.error(error.response?.data?.message || 'Registration failed');
      return { success: false };
    }
  },

  login: async (data) => {
    try {
      const res = await axiosInstance.post('/auth/login', data);
      // The server just set a new jwt cookie, so always open a new socket authenticated by it
      disconnectSocket();
      initSocket(res.data.user._id);
      set({ authUser: res.data.user });
      toast.success('Logged in successfully');
      return { success: true };
    } catch (error) {
      if (error.response?.data?.errors) {
        return { success: false, errors: error.response.data.errors };
      }
      toast.error(error.response?.data?.message || 'Login failed');
      return { success: false };
    }
  },

  // The dashboard gets a fresh nextEligibleDonationAt with every incoming-requests load (for
  // example right after a donation is marked fulfilled). Keeping it on authUser means the
  // Profile page shows the same date. Unchanged values return the same state, so nothing re-renders.
  setNextEligibleDonationAt: (nextEligibleDonationAt) =>
    set((state) => {
      if (!state.authUser || state.authUser.nextEligibleDonationAt === nextEligibleDonationAt) return state;
      return { authUser: { ...state.authUser, nextEligibleDonationAt } };
    }),

  logout: async () => {
    try {
      await axiosInstance.post('/auth/logout');
      set({ authUser: null });
      disconnectSocket();
      toast.success('Logged out successfully');
    } catch (error) {
      toast.error(error.response?.data?.message || 'Logout failed');
    }
  },

  // The server checks the password, erases the account, clears the jwt cookie and closes this
  // user's sockets. Nothing here changes unless that succeeded or the session is over, so a wrong
  // password keeps the user signed in. There is no local push helper to unsubscribe: the server
  // deleted the stored subscription with the account, so no push can reach this browser for it again.
  // A 401 signs out here as success does, and the dialog then goes to /login. 'User not found' is
  // the losing side of a race with another browser window or device that deleted the same account
  // first. Any other 401 means the cookie is gone or expired (a logout in another window clears it
  // too), and the account itself is unchanged as far as this window knows. Success and 'User not
  // found' also tell this browser's other windows (announceAccountDeleted).
  deleteAccount: async (password) => {
    isDeletingInThisWindow = true;
    try {
      await axiosInstance.delete('/users/me', { data: { password } });
    } catch (error) {
      if (error.response?.status !== 401) {
        return { success: false, message: describeDeleteAccountError(error) };
      }
      // Signed out already if another window announced its deletion while this one was on its
      // way. That announcement has said so, so nothing is shown twice.
      const wasSignedIn = Boolean(get().authUser);
      set({ authUser: null });
      disconnectSocket();
      if (error.response.data?.message === 'Unauthorized - User not found') {
        announceAccountDeleted();
        if (wasSignedIn) toast.success('This account no longer exists');
      } else if (wasSignedIn) {
        toast.error('Your session has ended. Log in again to delete your account.');
      }
      return { success: true };
    } finally {
      isDeletingInThisWindow = false;
    }
    set({ authUser: null });
    disconnectSocket();
    announceAccountDeleted();
    toast.success('Your account has been deleted');
    return { success: true };
  },
}));

// Another window of this browser deleted the account, so the cookie this window used is gone. Sign
// out as a 401 would: ProtectedRoute then sends this window to /login, which unmounts the page,
// and an open delete-account dialog with it. Nothing to do when already signed out.
authChannel?.addEventListener('message', (event) => {
  if (event.data?.type !== 'account-deleted' || !useAuthStore.getState().authUser || isDeletingInThisWindow) return;
  useAuthStore.setState({ authUser: null });
  disconnectSocket();
  toast.success('This account no longer exists');
});
