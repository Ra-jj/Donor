import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { EnvelopeSimple, Lock, SignIn, Eye, EyeSlash } from '@phosphor-icons/react';
import { useAuthStore } from '../store/useAuthStore';

const LoginPage = () => {
  const { login } = useAuthStore();
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [formData, setFormData] = useState({
    email: '',
    password: '',
  });

  const [emailError, setEmailError] = useState('');

  const handleEmailBlur = () => {
    if (formData.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      setEmailError('Please enter a valid email address');
    } else {
      setEmailError('');
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (formData.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      setEmailError('Please enter a valid email address');
      return;
    }
    setLoading(true);
    await login(formData);
    setLoading(false);
  };

  return (
    <div className="flex justify-center items-center h-[calc(100vh-4rem)] px-4">
      <div className="card w-full max-w-md bg-base-100 shadow-2xl shadow-base-content/5 border border-base-300 rounded-3xl overflow-hidden">
        <div className="card-body p-8 sm:p-10">
          <div className="text-center mb-8">
            <h2 className="text-3xl font-display font-extrabold text-base-content tracking-tight">Welcome Back</h2>
            <p className="text-base-content/70 mt-2 font-medium">Log in to Donor to continue.</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
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
            </div>

            <div className="form-control mt-8">
              <button type="submit" className="btn btn-primary w-full rounded-xl text-white font-bold shadow-lg shadow-primary/20 border-none" disabled={loading}>
                {loading ? <span className="loading loading-spinner"></span> : (
                  <>
                    <SignIn weight="bold" className="w-5 h-5 mr-1" />
                    Log In
                  </>
                )}
              </button>
            </div>
          </form>

          <div className="text-center mt-8">
            <p className="text-base-content/70 font-medium">
              Don't have an account?{' '}
              <Link to="/register" className="text-primary font-bold hover:underline">Sign Up</Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default LoginPage;
