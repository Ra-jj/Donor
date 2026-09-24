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
      console.error('Error in checkAuth:', error);
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
