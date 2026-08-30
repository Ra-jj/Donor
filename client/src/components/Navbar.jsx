import React, { useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Drop, SignOut, List, X, Sun, Moon } from '@phosphor-icons/react';
import { useAuthStore } from '../store/useAuthStore';
import { useThemeStore } from '../store/useThemeStore';
import { motion, AnimatePresence } from 'motion/react';

const Navbar = () => {
  const { authUser, logout } = useAuthStore();
  const { theme, toggleTheme } = useThemeStore();
  const [isScrolled, setIsScrolled] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 20);
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Close mobile menu on route change
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [location]);

  return (
    <>
      <nav 
        className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
          isScrolled ? 'bg-base-100/90 backdrop-blur-md shadow-sm py-2' : 'bg-transparent py-4'
        }`}
      >
        <div className="container mx-auto px-4 max-w-6xl flex justify-between items-center">
          <Link to="/" className="flex items-center gap-2 group">
            <Drop weight="duotone" className="w-8 h-8 text-primary group-hover:scale-110 transition-transform" />
            <span className="text-2xl font-display font-extrabold text-base-content tracking-tight">
              Donor
            </span>
          </Link>

          {/* Desktop Nav */}
          <div className="hidden md:flex items-center gap-6">
            {authUser ? (
              <>
                <Link to="/dashboard" className="font-semibold text-base-content/80 hover:text-primary transition-colors">Dashboard</Link>
                <Link to="/create-request" className="font-semibold text-base-content/80 hover:text-primary transition-colors">New Request</Link>
                <div className="dropdown dropdown-end ml-4">
                  <label tabIndex={0} className="btn btn-ghost btn-circle avatar border-2 border-primary/20 hover:border-primary">
                    <div className="w-10 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold font-display text-lg">
                      {authUser?.name?.charAt(0)?.toUpperCase() || 'U'}
                    </div>
                  </label>
                  <ul tabIndex={0} className="mt-3 z-1 p-2 shadow-xl menu menu-sm dropdown-content bg-base-100 rounded-2xl w-56 border border-base-200">
                    <li className="menu-title px-4 py-3 opacity-60 font-body text-xs uppercase tracking-wider">
                      Signed in as<br/><span className="font-bold text-base-content opacity-100 capitalize">{authUser?.name || 'User'}</span>
                    </li>
                    <div className="divider my-0"></div>
                    <li className="p-1">
                      <button onClick={logout} className="text-error hover:bg-error/10 hover:text-error flex gap-3 py-3 rounded-xl font-semibold">
                        <SignOut weight="regular" className="w-5 h-5" />
                        Log out
                      </button>
                    </li>
                  </ul>
                </div>
                <button
                  onClick={toggleTheme}
                  className="btn btn-ghost btn-circle text-base-content/70 hover:text-primary transition-colors"
                  aria-label="Toggle theme"
                >
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.div
                      key={theme}
                      initial={{ y: -16, opacity: 0, rotate: -90 }}
                      animate={{ y: 0, opacity: 1, rotate: 0 }}
                      exit={{ y: 16, opacity: 0, rotate: 90 }}
                      transition={{ duration: 0.2 }}
                    >
                      {theme === 'light' ? (
                        <Moon weight="duotone" className="w-5 h-5" />
                      ) : (
                        <Sun weight="duotone" className="w-5 h-5" />
                      )}
                    </motion.div>
                  </AnimatePresence>
                </button>
              </>
            ) : (
              <div className="flex items-center gap-3">
                <button
                  onClick={toggleTheme}
                  className="btn btn-ghost btn-circle text-base-content/70 hover:text-primary transition-colors"
                  aria-label="Toggle theme"
                >
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.div
                      key={theme}
                      initial={{ y: -16, opacity: 0, rotate: -90 }}
                      animate={{ y: 0, opacity: 1, rotate: 0 }}
                      exit={{ y: 16, opacity: 0, rotate: 90 }}
                      transition={{ duration: 0.2 }}
                    >
                      {theme === 'light' ? (
                        <Moon weight="duotone" className="w-5 h-5" />
                      ) : (
                        <Sun weight="duotone" className="w-5 h-5" />
                      )}
                    </motion.div>
                  </AnimatePresence>
                </button>
                <Link to="/login" className="btn btn-ghost rounded-full px-6 font-semibold active:scale-95 transition-transform min-h-[44px]">Log in</Link>
                <Link to="/register" className="btn btn-primary rounded-full px-6 text-white font-bold border-none shadow-md shadow-primary/20 active:scale-95 transition-transform min-h-[44px]">Sign up</Link>
              </div>
            )}
          </div>

          {/* Mobile Hamburger */}
          <button 
            className="md:hidden btn btn-ghost btn-circle active:scale-95 transition-transform min-h-[44px] min-w-[44px]"
            onClick={() => setMobileMenuOpen(true)}
          >
            <List weight="regular" className="w-7 h-7" />
          </button>
        </div>
      </nav>

      {/* Mobile Drawer */}
      <AnimatePresence>
        {mobileMenuOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-base-content/20 backdrop-blur-sm z-50 md:hidden"
              onClick={() => setMobileMenuOpen(false)}
            />
            <motion.div
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              className="fixed top-0 right-0 bottom-0 w-4/5 max-w-sm bg-base-100 shadow-2xl z-50 p-6 flex flex-col md:hidden"
            >
              <div className="flex justify-between items-center mb-8">
                <div className="flex items-center gap-2">
                  <Drop weight="duotone" className="w-7 h-7 text-primary" />
                  <span className="text-xl font-display font-extrabold text-base-content">Donor</span>
                </div>
                <button onClick={() => setMobileMenuOpen(false)} className="btn btn-ghost btn-circle btn-sm active:scale-95 transition-transform min-h-[44px] min-w-[44px]">
                  <X weight="regular" className="w-6 h-6" />
                </button>
              </div>

              <div className="flex flex-col gap-4 flex-1">
                {authUser ? (
                  <>
                    <div className="bg-base-200/50 p-4 rounded-2xl mb-4 flex items-center gap-4">
                      <div className="w-12 h-12 rounded-full bg-primary/20 text-primary flex items-center justify-center font-bold font-display text-xl">
                        {authUser?.name?.charAt(0)?.toUpperCase() || 'U'}
                      </div>
                      <div>
                        <div className="font-bold">{authUser?.name || 'User'}</div>
                        <div className="text-xs text-base-content/60">{authUser?.email}</div>
                      </div>
                    </div>
                    <Link to="/dashboard" className="btn btn-ghost justify-start font-semibold text-lg">Dashboard</Link>
                    <Link to="/create-request" className="btn btn-ghost justify-start font-semibold text-lg">New Request</Link>
                    <button
                      onClick={toggleTheme}
                      className="btn btn-ghost justify-start font-semibold text-lg gap-3 active:scale-95 transition-transform min-h-[44px]"
                    >
                      {theme === 'light' ? (
                        <><Moon weight="duotone" className="w-5 h-5" /> Dark Mode</>
                      ) : (
                        <><Sun weight="duotone" className="w-5 h-5" /> Light Mode</>
                      )}
                    </button>
                    <div className="divider my-2"></div>
                    <button onClick={logout} className="btn btn-error btn-outline mt-auto w-full font-bold gap-2 rounded-xl active:scale-95 transition-transform min-h-[44px]">
                      <SignOut weight="regular" className="w-5 h-5" />
                      Log out
                    </button>
                  </>
                ) : (
                  <>
                    <Link to="/login" className="btn btn-ghost btn-lg justify-start font-semibold active:scale-95 transition-transform min-h-[44px]">Log in</Link>
                    <Link to="/register" className="btn btn-primary btn-lg text-white font-bold rounded-xl mt-2 shadow-primary/20 shadow-lg active:scale-95 transition-transform min-h-[44px]">Create Account</Link>
                  </>
                )}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
};

export default Navbar;
