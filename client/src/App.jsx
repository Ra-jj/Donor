import { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './store/useAuthStore';
import { Toaster } from 'react-hot-toast';

import Navbar from './components/Navbar';
import ProtectedRoute from './components/ProtectedRoute';

// Pages
import HomePage from './pages/HomePage';
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
      
      <main className="flex-1 w-full">
        <Routes>
          <Route path="/" element={authUser ? <Navigate to="/dashboard" /> : <HomePage />} />
          
          <Route path="/register" element={!authUser ? <div className="container mx-auto px-4 py-8 max-w-5xl"><RegisterPage /></div> : <Navigate to="/dashboard" />} />
          <Route path="/login" element={!authUser ? <div className="container mx-auto px-4 py-8 max-w-5xl"><LoginPage /></div> : <Navigate to="/dashboard" />} />
          
          <Route path="/dashboard" element={<ProtectedRoute><div className="container mx-auto px-4 py-8 max-w-5xl"><DashboardPage /></div></ProtectedRoute>} />
          <Route path="/create-request" element={<ProtectedRoute><div className="container mx-auto px-4 py-8 max-w-5xl"><CreateRequestPage /></div></ProtectedRoute>} />
        </Routes>
      </main>

      <Toaster position="top-center" />
    </div>
  );
}

export default App;
