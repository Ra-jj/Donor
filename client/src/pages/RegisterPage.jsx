import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { MapPin, User, EnvelopeSimple, Lock, Drop, Eye, EyeSlash } from '@phosphor-icons/react';
import { useAuthStore } from '../store/useAuthStore';
import toast from 'react-hot-toast';

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

const RegisterPage = () => {
  const { register } = useAuthStore();
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    password: '',
    bloodGroup: '',
    location: null, // [lng, lat]
  });

  const [emailError, setEmailError] = useState('');

  const handleEmailBlur = () => {
    if (formData.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      setEmailError('Please enter a valid email address');
    } else {
      setEmailError('');
    }
  };

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
    if (formData.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      setEmailError('Please enter a valid email address');
      return;
    }
    if (!formData.location) {
      toast.error('Please provide your location to help match you with nearby emergencies.');
      return;
    }
    setLoading(true);
    await register(formData);
    setLoading(false);
  };

  return (
    <div className="flex justify-center items-center py-12 px-4">
      <div className="card w-full max-w-md bg-base-100 shadow-2xl shadow-base-content/5 border border-base-300 rounded-3xl overflow-hidden">
        <div className="card-body p-8 sm:p-10">
          <div className="text-center mb-8">
            <h2 className="text-3xl font-display font-extrabold text-base-content tracking-tight">Create Account</h2>
            <p className="text-base-content/70 mt-2 font-medium">Join Donor and save lives today.</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="form-control">
              <label className="label"><span className="label-text font-semibold text-base-content/80">Full Name</span></label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <User weight="regular" className="h-5 w-5 text-base-content/40" />
                </div>
                <input 
                  type="text" 
                  className="input w-full pl-12 rounded-xl border border-base-300 bg-base-100 shadow-sm focus:border-primary focus:ring-1 focus:ring-primary transition-all" 
                  placeholder="John Doe"
                  required
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                />
              </div>
            </div>

            <div className="form-control">
              <label className="label"><span className="label-text font-semibold text-base-content/80">Email</span></label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <EnvelopeSimple weight="regular" className="h-5 w-5 text-base-content/40" />
                </div>
                <input 
                  type="email" 
                  className={`input w-full pl-12 rounded-xl border ${emailError ? 'border-error focus:border-error focus:ring-error' : 'border-base-300 focus:border-primary focus:ring-primary'} bg-base-100 shadow-sm focus:ring-1 transition-all`}
                  placeholder="you@example.com"
                  required
                  value={formData.email}
                  onChange={(e) => {
                    setFormData({ ...formData, email: e.target.value });
                    if (emailError) setEmailError('');
                  }}
                  onBlur={handleEmailBlur}
                />
              </div>
              {emailError && <span className="text-error text-sm mt-1.5 ml-1 font-medium">{emailError}</span>}
            </div>

            <div className="form-control">
              <label className="label"><span className="label-text font-semibold text-base-content/80">Password</span></label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <Lock weight="regular" className="h-5 w-5 text-base-content/40" />
                </div>
                <input 
                  type={showPassword ? "text" : "password"}
                  className="input w-full pl-12 pr-12 rounded-xl border border-base-300 bg-base-100 shadow-sm focus:border-primary focus:ring-1 focus:ring-primary transition-all" 
                  placeholder="••••••••"
                  required
                  minLength={6}
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                />
                <button 
                  type="button"
                  className="absolute inset-y-0 right-0 pr-4 flex items-center text-base-content/40 hover:text-primary transition-colors focus:outline-none"
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? <EyeSlash weight="regular" className="h-5 w-5" /> : <Eye weight="regular" className="h-5 w-5" />}
                </button>
              </div>
              <span className="text-base-content/60 text-sm mt-1.5 ml-1">At least 6 characters</span>
            </div>

            <div className="form-control">
              <label className="label"><span className="label-text font-semibold text-base-content/80">Blood Group</span></label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <Drop weight="regular" className="h-5 w-5 text-primary/70" />
                </div>
                <select 
                  className="select w-full pl-12 rounded-xl border border-base-300 bg-base-100 shadow-sm focus:border-primary focus:ring-1 focus:ring-primary transition-all font-medium"
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
              <label className="label"><span className="label-text font-semibold text-base-content/80">Location</span></label>
              <button 
                type="button" 
                className={`btn w-full rounded-xl font-bold border-2 transition-all ${formData.location ? 'btn-success text-white border-success' : 'btn-outline border-base-300 hover:border-primary hover:bg-primary/5 hover:text-primary'}`}
                onClick={handleGetLocation}
              >
                <MapPin weight={formData.location ? "fill" : "regular"} className="w-5 h-5 mr-2" />
                {formData.location ? 'Location Captured ✓' : 'Click to Get Current Location'}
              </button>
              {formData.location && (
                <span className="text-xs font-semibold text-success mt-3 text-center">
                  Coordinates: {formData.location[0].toFixed(4)}, {formData.location[1].toFixed(4)}
                </span>
              )}
            </div>

            <div className="form-control mt-8">
              <button type="submit" className="btn btn-primary w-full rounded-xl text-white font-bold shadow-lg shadow-primary/20 border-none" disabled={loading}>
                {loading ? <span className="loading loading-spinner"></span> : 'Sign Up'}
              </button>
            </div>
          </form>

          <div className="text-center mt-8">
            <p className="text-base-content/70 font-medium">
              Already have an account?{' '}
              <Link to="/login" className="text-primary font-bold hover:underline">Log in</Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default RegisterPage;
