import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { WifiSlash, WarningCircle } from '@phosphor-icons/react';

const OfflineOverlay = () => {
  const [isOffline, setIsOffline] = useState(!navigator.onLine);

  useEffect(() => {
    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return (
    <AnimatePresence>
      {isOffline && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-base-100/95 backdrop-blur-md p-6 text-center"
        >
          {/* A fully blocking overlay to prevent interaction with stale UI */}
          <div className="absolute inset-0 z-0 pointer-events-auto" /> 
          
          <div className="relative z-10 max-w-md w-full bg-base-200 border border-base-300 rounded-3xl p-8 shadow-2xl flex flex-col items-center">
            <div className="w-20 h-20 bg-error/10 text-error rounded-full flex items-center justify-center mb-6 animate-pulse">
              <WifiSlash weight="duotone" className="w-10 h-10" />
            </div>
            
            <h2 className="text-2xl font-display font-bold text-base-content mb-3">
              You're Offline
            </h2>
            
            <p className="text-base-content/70 mb-6">
              Donor requires an active internet connection to coordinate real-time blood emergencies and chat with matches.
            </p>
            
            <div className="bg-warning/10 border border-warning/20 p-4 rounded-xl flex items-start gap-3 text-left w-full">
              <WarningCircle weight="fill" className="w-6 h-6 text-warning shrink-0 mt-0.5" />
              <p className="text-sm text-warning-content/80">
                Please reconnect to the internet to resume using the app. This page will automatically disappear once your connection is restored.
              </p>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default OfflineOverlay;
