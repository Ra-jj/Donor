import React, { useState, useEffect } from 'react';
import { useAuthStore } from '../store/useAuthStore';
import { axiosInstance } from '../lib/axios';
import toast from 'react-hot-toast';
import { UserCircle, ClockClockwise, MapTrifold } from '@phosphor-icons/react';
import StatsCard from '../components/StatsCard';
import StarRating from '../components/StarRating';

const ProfilePage = () => {
  const { authUser, checkAuth } = useAuthStore();
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState(null);
  const [history, setHistory] = useState({ pastRequests: [], pastDonations: [] });

  const [formData, setFormData] = useState({
    name: authUser?.name || '',
    bloodGroup: authUser?.bloodGroup || 'A+',
    isAvailable: authUser?.isAvailable ?? true,
    location: authUser?.location?.coordinates || null,
  });

  const [locating, setLocating] = useState(false);

  useEffect(() => {
    const fetchProfileData = async () => {
      try {
        const [statsRes, historyRes] = await Promise.all([
          axiosInstance.get('/users/stats'),
          axiosInstance.get('/users/history'),
        ]);
        setStats(statsRes.data);
        setHistory(historyRes.data);
      } catch (err) {
        toast.error('Failed to load profile data');
      }
    };
    fetchProfileData();
  }, []);

  const handleUpdate = async (e) => {
    e.preventDefault();
    if (!formData.location) {
      toast.error('Location is required');
      return;
    }
    setLoading(true);
    try {
      await axiosInstance.patch('/users/profile', formData);
      await checkAuth(); // Refresh user in context
      toast.success('Profile updated successfully!');
    } catch (error) {
      toast.error(error.response?.data?.message || 'Update failed');
    } finally {
      setLoading(false);
    }
  };

  const getLocation = () => {
    if (!navigator.geolocation) {
      toast.error('Geolocation is not supported by your browser');
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setFormData({ ...formData, location: [position.coords.longitude, position.coords.latitude] });
        setLocating(false);
        toast.success('Location updated');
      },
      () => {
        setLocating(false);
        toast.error('Unable to retrieve your location');
      }
    );
  };

  return (
    <div className="space-y-8">
      <div className="bg-base-100 rounded-3xl p-6 md:p-8 shadow-sm border border-base-300">
        <h1 className="text-2xl font-display font-bold mb-6 flex items-center gap-2">
          <UserCircle weight="duotone" className="w-8 h-8 text-primary" />
          Edit Profile
        </h1>
        
        <form onSubmit={handleUpdate} className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-2">
            <label className="text-sm font-semibold text-base-content/70">Full Name</label>
            <input 
              type="text" 
              className="input w-full rounded-xl bg-base-200" 
              value={formData.name}
              onChange={e => setFormData({...formData, name: e.target.value})}
              required 
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-semibold text-base-content/70">Blood Group</label>
            <select 
              className="select w-full rounded-xl bg-base-200"
              value={formData.bloodGroup}
              onChange={e => setFormData({...formData, bloodGroup: e.target.value})}
            >
              {['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].map(bg => (
                <option key={bg} value={bg}>{bg}</option>
              ))}
            </select>
          </div>

          <div className="space-y-2 md:col-span-2">
            <label className="text-sm font-semibold text-base-content/70 flex justify-between items-center">
              <span>Location</span>
              {formData.location && <span className="text-success text-xs font-bold">✓ Location Set</span>}
            </label>
            <div className="flex gap-2">
              <div className="flex-1 input bg-base-200 rounded-xl flex items-center opacity-60">
                {formData.location ? `${formData.location[1].toFixed(4)}, ${formData.location[0].toFixed(4)}` : 'Not set'}
              </div>
              <button 
                type="button" 
                onClick={getLocation} 
                disabled={locating}
                className="btn btn-primary btn-outline rounded-xl"
              >
                {locating ? <span className="loading loading-spinner loading-sm"></span> : <MapTrifold weight="bold" className="w-5 h-5" />}
                {formData.location ? 'Update' : 'Get Location'}
              </button>
            </div>
          </div>

          <div className="space-y-2 md:col-span-2">
            <label className="cursor-pointer label bg-base-200 p-4 rounded-xl flex items-start gap-4">
              <input 
                type="checkbox" 
                className="toggle toggle-primary toggle-lg mt-1" 
                checked={formData.isAvailable}
                onChange={e => setFormData({...formData, isAvailable: e.target.checked})}
              />
              <div>
                <span className="label-text font-bold text-base block mb-1">Available to Donate</span>
                <span className="label-text-alt text-base-content/60 leading-relaxed block">
                  Turn this on to receive emergency push notifications and appear in search results when someone nearby needs blood.
                </span>
              </div>
            </label>
          </div>

          <div className="md:col-span-2 flex justify-end mt-4">
            <button type="submit" disabled={loading} className="btn btn-primary rounded-xl px-8 text-white font-bold shadow-lg shadow-primary/20">
              {loading ? <span className="loading loading-spinner"></span> : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>

      {stats && <StatsCard donorStats={stats.donor} requesterStats={stats.requester} />}

      <div className="bg-base-100 rounded-3xl p-6 md:p-8 shadow-sm border border-base-300">
        <h2 className="text-xl font-display font-bold mb-6 flex items-center gap-2">
          <ClockClockwise weight="duotone" className="w-6 h-6 text-primary" />
          Donation History
        </h2>
        
        {history.pastDonations.length === 0 && history.pastRequests.length === 0 ? (
          <div className="text-center p-8 bg-base-200/50 rounded-2xl text-base-content/60">
            You don't have any completed donations or requests yet.
          </div>
        ) : (
          <div className="space-y-6">
            {history.pastDonations.length > 0 && (
              <div>
                <h3 className="font-bold text-sm text-base-content/60 uppercase tracking-wider mb-3">Past Donations</h3>
                <div className="space-y-3">
                  {history.pastDonations.map(req => (
                    <div key={req._id} className="bg-base-200 rounded-2xl p-4 flex flex-col sm:flex-row justify-between sm:items-center gap-4">
                      <div>
                        <div className="font-bold">{req.hospitalName}</div>
                        <div className="text-sm text-base-content/60">For {req.requesterId?.name || 'Unknown'} • {new Date(req.fulfilledAt).toLocaleDateString()}</div>
                      </div>
                      {req.rating ? (
                        <div className="bg-warning/10 px-3 py-2 rounded-xl flex items-center gap-2">
                          <StarRating rating={req.rating} size="w-4 h-4" />
                          <span className="text-sm font-bold text-warning">{req.rating}/5</span>
                        </div>
                      ) : (
                        <div className="text-xs text-base-content/40 bg-base-300 px-3 py-1 rounded-full">Not rated</div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {history.pastRequests.length > 0 && (
              <div>
                <h3 className="font-bold text-sm text-base-content/60 uppercase tracking-wider mb-3 mt-8">Past Requests Made</h3>
                <div className="space-y-3">
                  {history.pastRequests.map(req => (
                    <div key={req._id} className="bg-base-200 rounded-2xl p-4 flex flex-col sm:flex-row justify-between sm:items-center gap-4">
                      <div>
                        <div className="font-bold">{req.unitsNeeded} units of {req.bloodGroup}</div>
                        <div className="text-sm text-base-content/60">{new Date(req.createdAt).toLocaleDateString()}</div>
                      </div>
                      <div className={`badge ${req.status === 'fulfilled' ? 'badge-info text-white' : req.status === 'accepted' ? 'badge-success text-white' : 'badge-ghost'}`}>
                        {req.status}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default ProfilePage;
