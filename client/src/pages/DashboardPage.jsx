import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuthStore } from '../store/useAuthStore';
import { axiosInstance } from '../lib/axios';
import { getSocket } from '../lib/socket';
import toast from 'react-hot-toast';
import { motion, AnimatePresence } from 'motion/react';
import ChatWindow from '../components/ChatWindow';
import { Plus, BellRinging, ClockClockwise, Checks, XCircle, HandHeart, ChatCircleDots } from '@phosphor-icons/react';

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

  const fetchDashboardData = async () => {
    try {
      setLoading(true);
      const [mineRes, incomingRes] = await Promise.all([
        axiosInstance.get('/requests/mine'),
        axiosInstance.get('/requests/incoming')
      ]);
      setMyRequests(mineRes.data.requests);
      setIncomingRequests(incomingRes.data.incomingRequests);
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
      }
      
      // Update my requests list to reflect the new status
      setMyRequests((prev) => prev.map(req => 
        req._id === data.requestId ? { ...req, status: data.status, matchedDonorId: 'temp_id' } : req
      ));
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
    <div className="space-y-8 pt-6">
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
        
        <div className="flex items-center gap-4 z-10 relative w-full sm:w-auto">
          <Link to="/create-request" className="btn btn-primary rounded-xl text-white font-bold shadow-lg shadow-primary/20 border-none w-full sm:w-auto">
            <Plus weight="bold" className="w-5 h-5 mr-1" />
            Request Blood
          </Link>
        </div>
      </motion.div>

      {/* Tabs with animated indicator */}
      <div className="flex justify-center sm:justify-start">
        <div className="bg-base-100 border border-base-300 p-1.5 rounded-2xl inline-flex shadow-sm w-full sm:w-auto relative">
          <button 
            className={`flex-1 sm:flex-none flex items-center justify-center gap-2 px-6 py-2.5 rounded-xl font-bold transition-all relative z-10 ${activeTab === 'incoming' ? 'text-white' : 'text-base-content/60 hover:text-base-content'}`}
            onClick={() => { setActiveTab('incoming'); setSelectedRequestId(null); }}
          >
            <BellRinging weight={activeTab === 'incoming' ? "fill" : "regular"} className="w-5 h-5" />
            Incoming Matches
            {incomingRequests.filter(r => r.status === 'pending').length > 0 && (
              <span className={`px-2 py-0.5 rounded-full text-xs font-bold ml-1 ${activeTab === 'incoming' ? 'bg-white text-primary' : 'bg-error text-white'}`}>
                {incomingRequests.filter(r => r.status === 'pending').length}
              </span>
            )}
          </button>
          <button 
            className={`flex-1 sm:flex-none flex items-center justify-center gap-2 px-6 py-2.5 rounded-xl font-bold transition-all relative z-10 ${activeTab === 'mine' ? 'text-white' : 'text-base-content/60 hover:text-base-content'}`}
            onClick={() => { setActiveTab('mine'); setSelectedRequestId(null); }}
          >
            <ClockClockwise weight={activeTab === 'mine' ? "fill" : "regular"} className="w-5 h-5" />
            My Requests
          </button>
          {/* Animated tab indicator */}
          <motion.div
            layout
            className="absolute top-1.5 bottom-1.5 rounded-xl bg-primary shadow-md"
            style={{ width: 'calc(50% - 3px)' }}
            animate={{ 
              left: activeTab === 'incoming' ? '6px' : 'calc(50% - 0px)'
            }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
          />
        </div>
      </div>

      {/* Tab Content */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* List Section */}
        <div className="space-y-4">
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
                  <div className="text-center p-8 bg-base-100 rounded-xl border border-base-300 text-base-content/60">
                    No incoming requests right now. You're a hero in waiting!
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
                        <div className="card-body p-5">
                          <div className="flex justify-between items-start">
                            <h3 className="card-title text-lg">{req.hospitalName}</h3>
                            <UrgencyBadge urgency={req.urgency} />
                          </div>
                          <p className="text-sm text-base-content/70">
                            Needs: <strong>{req.unitsNeeded} units</strong> of {req.bloodGroup}
                          </p>
                          
                          <div className="card-actions justify-end mt-4">
                            {req.status === 'pending' ? (
                              <>
                                <span className="text-xs text-base-content/30 font-medium self-center mr-2 hidden sm:inline">
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
                            <div className={`badge ${req.status === 'pending' ? 'badge-warning' : req.status === 'accepted' ? 'badge-success text-white' : ''}`}>
                              {req.status.toUpperCase()}
                            </div>
                          </div>
                          <p className="text-sm text-base-content/70 mt-2">
                            {req.unitsNeeded} units • {req.bloodGroup}
                          </p>
                          {req.status === 'accepted' && (
                            <div className="alert alert-success bg-success/10 text-success border-success/20 p-2 mt-2 flex justify-center">
                              A donor has accepted this request! Open chat to coordinate.
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
        <div className="w-full lg:sticky lg:top-8 h-fit mt-8 lg:mt-0">
          {(() => {
            // Find the specifically selected request
            let activeChatRequest = null;
            
            if (selectedRequestId) {
              const currentList = activeTab === 'incoming' ? incomingRequests : myRequests;
              activeChatRequest = currentList.find(r => r._id === selectedRequestId);
            }

            if (activeChatRequest) {
              return (
                <motion.div 
                  initial={{ opacity: 0, scale: 0.98 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.3 }}
                  className="w-full"
                >
                  <div className="mb-2 text-sm font-semibold opacity-70">
                    Coordinating for: {activeChatRequest.hospitalName}
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
