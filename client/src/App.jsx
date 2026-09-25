import { useEffect, useState, Suspense } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from './store/useAuthStore';
import { useThemeStore } from './store/useThemeStore';
import { Toaster } from 'react-hot-toast';
import { AnimatePresence, motion } from 'motion/react';

import Navbar from './components/Navbar';
import ProtectedRoute from './components/ProtectedRoute';
import OfflineOverlay from './components/OfflineOverlay';
import RouteErrorBoundary from './components/RouteErrorBoundary';
import { lazyPage } from './lib/lazyPage';

// Pages, each in its own chunk so a first visit downloads only the page it opens
const HomePage = lazyPage(() => import('./pages/HomePage'));
const LoginPage = lazyPage(() => import('./pages/LoginPage'));
const RegisterPage = lazyPage(() => import('./pages/RegisterPage'));
const DashboardPage = lazyPage(() => import('./pages/DashboardPage'));
const CreateRequestPage = lazyPage(() => import('./pages/CreateRequestPage'));
const ProfilePage = lazyPage(() => import('./pages/ProfilePage'));

// Must match the <Route> paths below
const PAGE_BY_PATH = {
  '/': HomePage,
  '/login': LoginPage,
  '/register': RegisterPage,
  '/dashboard': DashboardPage,
  '/create-request': CreateRequestPage,
  '/profile': ProfilePage,
};

// Pages likely to be opened next, prefetched once the current page is in. Matters most for
// login/register → dashboard and logout → login: those redirects have no exit animation to hide
// a fetch behind. Other navigations get a head start from the preload on URL change in App.
const LIKELY_NEXT_PAGES = {
  '/': [LoginPage, RegisterPage],
  '/login': [DashboardPage],
  '/register': [DashboardPage],
  '/dashboard': [LoginPage],
  '/create-request': [DashboardPage, LoginPage],
  '/profile': [DashboardPage, LoginPage],
};

// The page the routes below really show for a URL once auth is known. Must match their
// redirects: '/', '/login' and '/register' send a logged-in user to /dashboard, and
// ProtectedRoute sends a logged-out user to /login.
const PUBLIC_ONLY_PATHS = ['/', '/login', '/register'];
const PROTECTED_PATHS = ['/dashboard', '/create-request', '/profile'];
const pageShownFor = (pathname, authUser) => {
  if (authUser && PUBLIC_ONLY_PATHS.includes(pathname)) return DashboardPage;
  if (!authUser && PROTECTED_PATHS.includes(pathname)) return LoginPage;
  return PAGE_BY_PATH[pathname];
};

// Resolves once the page's chunk is in or has failed. A failure is not lost: lazyPage keeps it,
// and the page throws it to RouteErrorBoundary (which reloads once for a new build) when shown.
const preloadPage = (page) =>
  page.preload().catch((error) => console.warn('Could not preload page chunk:', error));

// requestIdleCallback is missing in Safari, so fall back to a short timeout there
const runWhenIdle = (callback) => {
  if ('requestIdleCallback' in window) {
    const handle = window.requestIdleCallback(callback, { timeout: 3000 });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = setTimeout(callback, 1000);
  return () => clearTimeout(handle);
};

// Shown only while a page's chunk is still downloading. The spinner fades in late, so a quick
// load shows a moment of empty page area rather than a flashing spinner.
const PageLoadingFallback = () => (
  <div className="flex items-center justify-center min-h-[50vh]">
    <motion.span
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay: 0.3, duration: 0.3 }}
      className="loading loading-spinner loading-lg text-primary"
    />
  </div>
);

// Animated page wrapper for smooth route transitions. Suspense sits outside the motion.div, so
// while a page's chunk loads only the fallback shows, and the enter animation then plays on the
// real page instead of on a spinner.
const PageTransition = ({ children, className = '' }) => (
  <RouteErrorBoundary>
    <Suspense fallback={<PageLoadingFallback />}>
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        transition={{ duration: 0.35, ease: [0.25, 0.1, 0.25, 1] }}
        className={className}
      >
        {children}
      </motion.div>
    </Suspense>
  </RouteErrorBoundary>
);

function App() {
  const { authUser, checkAuth, isCheckingAuth } = useAuthStore();
  const { initTheme } = useThemeStore();
  const location = useLocation();
  // The spinner also waits for the chunk of the first page shown (after any auth redirect), so
  // Navbar and page still appear together. Otherwise a Suspense fallback would flash in between,
  // and React keeps a fallback up for at least 300 ms once it has shown one.
  const [isFirstPageSettled, setIsFirstPageSettled] = useState(false);

  useEffect(() => {
    initTheme();
  }, [initTheme]);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  // Start fetching the page for a new URL right away: on first load it downloads alongside the
  // auth check, and on navigation during the old page's exit animation (AnimatePresence
  // mode="wait" only renders the new page once that animation ends)
  useEffect(() => {
    const page = PAGE_BY_PATH[location.pathname];
    if (page) preloadPage(page);
  }, [location.pathname]);

  // First load: once auth is known, wait for the page that will really show. A redirect (e.g. a
  // logged-in user opening /, the installed app's start page) needs a different chunk than the URL.
  useEffect(() => {
    if (isCheckingAuth || isFirstPageSettled) return;
    const page = pageShownFor(location.pathname, authUser);
    let isCancelled = false;
    // An unknown path shows no page, so there is nothing to wait for
    const pageSettled = page ? preloadPage(page) : Promise.resolve();
    pageSettled.then(() => {
      if (!isCancelled) setIsFirstPageSettled(true);
    });
    return () => {
      isCancelled = true;
    };
  }, [isCheckingAuth, isFirstPageSettled, authUser, location.pathname]);

  // Prefetch only once the first page is shown, after the current page's own chunk and then an
  // idle moment, so it never takes bandwidth from what is on screen (while a chunk downloads the
  // browser is idle too)
  useEffect(() => {
    const likelyNextPages = LIKELY_NEXT_PAGES[location.pathname];
    if (!isFirstPageSettled || !likelyNextPages) return;
    let isCancelled = false;
    let cancelIdlePrefetch = null;
    // A failed chunk is already logged by the preload effect above, so only success matters here
    PAGE_BY_PATH[location.pathname].preload().then(() => {
      if (!isCancelled) cancelIdlePrefetch = runWhenIdle(() => likelyNextPages.forEach(preloadPage));
    }, () => {});
    return () => {
      isCancelled = true;
      cancelIdlePrefetch?.();
    };
  }, [isFirstPageSettled, location.pathname]);

  if (isCheckingAuth || !isFirstPageSettled) {
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
      <OfflineOverlay />
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
            <Route path="/profile" element={
              <ProtectedRoute>
                <PageTransition className="container mx-auto px-4 py-8 max-w-5xl">
                  <ProfilePage />
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
