import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { EnvelopeSimple, Lock, SignIn } from '@phosphor-icons/react';
import { useAuthStore } from '../store/useAuthStore';

const LoginPage = () => {
  const { login } = useAuthStore();
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    email: '',
    password: '',
  });

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    await login(formData);
    setLoading(false);
  };

  return (
    <div className="flex justify-center items-center py-12 px-4">
      <div className="card w-full max-w-md bg-base-100 shadow-2xl shadow-base-content/5 border border-base-300 rounded-3xl overflow-hidden">
        <div className="card-body p-8 sm:p-10">
          <div className="text-center mb-8">
            <h2 className="text-3xl font-display font-extrabold text-base-content tracking-tight">Welcome Back</h2>
            <p className="text-base-content/70 mt-2 font-medium">Log in to Donor to continue.</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="form-control">
              <label className="label"><span className="label-text font-semibold text-base-content/80">Email</span></label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <EnvelopeSimple weight="regular" className="h-5 w-5 text-base-content/40" />
                </div>
                <input 
                  type="email" 
                  className="input input-bordered w-full pl-12 rounded-xl focus:border-primary focus:ring-1 focus:ring-primary transition-all" 
                  placeholder="you@example.com"
                  required
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                />
              </div>
            </div>

            <div className="form-control">
              <label className="label"><span className="label-text font-semibold text-base-content/80">Password</span></label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <Lock weight="regular" className="h-5 w-5 text-base-content/40" />
                </div>
                <input 
                  type="password" 
                  className="input input-bordered w-full pl-12 rounded-xl focus:border-primary focus:ring-1 focus:ring-primary transition-all" 
                  placeholder="••••••••"
                  required
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                />
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
