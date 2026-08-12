import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MapPin, BuildingOffice, Drop, Heartbeat } from '@phosphor-icons/react';
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
    <div className="flex justify-center items-center py-12 px-4">
      <div className="card w-full max-w-xl bg-base-100 shadow-2xl shadow-base-content/5 border border-base-300 rounded-3xl overflow-hidden">
        <div className="card-body p-8 sm:p-10">
          <div className="text-center mb-8">
            <div className="w-20 h-20 bg-primary/10 text-primary rounded-3xl flex items-center justify-center mx-auto mb-6 shadow-sm border border-primary/20">
              <Heartbeat weight="duotone" className="w-10 h-10" />
            </div>
            <h2 className="text-3xl font-display font-extrabold text-base-content tracking-tight">Request Blood</h2>
            <p className="text-base-content/70 mt-3 font-medium leading-relaxed">Create an emergency broadcast. We will notify compatible donors within a 15km radius immediately.</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            
            <div className="grid grid-cols-2 gap-4">
              <div className="form-control">
                <label className="label"><span className="label-text font-semibold text-base-content/80">Blood Group</span></label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                    <Drop weight="regular" className="h-5 w-5 text-primary/70" />
                  </div>
                  <select 
                    className="select select-bordered w-full pl-12 rounded-xl focus:border-primary focus:ring-1 focus:ring-primary transition-all font-medium"
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
                <label className="label"><span className="label-text font-semibold text-base-content/80">Units Needed</span></label>
                <input 
                  type="number" 
                  min="1" 
                  max="20"
                  className="input input-bordered w-full rounded-xl focus:border-primary focus:ring-1 focus:ring-primary transition-all font-medium" 
                  required
                  value={formData.unitsNeeded}
                  onChange={(e) => setFormData({ ...formData, unitsNeeded: e.target.value })}
                />
              </div>
            </div>

            <div className="form-control">
              <label className="label"><span className="label-text font-semibold text-base-content/80">Urgency Level</span></label>
              <select 
                className={`select select-bordered w-full rounded-xl focus:border-primary focus:ring-1 focus:ring-primary transition-all font-medium ${
                  formData.urgency === 'high' ? 'bg-error/10 border-error text-error font-bold' :
                  formData.urgency === 'medium' ? 'bg-warning/10 border-warning text-warning-content font-bold' :
                  ''
                }`}
                value={formData.urgency}
                onChange={(e) => setFormData({ ...formData, urgency: e.target.value })}
              >
                {URGENCY_LEVELS.map((level) => (
                  <option key={level.value} value={level.value} className="text-base-content font-medium">
                    {level.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="form-control">
              <label className="label"><span className="label-text font-semibold text-base-content/80">Hospital / Blood Bank Name</span></label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <BuildingOffice weight="regular" className="h-5 w-5 text-base-content/40" />
                </div>
                <input 
                  type="text" 
                  className="input input-bordered w-full pl-12 rounded-xl focus:border-primary focus:ring-1 focus:ring-primary transition-all" 
                  placeholder="e.g. City General Hospital"
                  required
                  value={formData.hospitalName}
                  onChange={(e) => setFormData({ ...formData, hospitalName: e.target.value })}
                />
              </div>
            </div>

            <div className="form-control mt-2">
              <label className="label"><span className="label-text font-semibold text-base-content/80">Hospital Location</span></label>
              <button 
                type="button" 
                className={`btn w-full rounded-xl font-bold border-2 transition-all ${formData.hospitalLocation ? 'btn-success text-white border-success' : 'btn-outline border-base-300 hover:border-primary hover:bg-primary/5 hover:text-primary'}`}
                onClick={handleGetLocation}
              >
                <MapPin weight={formData.hospitalLocation ? "fill" : "regular"} className="w-5 h-5 mr-2" />
                {formData.hospitalLocation ? 'Location Captured ✓' : 'Click to Get Current Location'}
              </button>
              {formData.hospitalLocation && (
                <span className="text-xs font-semibold text-success mt-3 text-center block">
                  Coordinates: {formData.hospitalLocation[0].toFixed(4)}, {formData.hospitalLocation[1].toFixed(4)}
                </span>
              )}
            </div>

            <div className="form-control mt-8">
              <button type="submit" className="btn btn-primary w-full rounded-xl text-white font-bold shadow-lg shadow-primary/20 border-none h-14 text-lg" disabled={loading}>
                {loading ? <span className="loading loading-spinner"></span> : 'Broadcast Emergency Request'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};

export default CreateRequestPage;
