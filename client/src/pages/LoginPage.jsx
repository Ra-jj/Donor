import { useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'motion/react';
import { EnvelopeSimple, Lock, SignIn, Eye, EyeSlash, Drop } from '@phosphor-icons/react';
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
    <div className="flex justify-center items-center min-h-[calc(100vh-6rem)] px-4">
      <motion.div 
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.25, 0.1, 0.25, 1] }}
        className="card w-full max-w-md bg-base-100 shadow-2xl shadow-base-content/5 border border-base-300 rounded-3xl overflow-hidden"
      >
        <div className="card-body p-8 sm:p-10">
          {/* Header */}
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.15, duration: 0.4 }}
            className="text-center mb-8"
          >
            <div className="w-14 h-14 bg-primary/10 text-primary rounded-2xl flex items-center justify-center mx-auto mb-5">
              <Drop weight="duotone" className="w-7 h-7" />
            </div>
            <h2 className="text-3xl font-display font-extrabold text-base-content tracking-tight">Welcome back</h2>
            <p className="text-base-content/50 mt-2 font-normal text-sm">Log in to your Donor account</p>
          </motion.div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Email */}
            <motion.div 
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2, duration: 0.4 }}
              className="form-control"
            >
              <label className="label"><span className="label-text font-semibold text-base-content/70 text-xs uppercase tracking-wider">Email</span></label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <EnvelopeSimple weight="regular" className="h-5 w-5 text-base-content/30" />
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
              {emailError && (
                <motion.span 
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="text-error text-sm mt-1.5 ml-1 font-medium"
                >
                  {emailError}
                </motion.span>
              )}
            </motion.div>

            {/* Password */}
            <motion.div 
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3, duration: 0.4 }}
              className="form-control"
            >
              <label className="label"><span className="label-text font-semibold text-base-content/70 text-xs uppercase tracking-wider">Password</span></label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <Lock weight="regular" className="h-5 w-5 text-base-content/30" />
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
                  className="absolute inset-y-0 right-0 pr-4 flex items-center text-base-content/30 hover:text-primary transition-colors focus:outline-none"
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? <EyeSlash weight="regular" className="h-5 w-5" /> : <Eye weight="regular" className="h-5 w-5" />}
                </button>
              </div>
            </motion.div>

            {/* Submit */}
            <motion.div 
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.4, duration: 0.4 }}
              className="form-control mt-8"
            >
              <button type="submit" className="btn btn-primary w-full rounded-xl text-white font-bold shadow-lg shadow-primary/20 border-none h-12" disabled={loading}>
                {loading ? <span className="loading loading-spinner"></span> : (
                  <>
                    <SignIn weight="bold" className="w-5 h-5 mr-1" />
                    Log In
                  </>
                )}
              </button>
            </motion.div>
          </form>

          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.5, duration: 0.4 }}
            className="text-center mt-8"
          >
            <p className="text-base-content/50 text-sm font-medium">
              Don't have an account?{' '}
              <Link to="/register" className="text-primary font-bold hover:underline">Sign Up</Link>
            </p>
          </motion.div>
        </div>
      </motion.div>
    </div>
  );
};

export default LoginPage;
