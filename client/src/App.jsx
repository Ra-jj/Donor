import { useEffect } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from './store/useAuthStore';
import { useThemeStore } from './store/useThemeStore';
import { Toaster } from 'react-hot-toast';
import { AnimatePresence, motion } from 'motion/react';

import Navbar from './components/Navbar';
import ProtectedRoute from './components/ProtectedRoute';

// Pages
import HomePage from './pages/HomePage';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import DashboardPage from './pages/DashboardPage';
import CreateRequestPage from './pages/CreateRequestPage';

// Animated page wrapper for smooth route transitions
const PageTransition = ({ children, className = '' }) => (
  <motion.div
    initial={{ opacity: 0, y: 12 }}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, y: -8 }}
    transition={{ duration: 0.35, ease: [0.25, 0.1, 0.25, 1] }}
    className={className}
  >
    {children}
  </motion.div>
);

function App() {
  const { authUser, checkAuth, isCheckingAuth } = useAuthStore();
  const { initTheme } = useThemeStore();
  const location = useLocation();

  useEffect(() => {
    initTheme();
  }, [initTheme]);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  if (isCheckingAuth) {
    return (
      <div className="flex items-center justify-center h-screen bg-base-100">
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.4 }}
        >
          <span className="loading loading-spinner loading-lg text-primary"></span>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-base-200 text-base-content font-sans">
      <Navbar />
      
      <main className="flex-1 w-full pt-20">
        <AnimatePresence mode="wait">
          <Routes location={location} key={location.pathname}>
            <Route path="/" element={
              authUser ? <Navigate to="/dashboard" /> : (
                <PageTransition>
                  <HomePage />
                </PageTransition>
              )
            } />
            
            <Route path="/register" element={
              !authUser ? (
                <PageTransition className="container mx-auto px-4 py-8 max-w-5xl">
                  <RegisterPage />
                </PageTransition>
              ) : <Navigate to="/dashboard" />
            } />
            <Route path="/login" element={
              !authUser ? (
                <PageTransition className="container mx-auto px-4 py-8 max-w-5xl">
                  <LoginPage />
                </PageTransition>
              ) : <Navigate to="/dashboard" />
            } />
            
            <Route path="/dashboard" element={
              <ProtectedRoute>
                <PageTransition className="container mx-auto px-4 py-8 max-w-5xl">
                  <DashboardPage />
                </PageTransition>
              </ProtectedRoute>
            } />
            <Route path="/create-request" element={
              <ProtectedRoute>
                <PageTransition className="container mx-auto px-4 py-8 max-w-5xl">
                  <CreateRequestPage />
                </PageTransition>
              </ProtectedRoute>
            } />
          </Routes>
        </AnimatePresence>
      </main>

      <Toaster position="top-center" />
    </div>
  );
}

export default App;
