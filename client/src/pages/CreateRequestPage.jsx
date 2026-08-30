import { useState, Suspense, lazy } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'motion/react';
import { MapPin, BuildingOffice, Drop, Heartbeat, ArrowRight } from '@phosphor-icons/react';
import { axiosInstance } from '../lib/axios';
import toast from 'react-hot-toast';

const DonorMap = lazy(() => import('../components/DonorMap'));

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const URGENCY_LEVELS = [
  { value: 'low', label: 'Low (Within 48 hours)' },
  { value: 'medium', label: 'Medium (Within 24 hours)' },
  { value: 'high', label: 'High (Immediate/Emergency)' }
];

const CreateRequestPage = () => {
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState({});
  const [successData, setSuccessData] = useState(null);
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
    setErrors({});
    if (!formData.hospitalLocation) {
      setErrors(prev => ({ ...prev, hospitalLocation: 'Please provide the hospital location to match with nearby donors.' }));
      toast.error('Please provide the hospital location to match with nearby donors.');
      return;
    }

    setLoading(true);
    toast.loading('Notifying nearby donors in real-time...', { id: 'createReq' });

    try {
      const res = await axiosInstance.post('/requests', formData);
      toast.success('Emergency request broadcasted successfully!', { id: 'createReq' });
      setSuccessData(res.data);
    } catch (error) {
      if (error.response?.data?.errors) {
        setErrors(error.response.data.errors);
        toast.error('Please fix the errors below', { id: 'createReq' });
      } else {
        toast.error(error.response?.data?.message || 'Failed to create request', { id: 'createReq' });
      }
    } finally {
      setLoading(false);
    }
  };

  const fieldDelay = (i) => ({ delay: 0.15 + i * 0.07, duration: 0.4 });

  if (successData) {
    return (
      <div className="flex justify-center items-center py-12 px-4">
        <motion.div 
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="card w-full max-w-3xl bg-base-100 shadow-2xl shadow-base-content/5 border border-base-300 rounded-3xl overflow-hidden"
        >
          <div className="card-body p-6 sm:p-10">
            <div className="text-center mb-6">
              <div className="w-16 h-16 bg-success/10 text-success rounded-full flex items-center justify-center mx-auto mb-4 border border-success/20">
                <Heartbeat weight="fill" className="w-8 h-8" />
              </div>
              <h2 className="text-3xl font-display font-bold text-base-content">Request Broadcasted</h2>
              <p className="text-base-content/70 mt-2">
                We've found <strong>{successData.matchedDonorDetails?.length || 0}</strong> compatible donors near {formData.hospitalName}.
              </p>
            </div>
            
            <div className="w-full relative rounded-2xl overflow-hidden bg-base-200">
              <Suspense fallback={
                <div className="h-[400px] flex flex-col items-center justify-center text-base-content/50">
                  <span className="loading loading-spinner loading-lg text-primary mb-4"></span>
                  <p>Loading live map...</p>
                </div>
              }>
                <DonorMap 
                  hospitalLocation={formData.hospitalLocation}
                  donorLocations={successData.matchedDonorDetails}
                  interactive={true}
                  height="h-[400px]"
                />
              </Suspense>
            </div>

            <div className="mt-8">
              <Link to="/dashboard" className="btn btn-primary w-full h-14 rounded-xl text-lg text-white font-bold shadow-lg shadow-primary/20 hover:-translate-y-1 transition-transform">
                Go to Dashboard
                <ArrowRight weight="bold" className="w-5 h-5 ml-1" />
              </Link>
            </div>
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="flex justify-center items-center py-12 px-4">
      <motion.div 
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.25, 0.1, 0.25, 1] }}
        className="card w-full max-w-xl bg-base-100 shadow-2xl shadow-base-content/5 border border-base-300 rounded-3xl overflow-hidden"
      >
        <div className="card-body p-8 sm:p-10">
          {/* Header */}
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.1, duration: 0.4 }}
            className="text-center mb-8"
          >
            <div className="w-16 h-16 bg-primary/10 text-primary rounded-2xl flex items-center justify-center mx-auto mb-5 shadow-sm border border-primary/10">
              <Heartbeat weight="duotone" className="w-8 h-8" />
            </div>
            <h2 className="text-3xl font-display font-extrabold text-base-content tracking-tight">Request Blood</h2>
            <p className="text-base-content/50 mt-3 font-normal text-sm max-w-sm mx-auto leading-relaxed">
              Create an emergency broadcast. We'll notify compatible donors within a 15km radius immediately.
            </p>
          </motion.div>

          <form onSubmit={handleSubmit} className="space-y-5">

            {/* Hospital Name — moved first */}
            <motion.div 
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={fieldDelay(0)}
              className="form-control"
            >
              <label className="label"><span className="label-text font-semibold text-base-content/70 text-xs uppercase tracking-wider">Hospital / Blood Bank</span></label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <BuildingOffice weight="regular" className="h-5 w-5 text-base-content/30" />
                </div>
                <input 
                  type="text" 
                  className={`input w-full pl-12 rounded-xl border ${errors.hospitalName ? 'border-error focus:border-error focus:ring-error' : 'border-base-300 focus:border-primary focus:ring-primary'} bg-base-100 shadow-sm focus:ring-1 transition-all text-base`} 
                  placeholder="e.g. City General Hospital"
                  required
                  value={formData.hospitalName}
                  onChange={(e) => {
                    setFormData({ ...formData, hospitalName: e.target.value });
                    if (errors.hospitalName) setErrors(prev => ({ ...prev, hospitalName: '' }));
                  }}
                />
              </div>
              {errors.hospitalName && (
                <motion.span 
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="text-error text-sm mt-1.5 ml-1 font-medium"
                >
                  {errors.hospitalName}
                </motion.span>
              )}
            </motion.div>
            
            <div className="grid grid-cols-2 gap-4">
              {/* Blood Group */}
              <motion.div 
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={fieldDelay(1)}
                className="form-control"
              >
                <label className="label"><span className="label-text font-semibold text-base-content/70 text-xs uppercase tracking-wider">Blood Group</span></label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                    <Drop weight="regular" className="h-5 w-5 text-primary/50" />
                  </div>
                  <select 
                    className={`select w-full pl-12 rounded-xl border ${errors.bloodGroup ? 'border-error focus:border-error focus:ring-error' : 'border-base-300 focus:border-primary focus:ring-primary'} bg-base-100 shadow-sm focus:ring-1 transition-all font-medium text-base`}
                    required
                    value={formData.bloodGroup}
                    onChange={(e) => {
                      setFormData({ ...formData, bloodGroup: e.target.value });
                      if (errors.bloodGroup) setErrors(prev => ({ ...prev, bloodGroup: '' }));
                    }}
                  >
                    <option value="" disabled>Select</option>
                    {BLOOD_GROUPS.map((bg) => (
                      <option key={bg} value={bg}>{bg}</option>
                    ))}
                  </select>
                </div>
                {errors.bloodGroup && (
                  <motion.span 
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="text-error text-sm mt-1.5 ml-1 font-medium"
                  >
                    {errors.bloodGroup}
                  </motion.span>
                )}
              </motion.div>

              {/* Units */}
              <motion.div 
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={fieldDelay(2)}
                className="form-control"
              >
                <label className="label"><span className="label-text font-semibold text-base-content/70 text-xs uppercase tracking-wider">Units Needed</span></label>
                <input 
                  type="number" 
                  inputMode="numeric" pattern="[0-9]*"
                  min="1" 
                  max="20"
                  className={`input w-full rounded-xl border ${errors.unitsNeeded ? 'border-error focus:border-error focus:ring-error' : 'border-base-300 focus:border-primary focus:ring-primary'} bg-base-100 shadow-sm focus:ring-1 transition-all font-medium text-base`} 
                  required
                  value={formData.unitsNeeded}
                  onChange={(e) => {
                    setFormData({ ...formData, unitsNeeded: e.target.value === '' ? '' : parseInt(e.target.value) || 0 });
                    if (errors.unitsNeeded) setErrors(prev => ({ ...prev, unitsNeeded: '' }));
                  }}
                />
                {errors.unitsNeeded && (
                  <motion.span 
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="text-error text-sm mt-1.5 ml-1 font-medium"
                  >
                    {errors.unitsNeeded}
                  </motion.span>
                )}
              </motion.div>
            </div>

            {/* Urgency */}
            <motion.div 
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={fieldDelay(3)}
              className="form-control"
            >
              <label className="label"><span className="label-text font-semibold text-base-content/70 text-xs uppercase tracking-wider">Urgency Level</span></label>
              <select 
                className="select w-full rounded-xl border border-base-300 bg-base-100 shadow-sm focus:border-primary focus:ring-1 focus:ring-primary transition-all font-medium text-base"
                value={formData.urgency}
                onChange={(e) => setFormData({ ...formData, urgency: e.target.value })}
              >
                {URGENCY_LEVELS.map((level) => (
                  <option key={level.value} value={level.value} className="text-base-content font-medium">
                    {level.label}
                  </option>
                ))}
              </select>
            </motion.div>

            {/* Location */}
            <motion.div 
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={fieldDelay(4)}
              className="form-control mt-2"
            >
              <label className="label"><span className="label-text font-semibold text-base-content/70 text-xs uppercase tracking-wider">Hospital Location</span></label>
              <button 
                type="button" 
                className={`btn w-full rounded-xl font-bold border-2 transition-all active:scale-[0.98] ${formData.hospitalLocation ? 'btn-success text-white border-success' : 'btn-outline border-base-300 hover:border-primary hover:bg-primary/5 hover:text-primary'}`}
                onClick={handleGetLocation}
              >
                <MapPin weight={formData.hospitalLocation ? "fill" : "regular"} className="w-5 h-5 mr-2" />
                {formData.hospitalLocation ? 'Location Captured ✓' : 'Click to Get Current Location'}
              </button>
              {formData.hospitalLocation ? (
                <motion.span 
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="text-xs font-semibold text-success mt-3 text-center block"
                >
                  Coordinates: {formData.hospitalLocation[0].toFixed(4)}, {formData.hospitalLocation[1].toFixed(4)}
                </motion.span>
              ) : errors.hospitalLocation && (
                <motion.span 
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="text-error text-sm mt-1.5 text-center block font-medium"
                >
                  {errors.hospitalLocation}
                </motion.span>
              )}
            </motion.div>

            {/* Submit */}
            <motion.div 
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={fieldDelay(5)}
              className="form-control mt-8"
            >
              <button type="submit" className="btn btn-primary w-full rounded-xl text-white font-bold shadow-lg shadow-primary/20 border-none h-14 text-lg active:scale-[0.98] transition-transform" disabled={loading}>
                {loading ? <span className="loading loading-spinner"></span> : 'Broadcast Emergency Request'}
              </button>
            </motion.div>
          </form>
        </div>
      </motion.div>
    </div>
  );
};

export default CreateRequestPage;
