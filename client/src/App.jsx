import { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './store/useAuthStore';
import { Toaster } from 'react-hot-toast';

import Navbar from './components/Navbar';
import ProtectedRoute from './components/ProtectedRoute';

// Pages
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import DashboardPage from './pages/DashboardPage';
import CreateRequestPage from './pages/CreateRequestPage';

function App() {
  const { authUser, checkAuth, isCheckingAuth } = useAuthStore();

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  if (isCheckingAuth) {
    return (
      <div className="flex items-center justify-center h-screen bg-base-100">
        <span className="loading loading-spinner loading-lg text-primary"></span>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-base-200 text-base-content font-sans">
      <Navbar />
      
      <div className="container mx-auto px-4 py-8 max-w-5xl">
        <Routes>
          <Route path="/" element={authUser ? <Navigate to="/dashboard" /> : <Navigate to="/login" />} />
          
          <Route path="/register" element={!authUser ? <RegisterPage /> : <Navigate to="/dashboard" />} />
          <Route path="/login" element={!authUser ? <LoginPage /> : <Navigate to="/dashboard" />} />
          
          <Route path="/dashboard" element={<ProtectedRoute><DashboardPage /></ProtectedRoute>} />
          <Route path="/create-request" element={<ProtectedRoute><CreateRequestPage /></ProtectedRoute>} />
        </Routes>
      </div>

      <Toaster position="top-center" />
    </div>
  );
}

export default App;
