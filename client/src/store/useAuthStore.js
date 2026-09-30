import { create } from 'zustand';
import { axiosInstance } from '../lib/axios';
import { initSocket, disconnectSocket } from '../lib/socket';
import toast from 'react-hot-toast';

export const useAuthStore = create((set) => ({
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
}));
