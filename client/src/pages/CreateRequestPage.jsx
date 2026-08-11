import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MapPin, Building2, Droplet, Activity } from 'lucide-react';
import { axiosInstance } from '../lib/axios';
import toast from 'react-hot-toast';

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const URGENCY_LEVELS = [
  { value: 'low', label: 'Low (Within 48 hours)' },
  { value: 'medium', label: 'Medium (Within 24 hours)' },
  { value: 'high', label: 'High (Immediate/Emergency)' }
];

const CreateRequestPage = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    bloodGroup: '',
    unitsNeeded: 1,
    hospitalName: '',
    hospitalLocation: null,
    urgency: 'medium'
  });

  const handleGetLocation = () => {
    if (!navigator.geolocation) {
      toast.error('Geolocation is not supported by your browser');
      return;
    }
    
    toast.loading('Fetching hospital location...', { id: 'geo' });
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setFormData({
          ...formData,
          hospitalLocation: [position.coords.longitude, position.coords.latitude],
        });
        toast.success('Location captured successfully!', { id: 'geo' });
      },
      (error) => {
        console.error(error);
        toast.error('Failed to get location. Please allow location access.', { id: 'geo' });
      }
    );
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!formData.hospitalLocation) {
      toast.error('Please provide the hospital location to match with nearby donors.');
      return;
    }

    setLoading(true);
    toast.loading('Notifying nearby donors in real-time...', { id: 'createReq' });

    try {
      await axiosInstance.post('/requests', formData);
      toast.success('Emergency request broadcasted successfully!', { id: 'createReq' });
      navigate('/dashboard');
    } catch (error) {
      toast.error(error.response?.data?.message || 'Failed to create request', { id: 'createReq' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex justify-center items-center py-8">
      <div className="card w-full max-w-lg bg-base-100 shadow-xl border border-base-300">
        <div className="card-body">
          <div className="text-center mb-6">
            <div className="w-16 h-16 bg-error/10 text-error rounded-full flex items-center justify-center mx-auto mb-4">
              <Activity className="w-8 h-8" />
            </div>
            <h2 className="text-3xl font-bold text-primary">Request Blood</h2>
            <p className="text-base-content/70 mt-2">Create an emergency broadcast. We will notify compatible donors within a 15km radius immediately.</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            
            <div className="grid grid-cols-2 gap-4">
              <div className="form-control">
                <label className="label"><span className="label-text font-medium">Blood Group Required</span></label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <Droplet className="h-5 w-5 text-error/60" />
                  </div>
                  <select 
                    className="select select-bordered w-full pl-10"
                    required
                    value={formData.bloodGroup}
                    onChange={(e) => setFormData({ ...formData, bloodGroup: e.target.value })}
                  >
                    <option value="" disabled>Select</option>
                    {BLOOD_GROUPS.map((bg) => (
                      <option key={bg} value={bg}>{bg}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="form-control">
                <label className="label"><span className="label-text font-medium">Units Needed</span></label>
                <input 
                  type="number" 
                  min="1"
                  max="10"
                  className="input input-bordered w-full" 
                  required
                  value={formData.unitsNeeded}
                  onChange={(e) => setFormData({ ...formData, unitsNeeded: parseInt(e.target.value) })}
                />
              </div>
            </div>

            <div className="form-control">
              <label className="label"><span className="label-text font-medium">Hospital Name</span></label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Building2 className="h-5 w-5 text-base-content/40" />
                </div>
                <input 
                  type="text" 
                  className="input input-bordered w-full pl-10" 
                  placeholder="e.g. Apollo Gleneagles"
                  required
                  value={formData.hospitalName}
                  onChange={(e) => setFormData({ ...formData, hospitalName: e.target.value })}
                />
              </div>
            </div>

            <div className="form-control">
              <label className="label"><span className="label-text font-medium">Urgency Level</span></label>
              <select 
                className="select select-bordered w-full"
                required
                value={formData.urgency}
                onChange={(e) => setFormData({ ...formData, urgency: e.target.value })}
              >
                {URGENCY_LEVELS.map((level) => (
                  <option key={level.value} value={level.value}>{level.label}</option>
                ))}
              </select>
            </div>

            <div className="form-control mt-2 p-4 bg-base-200 rounded-lg border border-base-300">
              <label className="label pt-0"><span className="label-text font-bold">Hospital Location</span></label>
              <p className="text-xs text-base-content/60 mb-3">We need precise GPS coordinates to match you with the closest available donors.</p>
              
              <button 
                type="button" 
                className={`btn w-full ${formData.hospitalLocation ? 'btn-success text-white' : 'btn-outline'}`}
                onClick={handleGetLocation}
              >
                <MapPin className="w-5 h-5 mr-2" />
                {formData.hospitalLocation ? 'Location Captured ✓' : 'Fetch GPS Coordinates'}
              </button>
              {formData.hospitalLocation && (
                <span className="text-xs text-success mt-2 text-center block">
                  [{formData.hospitalLocation[0].toFixed(4)}, {formData.hospitalLocation[1].toFixed(4)}]
                </span>
              )}
            </div>

            <div className="form-control mt-6">
              <button type="submit" className="btn btn-primary w-full" disabled={loading}>
                {loading ? <span className="loading loading-spinner"></span> : 'Broadcast Emergency'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};

export default CreateRequestPage;
