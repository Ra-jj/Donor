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
      set({ authUser: res.data.user });
      initSocket(res.data.user._id);
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
      set({ authUser: res.data.user });
      initSocket(res.data.user._id);
      toast.success('Account created successfully');
    } catch (error) {
      toast.error(error.response?.data?.message || 'Registration failed');
    }
  },

  login: async (data) => {
    try {
      const res = await axiosInstance.post('/auth/login', data);
      set({ authUser: res.data.user });
      initSocket(res.data.user._id);
      toast.success('Logged in successfully');
    } catch (error) {
      toast.error(error.response?.data?.message || 'Login failed');
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

  updateAvailability: async (isAvailable) => {
    // We don't have a specific update profile endpoint in our minimal backend,
    // but typically we'd hit one here. For now, we will assume this might be handled 
    // in a future step, or we can just update local state if needed.
    // If the backend had /auth/profile/update, we would call it.
    // To stay strictly within the MVP spec, we won't mock a non-existent API.
    set((state) => ({
      authUser: { ...state.authUser, isAvailable }
    }));
  }
}));
