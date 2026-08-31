import React, { useState, useEffect, lazy, Suspense } from 'react';
import { Link } from 'react-router-dom';
import { useAuthStore } from '../store/useAuthStore';
import { axiosInstance } from '../lib/axios';
import { getSocket } from '../lib/socket';
import toast from 'react-hot-toast';
import { motion, AnimatePresence } from 'motion/react';
import ChatWindow from '../components/ChatWindow';
import StatsCard from '../components/StatsCard';
import StarRating from '../components/StarRating';
import { Plus, BellRinging, ClockClockwise, Checks, XCircle, HandHeart, Star, CheckCircle } from '@phosphor-icons/react';

const DonorMap = lazy(() => import('../components/DonorMap'));

/** Swipeable request card for mobile — drag right to accept, left to decline */
const SwipeableRequestCard = ({ req, onAccept, onDecline, onSelect, isSelected, children }) => {
  const [dragX, setDragX] = useState(0);

  if (req.status !== 'pending') {
    // Non-pending cards are not swipeable
    return (
      <motion.div
        layout
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95 }}
        transition={{ duration: 0.3, layout: { duration: 0.25 } }}
        onClick={() => req.status === 'accepted' && onSelect(req._id)}
        className={`card bg-base-100 shadow-md border overflow-hidden transition-colors ${
          req.status === 'accepted' ? 'cursor-pointer hover:border-primary' : 'border-base-200'
        } ${isSelected ? 'border-primary ring-2 ring-primary ring-opacity-50' : ''}`}
      >
        {children}
      </motion.div>
    );
  }

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: dragX > 0 ? 200 : -200, scale: 0.9 }}
      transition={{ duration: 0.3, layout: { duration: 0.25 } }}
      className="relative"
    >
      {/* Swipe indicators behind the card */}
      <div className="absolute inset-0 rounded-2xl flex items-center justify-between px-6 pointer-events-none">
        <div className={`flex items-center gap-2 text-error font-bold transition-opacity ${dragX < -30 ? 'opacity-100' : 'opacity-0'}`}>
          <XCircle weight="fill" className="w-6 h-6" /> Decline
        </div>
        <div className={`flex items-center gap-2 text-success font-bold transition-opacity ${dragX > 30 ? 'opacity-100' : 'opacity-0'}`}>
          Accept <Checks weight="fill" className="w-6 h-6" />
        </div>
      </div>

      <motion.div
        drag="x"
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={0.3}
        onDrag={(_, info) => setDragX(info.offset.x)}
        onDragEnd={(_, info) => {
          setDragX(0);
          if (info.offset.x > 100) {
            onAccept(req._id);
          } else if (info.offset.x < -100) {
            onDecline(req._id);
          }
        }}
        style={{ 
          x: 0,
          backgroundColor: dragX > 30 ? 'rgba(22, 163, 74, 0.05)' : dragX < -30 ? 'rgba(220, 38, 38, 0.05)' : 'transparent'
        }}
        className="card bg-base-100 shadow-md border border-base-200 overflow-hidden cursor-grab active:cursor-grabbing rounded-2xl touch-pan-y"
      >
        <div className="h-1 w-full bg-error" />
        {children}
      </motion.div>
    </motion.div>
  );
};

const DashboardPage = () => {
  const { authUser } = useAuthStore();
  const [activeTab, setActiveTab] = useState('incoming');
  const [myRequests, setMyRequests] = useState([]);
  const [incomingRequests, setIncomingRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedRequestId, setSelectedRequestId] = useState(null);
  const [pushEnabled, setPushEnabled] = useState(!!authUser?.pushSubscription);
  const [stats, setStats] = useState(null);

  // Rating state — tracks which request is being rated
  const [ratingRequestId, setRatingRequestId] = useState(null);
  const [ratingValue, setRatingValue] = useState(0);
  const [ratingNote, setRatingNote] = useState('');
  const [ratingLoading, setRatingLoading] = useState(false);

  const enablePushNotifications = async () => {
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        toast.error('Notifications permission denied');
        return;
      }
      
      const registration = await navigator.serviceWorker.ready;
      
      const urlBase64ToUint8Array = (base64String) => {
        const padding = '='.repeat((4 - base64String.length % 4) % 4);
        const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
        const rawData = window.atob(base64);
        const outputArray = new Uint8Array(rawData.length);
        for (let i = 0; i < rawData.length; ++i) {
          outputArray[i] = rawData.charCodeAt(i);
        }
        return outputArray;
      };

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(import.meta.env.VITE_VAPID_PUBLIC_KEY)
      });

      await axiosInstance.post('/push/subscribe', subscription);
      setPushEnabled(true);
      toast.success('Push notifications enabled!');
    } catch (error) {
      console.error('Error enabling push:', error);
      toast.error('Failed to enable push notifications');
    }
  };

  const fetchDashboardData = async () => {
    try {
      setLoading(true);
      const [mineRes, incomingRes, statsRes] = await Promise.all([
        axiosInstance.get('/requests/mine'),
        axiosInstance.get('/requests/incoming'),
        axiosInstance.get('/users/stats'),
      ]);
      setMyRequests(mineRes.data.requests);
      setIncomingRequests(incomingRes.data.incomingRequests);
      setStats(statsRes.data);
    } catch (error) {
      console.error('Error fetching dashboard data:', error);
      toast.error('Failed to load dashboard');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDashboardData();
  }, []);

  // Listen for real-time new incoming requests
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const handleNewRequest = (newRequestData) => {
      toast.success(
        <div>
          <strong className="font-display text-lg tracking-tight">Emergency Request!</strong>
          <br/>
          {newRequestData.unitsNeeded} units of {newRequestData.bloodGroup} needed at {newRequestData.hospitalName}.
        </div>, 
        { duration: 6000, icon: '🚨' }
      );
      setIncomingRequests((prev) => [newRequestData, ...prev]);
    };

    socket.on('newBloodRequest', handleNewRequest);

    return () => {
      socket.off('newBloodRequest', handleNewRequest);
    };
  }, []);

  // Listen for real-time status updates on MY requests (e.g. someone accepted it)
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const handleStatusUpdate = (data) => {
      if (data.status === 'accepted') {
        toast.success(`${data.donorName} accepted your request!`, { icon: '✅', duration: 5000 });
      } else if (data.status === 'fulfilled') {
        toast.success('Request has been marked as fulfilled! Thank you for donating. 🩸', { duration: 5000 });
      } else if (data.status === 'rated') {
        toast.success(`You received a ${data.rating}★ rating! ${data.ratingNote ? '"' + data.ratingNote + '"' : ''}`, { icon: '⭐', duration: 5000 });
      }
      
      // Update my requests list to reflect the new status
      setMyRequests((prev) => prev.map(req => 
        req._id === data.requestId ? { ...req, status: data.status, matchedDonorId: 'temp_id' } : req
      ));

      // Update incoming requests for the donor side
      setIncomingRequests((prev) => prev.map(req => 
        req._id === data.requestId ? { ...req, status: data.status === 'rated' ? 'fulfilled' : data.status, rating: data.rating || req.rating, ratingNote: data.ratingNote || req.ratingNote } : req
      ));

      // Refresh stats after a status change
      axiosInstance.get('/users/stats').then(res => setStats(res.data)).catch(() => {});
    };

    socket.on('requestStatusUpdate', handleStatusUpdate);

    return () => {
      socket.off('requestStatusUpdate', handleStatusUpdate);
    };
  }, []);

  const handleUpdateStatus = async (requestId, newStatus) => {
    try {
      await axiosInstance.patch(`/requests/${requestId}/status`, { status: newStatus });
      toast.success(`Request ${newStatus}`);
      fetchDashboardData(); // Refresh to get updated state
    } catch (err) {
      console.error(err);
      toast.error('Failed to update request status');
    }
  };

  const handleFulfill = async (requestId) => {
    try {
      await axiosInstance.patch(`/requests/${requestId}/fulfill`);
      toast.success('Request marked as fulfilled! 🎉');
      fetchDashboardData();
    } catch (err) {
      console.error(err);
      toast.error(err.response?.data?.message || 'Failed to mark as fulfilled');
    }
  };

  const handleRate = async (requestId) => {
    if (ratingValue === 0) {
      toast.error('Please select a rating');
      return;
    }
    try {
      setRatingLoading(true);
      await axiosInstance.post(`/requests/${requestId}/rate`, {
        rating: ratingValue,
        ratingNote: ratingNote,
      });
      toast.success('Rating submitted! Thank you. ⭐');
      setRatingRequestId(null);
      setRatingValue(0);
      setRatingNote('');
      fetchDashboardData();
    } catch (err) {
      console.error(err);
      toast.error(err.response?.data?.message || 'Failed to submit rating');
    } finally {
      setRatingLoading(false);
    }
  };

  const UrgencyBadge = ({ urgency }) => {
    const colors = {
      low: 'bg-success/10 text-success border-success/20',
      medium: 'bg-warning/10 text-warning-content border-warning/20',
      high: 'bg-error/10 text-error border-error/20 font-bold'
    };
    return <div className={`badge border px-3 py-1 text-xs uppercase tracking-wider ${colors[urgency] || 'badge-ghost'}`}>{urgency}</div>;
  };

  if (loading) {
    return (
      <div className="flex justify-center p-12 mt-12">
        <span className="loading loading-spinner loading-lg text-primary"></span>
      </div>
    );
  }

  return (
    <div className="space-y-8 pt-20">
      {/* Header Profile Section */}
      <motion.div 
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="bg-base-100 rounded-3xl p-8 shadow-sm border border-base-300 flex flex-col sm:flex-row justify-between items-center gap-6 overflow-hidden relative"
      >
        <div className="absolute top-0 right-0 w-64 h-64 bg-primary/5 rounded-full blur-3xl -translate-y-1/2 translate-x-1/3"></div>
        <div className="z-10 relative min-w-0 flex-1 w-full text-center sm:text-left">
          <h1 className="text-3xl font-display font-extrabold text-base-content tracking-tight mb-1 truncate" title={`Welcome, ${authUser?.name || 'User'}`}>
            Welcome, {authUser?.name || 'User'}
          </h1>
          <p className="text-base-content/70 font-medium text-lg">Your Blood Group: <strong className="text-primary bg-primary/10 px-3 py-1 rounded-full ml-1">{authUser?.bloodGroup || 'Not set'}</strong></p>
        </div>
        
        <div className="hidden lg:flex items-center gap-4 z-10 relative w-full sm:w-auto">
          <Link to="/create-request" className="btn btn-primary rounded-xl text-white font-bold shadow-lg shadow-primary/20 border-none w-full sm:w-auto active:scale-95 transition-transform">
            <Plus weight="bold" className="w-5 h-5 mr-1" />
            Request Blood
          </Link>
        </div>
      </motion.div>

      {/* Your Impact Stats Card */}
      {stats && (stats.donor.livesSaved > 0 || stats.requester.totalCreated > 0) && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.1 }}
        >
          <StatsCard donorStats={stats.donor} requesterStats={stats.requester} />
        </motion.div>
      )}

      {/* Mobile FAB */}
      <div className="lg:hidden fixed bottom-6 right-6 z-40">
        <Link to="/create-request" className="btn btn-primary btn-circle w-14 h-14 shadow-lg shadow-primary/30 glow-primary text-white flex items-center justify-center active:scale-90 transition-transform">
          <Plus weight="bold" className="w-7 h-7" />
        </Link>
      </div>

      {/* Push Notification Banner */}
      {'Notification' in window && !pushEnabled && (
        <motion.div 
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-info/10 border border-info/20 rounded-2xl p-4 flex flex-col sm:flex-row items-center justify-between gap-4"
        >
          <div className="flex items-center gap-3">
            <div className="bg-info/20 p-2 rounded-full">
              <BellRinging className="w-6 h-6 text-info" weight="duotone" />
            </div>
            <div>
              <h3 className="font-bold text-base-content text-sm sm:text-base">Enable Push Notifications</h3>
              <p className="text-xs sm:text-sm text-base-content/70">Get instantly alerted on your phone when an emergency matches your blood group.</p>
            </div>
          </div>
          <button onClick={enablePushNotifications} className="btn btn-info btn-sm rounded-lg text-white font-semibold">Enable Now</button>
        </motion.div>
      )}

      {/* Tabs with animated indicator */}
      <div className={`flex justify-center sm:justify-start ${selectedRequestId ? 'hidden lg:flex' : 'flex'}`}>
        <div className="bg-base-100 border border-base-300 p-1.5 rounded-2xl inline-flex shadow-sm w-full sm:w-auto relative">
          <button 
            className={`flex-1 sm:flex-none flex items-center justify-center gap-2 px-6 py-2.5 rounded-xl font-bold transition-all relative z-10 ${activeTab === 'incoming' ? 'text-white' : 'text-base-content/60 hover:text-base-content'}`}
            onClick={() => { setActiveTab('incoming'); setSelectedRequestId(null); }}
          >
            {activeTab === 'incoming' && (
              <motion.div layoutId="active-tab-indicator" className="absolute inset-0 bg-primary rounded-xl shadow-md -z-10" transition={{ type: 'spring', stiffness: 300, damping: 30 }} />
            )}
            {incomingRequests.filter(r => r.status === 'pending').length > 0 && (
              <span className={`px-2 py-0.5 rounded-full text-xs font-bold mr-1 ${activeTab === 'incoming' ? 'bg-white text-primary' : 'bg-error text-white'}`}>
                {incomingRequests.filter(r => r.status === 'pending').length}
              </span>
            )}
            <BellRinging weight={activeTab === 'incoming' ? "fill" : "regular"} className="w-5 h-5" />
            <span className="relative z-10">Incoming Matches</span>
          </button>
          <button 
            className={`flex-1 sm:flex-none flex items-center justify-center gap-2 px-6 py-2.5 rounded-xl font-bold transition-all relative z-10 ${activeTab === 'mine' ? 'text-white' : 'text-base-content/60 hover:text-base-content'}`}
            onClick={() => { setActiveTab('mine'); setSelectedRequestId(null); }}
          >
            {activeTab === 'mine' && (
              <motion.div layoutId="active-tab-indicator" className="absolute inset-0 bg-primary rounded-xl shadow-md -z-10" transition={{ type: 'spring', stiffness: 300, damping: 30 }} />
            )}
            <ClockClockwise weight={activeTab === 'mine' ? "fill" : "regular"} className="w-5 h-5" />
            <span className="relative z-10">My Requests</span>
          </button>
        </div>
      </div>

      {/* Tab Content */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 relative">
        {/* List Section */}
        <div className={`space-y-4 ${selectedRequestId ? 'hidden lg:block' : 'block'}`}>
          <AnimatePresence mode="wait">
            {activeTab === 'incoming' && (
              <motion.div
                key="incoming"
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 8 }}
                transition={{ duration: 0.25 }}
                className="space-y-4"
              >
                <h2 className="text-xl font-bold mb-4">Requests Needing Your Help</h2>
                {incomingRequests.length === 0 ? (
                  <div className="text-center p-12 bg-base-100 rounded-2xl border border-base-300 text-base-content/60 shadow-sm">
                    <HandHeart weight="duotone" className="w-16 h-16 mx-auto mb-4 text-primary/40" />
                    <h3 className="font-bold text-lg mb-1 text-base-content">You're all caught up!</h3>
                    <p>There are no emergency requests near you right now.</p>
                  </div>
                ) : (
                  <AnimatePresence>
                    {incomingRequests.map(req => (
                      <SwipeableRequestCard
                        key={req._id}
                        req={req}
                        onAccept={(id) => handleUpdateStatus(id, 'accepted')}
                        onDecline={(id) => handleUpdateStatus(id, 'declined')}
                        onSelect={setSelectedRequestId}
                        isSelected={selectedRequestId === req._id}
                      >
                        {/* Fulfilled Thank You state for donor */}
                        {req.status === 'fulfilled' ? (
                          <div className="card-body p-5">
                            <div className="bg-success/5 border border-success/10 rounded-2xl p-5 text-center space-y-3">
                              <CheckCircle weight="fill" className="w-12 h-12 text-success mx-auto" />
                              <h3 className="font-display font-bold text-lg text-success">Donation Complete!</h3>
                              <p className="text-sm text-base-content/70">
                                Thank you for donating at <strong>{req.hospitalName}</strong>.
                              </p>
                              {req.rating ? (
                                <div className="space-y-1">
                                  <StarRating rating={req.rating} size="w-5 h-5" className="justify-center" />
                                  <p className="text-xs text-base-content/50">
                                    Rated {req.rating}/5 by the requester
                                  </p>
                                  {req.ratingNote && (
                                    <p className="text-sm italic text-base-content/60 mt-2">"{req.ratingNote}"</p>
                                  )}
                                </div>
                              ) : (
                                <p className="text-xs text-base-content/40">Awaiting rating from requester</p>
                              )}
                            </div>
                          </div>
                        ) : (
                          <>
                            {req.hospitalLocation?.coordinates && (
                              <div className="w-full relative bg-base-200 border-b border-base-200 overflow-hidden">
                                <Suspense fallback={<div className="h-[150px] flex items-center justify-center"><span className="loading loading-spinner text-primary"></span></div>}>
                                  <DonorMap 
                                    hospitalLocation={req.hospitalLocation.coordinates} 
                                    interactive={false}
                                    userLocation={authUser?.location?.coordinates}
                                    height="h-[150px]"
                                  />
                                </Suspense>
                              </div>
                            )}
                            <div className="card-body p-5">
                              <div className="flex justify-between items-start gap-3">
                                <h3 className="card-title text-lg flex-1 leading-snug">{req.hospitalName}</h3>
                                <div className="flex items-center gap-2 shrink-0">
                                  {req.matchType === 'exact' ? (
                                    <span className="badge badge-success badge-sm h-auto py-1 px-2 whitespace-nowrap font-bold text-white shadow-sm shadow-success/20">Exact Match</span>
                                  ) : req.matchType === 'compatible' ? (
                                    <span className="badge badge-info badge-sm h-auto py-1 px-2 whitespace-nowrap font-bold text-white shadow-sm shadow-info/20">Compatible Match</span>
                                  ) : null}
                                  <UrgencyBadge urgency={req.urgency} />
                                </div>
                              </div>
                              <p className="text-sm text-base-content/70">
                                Needs: <strong>{req.unitsNeeded} units</strong> of {req.bloodGroup}
                              </p>
                              
                              <div className="card-actions justify-end mt-4">
                                {req.status === 'pending' ? (
                                  <>
                                    <span className="text-xs text-base-content/30 font-medium self-center mr-2 md:hidden">
                                      Swipe or tap →
                                    </span>
                                    <button onClick={(e) => { e.stopPropagation(); handleUpdateStatus(req._id, 'declined'); }} className="btn btn-sm btn-ghost text-error">Decline</button>
                                    <button onClick={(e) => { e.stopPropagation(); handleUpdateStatus(req._id, 'accepted'); }} className="btn btn-sm btn-success text-white">Accept & Help</button>
                                  </>
                                ) : req.status === 'accepted' ? (
                                  <div className="badge badge-success text-white p-3 font-semibold">Accepted by you</div>
                                ) : (
                                  <div className="badge">{req.status}</div>
                                )}
                              </div>
                            </div>
                          </>
                        )}
                      </SwipeableRequestCard>
                    ))}
                  </AnimatePresence>
                )}
              </motion.div>
            )}

            {activeTab === 'mine' && (
              <motion.div
                key="mine"
                initial={{ opacity: 0, x: 8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -8 }}
                transition={{ duration: 0.25 }}
                className="space-y-4"
              >
                <h2 className="text-xl font-bold mb-4">My Emergency Requests</h2>
                {myRequests.length === 0 ? (
                  <div className="text-center p-8 bg-base-100 rounded-xl border border-base-300 text-base-content/60">
                    You haven't made any blood requests.
                  </div>
                ) : (
                  <AnimatePresence>
                    {myRequests.map(req => (
                      <motion.div 
                        key={req._id}
                        layout
                        initial={{ opacity: 0, y: 12 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95 }}
                        transition={{ duration: 0.3, layout: { duration: 0.25 } }}
                        onClick={() => req.status === 'accepted' && setSelectedRequestId(req._id)}
                        className={`card bg-base-100 shadow-md border transition-all ${req.status === 'accepted' ? 'cursor-pointer hover:border-primary' : 'border-base-200'} ${selectedRequestId === req._id ? 'border-primary ring-2 ring-primary ring-opacity-50' : ''}`}
                      >
                        <div className="card-body p-5">
                          <div className="flex justify-between items-start">
                            <h3 className="card-title text-lg">{req.hospitalName}</h3>
                            <div className={`badge ${
                              req.status === 'pending' ? 'badge-warning' : 
                              req.status === 'accepted' ? 'badge-success text-white' : 
                              req.status === 'fulfilled' ? 'badge-info text-white' : ''
                            }`}>
                              {req.status.toUpperCase()}
                            </div>
                          </div>
                          <p className="text-sm text-base-content/70 mt-2">
                            {req.unitsNeeded} units • {req.bloodGroup}
                          </p>

                          {/* Accepted state: show chat prompt + fulfill button */}
                          {req.status === 'accepted' && (
                            <div className="space-y-3 mt-2">
                              <div className="alert alert-success bg-success/10 text-success border-success/20 p-2 flex justify-center text-center">
                                A donor has accepted this request! Open chat to coordinate.
                              </div>
                              <button
                                onClick={(e) => { e.stopPropagation(); handleFulfill(req._id); }}
                                className="btn btn-sm btn-primary w-full rounded-xl font-bold shadow-sm"
                              >
                                <CheckCircle weight="bold" className="w-4 h-4" />
                                Mark as Fulfilled
                              </button>
                            </div>
                          )}

                          {/* Fulfilled state: show rating widget or rating result */}
                          {req.status === 'fulfilled' && (
                            <div className="mt-3 space-y-3">
                              <div className="flex items-center gap-2 text-sm text-info font-semibold">
                                <CheckCircle weight="fill" className="w-4 h-4" />
                                Fulfilled {req.fulfilledAt && `on ${new Date(req.fulfilledAt).toLocaleDateString()}`}
                              </div>

                              {req.rating ? (
                                /* Already rated — show static result */
                                <div className="bg-warning/5 border border-warning/10 rounded-xl p-3 flex flex-col sm:flex-row sm:items-center gap-3">
                                  <div className="flex items-center gap-2">
                                    <StarRating rating={req.rating} size="w-4 h-4" />
                                    <span className="text-sm font-semibold text-base-content/70">{req.rating}/5</span>
                                  </div>
                                  {req.ratingNote && (
                                    <span className="text-xs italic text-base-content/50 sm:ml-auto truncate max-w-full sm:max-w-[150px]" title={req.ratingNote}>"{req.ratingNote}"</span>
                                  )}
                                </div>
                              ) : ratingRequestId === req._id ? (
                                /* Rating form is open */
                                <motion.div
                                  initial={{ opacity: 0, height: 0 }}
                                  animate={{ opacity: 1, height: 'auto' }}
                                  className="bg-base-200/50 border border-base-300 rounded-xl p-4 space-y-3 text-center"
                                >
                                  <p className="text-sm font-semibold text-base-content">Rate your experience</p>
                                  <StarRating rating={ratingValue} onRate={setRatingValue} interactive size="w-8 h-8" className="justify-center" />
                                  <input
                                    type="text"
                                    placeholder="Optional: leave a note for the donor..."
                                    className="input input-sm w-full rounded-lg border-base-300 text-base"
                                    value={ratingNote}
                                    onChange={(e) => setRatingNote(e.target.value)}
                                    maxLength={500}
                                  />
                                  <div className="flex gap-2">
                                    <button
                                      onClick={() => { setRatingRequestId(null); setRatingValue(0); setRatingNote(''); }}
                                      className="btn btn-sm btn-ghost flex-1"
                                    >
                                      Cancel
                                    </button>
                                    <button
                                      onClick={() => handleRate(req._id)}
                                      disabled={ratingValue === 0 || ratingLoading}
                                      className="btn btn-sm btn-warning text-white flex-1 font-bold"
                                    >
                                      {ratingLoading ? <span className="loading loading-spinner loading-xs"></span> : 'Submit Rating'}
                                    </button>
                                  </div>
                                </motion.div>
                              ) : (
                                /* Not yet rated — show rate button */
                                <button
                                  onClick={(e) => { e.stopPropagation(); setRatingRequestId(req._id); }}
                                  className="btn btn-sm btn-outline btn-warning w-full rounded-xl font-bold"
                                >
                                  <Star weight="bold" className="w-4 h-4" />
                                  Rate this Donor
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Chat Section */}
        <div className={`w-full lg:sticky lg:top-24 h-fit mt-8 lg:mt-0 ${!selectedRequestId ? 'hidden lg:block' : 'block'}`}>
          {(() => {
            // Find the specifically selected request
            let activeChatRequest = null;
            
            if (selectedRequestId) {
              const currentList = activeTab === 'incoming' ? incomingRequests : myRequests;
              activeChatRequest = currentList.find(r => r._id === selectedRequestId);
            }

            if (activeChatRequest && activeChatRequest.status === 'accepted') {
              return (
                <motion.div 
                  initial={{ opacity: 0, scale: 0.98 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.3 }}
                  className="w-full flex flex-col"
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-sm font-semibold opacity-70">
                      Coordinating for: {activeChatRequest.hospitalName}
                    </div>
                    <button 
                      onClick={() => setSelectedRequestId(null)}
                      className="lg:hidden text-primary font-bold text-sm bg-primary/10 px-3 py-1 rounded-full active:scale-95 transition-transform"
                    >
                      ← Back to Requests
                    </button>
                  </div>
                  <ChatWindow requestId={activeChatRequest._id} currentUserId={authUser._id} />
                </motion.div>
              );
            }
            return (
              <div className="h-125 bg-base-100 rounded-xl border border-base-300 flex items-center justify-center text-base-content/50 text-center p-8">
                <div>
                  <div className="text-4xl mb-4">💬</div>
                  <h3 className="font-bold text-lg mb-2">Coordination Chat</h3>
                  <p>When a request is accepted, real-time chat will appear here.</p>
                </div>
              </div>
            );
          })()}
        </div>
      </div>
    </div>
  );
};

export default DashboardPage;
