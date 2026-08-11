import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuthStore } from '../store/useAuthStore';
import { axiosInstance } from '../lib/axios';
import { getSocket } from '../lib/socket';
import toast from 'react-hot-toast';
import ChatWindow from '../components/ChatWindow';

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
          <strong>Emergency Request!</strong>
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
      low: 'badge-success',
      medium: 'badge-warning',
      high: 'badge-error text-white font-bold'
    };
    return <div className={`badge ${colors[urgency] || 'badge-ghost'}`}>{urgency.toUpperCase()}</div>;
  };

  if (loading) {
    return (
      <div className="flex justify-center p-12">
        <span className="loading loading-spinner loading-lg text-primary"></span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header Profile Section */}
      <div className="bg-base-100 rounded-xl p-6 shadow-sm border border-base-300 flex flex-col sm:flex-row justify-between items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-primary">Welcome, {authUser?.name || 'User'}</h1>
          <p className="text-base-content/70">Blood Group: <strong className="text-red-500">{authUser?.bloodGroup || 'Not set'}</strong></p>
        </div>
        
        <div className="flex items-center gap-4">
          <Link to="/create-request" className="btn btn-primary">
            + Request Blood
          </Link>
        </div>
      </div>

        {/* Tabs */}
        <div className="tabs tabs-boxed bg-base-100 border border-base-300 p-1 rounded-xl inline-flex mb-6">
          <button 
            className={`tab px-6 ${activeTab === 'incoming' ? 'tab-active bg-primary text-primary-content' : ''}`}
            onClick={() => { setActiveTab('incoming'); setSelectedRequestId(null); }}
          >
            Incoming Matches
            {incomingRequests.filter(r => r.status === 'pending').length > 0 && (
              <span className="badge badge-error badge-sm text-white ml-2">{incomingRequests.filter(r => r.status === 'pending').length}</span>
            )}
          </button>
          <button 
            className={`tab px-6 ${activeTab === 'mine' ? 'tab-active bg-primary text-primary-content' : ''}`}
            onClick={() => { setActiveTab('mine'); setSelectedRequestId(null); }}
          >
            My Requests
          </button>
        </div>

      {/* Tab Content */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* List Section */}
        <div className="space-y-4">
          {activeTab === 'incoming' && (
            <>
              <h2 className="text-xl font-bold mb-4">Requests Needing Your Help</h2>
              {incomingRequests.length === 0 ? (
                <div className="text-center p-8 bg-base-100 rounded-xl border border-base-300 text-base-content/60">
                  No incoming requests right now. You're a hero in waiting!
                </div>
              ) : (
                incomingRequests.map(req => (
                  <div 
                    key={req._id} 
                    onClick={() => req.status === 'accepted' && setSelectedRequestId(req._id)}
                    className={`card bg-base-100 shadow-md border overflow-hidden transition-all ${req.status === 'accepted' ? 'cursor-pointer hover:border-primary' : 'border-base-200'} ${selectedRequestId === req._id ? 'border-primary ring-2 ring-primary ring-opacity-50' : ''}`}
                  >
                    {req.status === 'pending' && <div className="h-1 w-full bg-error"></div>}
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
                            <button onClick={() => handleUpdateStatus(req._id, 'declined')} className="btn btn-sm btn-ghost text-error">Decline</button>
                            <button onClick={() => handleUpdateStatus(req._id, 'accepted')} className="btn btn-sm btn-success text-white">Accept & Help</button>
                          </>
                        ) : req.status === 'accepted' ? (
                          <div className="badge badge-success text-white p-3 font-semibold">Accepted by you</div>
                        ) : (
                          <div className="badge">{req.status}</div>
                        )}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </>
          )}

          {activeTab === 'mine' && (
            <>
              <h2 className="text-xl font-bold mb-4">My Emergency Requests</h2>
              {myRequests.length === 0 ? (
                <div className="text-center p-8 bg-base-100 rounded-xl border border-base-300 text-base-content/60">
                  You haven't made any blood requests.
                </div>
              ) : (
                myRequests.map(req => (
                  <div 
                    key={req._id} 
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
                  </div>
                ))
              )}
            </>
          )}
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
                <div className="w-full">
                  <div className="mb-2 text-sm font-semibold opacity-70">
                    Coordinating for: {activeChatRequest.hospitalName}
                  </div>
                  <ChatWindow requestId={activeChatRequest._id} currentUserId={authUser._id} />
                </div>
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
