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
      set({ authUser: res.data.user });
      initSocket(res.data.user._id);
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
