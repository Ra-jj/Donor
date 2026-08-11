import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { MapPin, User, Mail, Lock, Droplet } from 'lucide-react';
import { useAuthStore } from '../store/useAuthStore';
import toast from 'react-hot-toast';

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

const RegisterPage = () => {
  const { register } = useAuthStore();
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    password: '',
    bloodGroup: '',
    location: null, // [lng, lat]
  });

  const handleGetLocation = () => {
    if (!navigator.geolocation) {
      toast.error('Geolocation is not supported by your browser');
      return;
    }
    
    toast.loading('Fetching location...', { id: 'geo' });
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setFormData({
          ...formData,
          location: [position.coords.longitude, position.coords.latitude],
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
    if (!formData.location) {
      toast.error('Please provide your location to help match you with nearby emergencies.');
      return;
    }
    setLoading(true);
    await register(formData);
    setLoading(false);
  };

  return (
    <div className="flex justify-center items-center py-8">
      <div className="card w-full max-w-md bg-base-100 shadow-xl border border-base-300">
        <div className="card-body">
          <div className="text-center mb-6">
            <h2 className="text-3xl font-bold text-primary">Create Account</h2>
            <p className="text-base-content/70 mt-2">Join Donor and save lives today.</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="form-control">
              <label className="label"><span className="label-text font-medium">Full Name</span></label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <User className="h-5 w-5 text-base-content/40" />
                </div>
                <input 
                  type="text" 
                  className="input input-bordered w-full pl-10" 
                  placeholder="John Doe"
                  required
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                />
              </div>
            </div>

            <div className="form-control">
              <label className="label"><span className="label-text font-medium">Email</span></label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Mail className="h-5 w-5 text-base-content/40" />
                </div>
                <input 
                  type="email" 
                  className="input input-bordered w-full pl-10" 
                  placeholder="you@example.com"
                  required
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                />
              </div>
            </div>

            <div className="form-control">
              <label className="label"><span className="label-text font-medium">Password</span></label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Lock className="h-5 w-5 text-base-content/40" />
                </div>
                <input 
                  type="password" 
                  className="input input-bordered w-full pl-10" 
                  placeholder="••••••••"
                  required
                  minLength={6}
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                />
              </div>
            </div>

            <div className="form-control">
              <label className="label"><span className="label-text font-medium">Blood Group</span></label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Droplet className="h-5 w-5 text-red-500/60" />
                </div>
                <select 
                  className="select select-bordered w-full pl-10"
                  required
                  value={formData.bloodGroup}
                  onChange={(e) => setFormData({ ...formData, bloodGroup: e.target.value })}
                >
                  <option value="" disabled>Select your blood group</option>
                  {BLOOD_GROUPS.map((bg) => (
                    <option key={bg} value={bg}>{bg}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="form-control mt-2">
              <label className="label"><span className="label-text font-medium">Location</span></label>
              <button 
                type="button" 
                className={`btn w-full ${formData.location ? 'btn-success text-white' : 'btn-outline'}`}
                onClick={handleGetLocation}
              >
                <MapPin className="w-5 h-5 mr-2" />
                {formData.location ? 'Location Captured ✓' : 'Click to Get Current Location'}
              </button>
              {formData.location && (
                <span className="text-xs text-success mt-2 text-center">
                  Coordinates: {formData.location[0].toFixed(4)}, {formData.location[1].toFixed(4)}
                </span>
              )}
            </div>

            <div className="form-control mt-6">
              <button type="submit" className="btn btn-primary w-full" disabled={loading}>
                {loading ? <span className="loading loading-spinner"></span> : 'Sign Up'}
              </button>
            </div>
          </form>

          <div className="text-center mt-4 text-sm">
            <span className="text-base-content/60">Already have an account? </span>
            <Link to="/login" className="text-primary font-semibold hover:underline">Log in</Link>
          </div>
        </div>
      </div>
    </div>
  );
};

export default RegisterPage;
