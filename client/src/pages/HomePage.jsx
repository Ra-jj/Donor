import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { UserPlus, HandHeart, CheckCircle } from '@phosphor-icons/react';

const HomePage = () => {
  const steps = [
    {
      icon: <UserPlus weight="duotone" className="w-12 h-12 text-primary" />,
      title: "Register",
      description: "Sign up in seconds. We verify basic details to keep the platform secure and trustworthy."
    },
    {
      icon: <HandHeart weight="duotone" className="w-12 h-12 text-primary" />,
      title: "Request or Respond",
      description: "Hospitals broadcast critical needs. Donors get notified instantly when their type matches."
    },
    {
      icon: <CheckCircle weight="duotone" className="w-12 h-12 text-primary" />,
      title: "Match & Coordinate",
      description: "Connect instantly via real-time chat to coordinate the drop-off and save a life."
    }
  ];

  return (
    <div className="w-full">
      {/* Hero Section */}
      <section className="min-h-[85vh] flex flex-col justify-center items-center text-center px-4 pt-16">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="max-w-4xl mx-auto"
        >
          <h1 className="text-5xl md:text-6xl font-extrabold text-base-content leading-tight tracking-tight mb-6">
            Find blood donors in real time, <br className="hidden md:block" />
            <span className="text-primary">when it matters most.</span>
          </h1>
          
          <p className="text-lg md:text-xl text-base-content/70 max-w-2xl mx-auto mb-10 leading-relaxed font-body">
            A fast, direct, and reliable way for hospitals to broadcast critical blood shortages and coordinate with verified local donors.
          </p>
          
          <div className="flex flex-col sm:flex-row gap-4 justify-center items-center mb-12">
            <Link to="/register" className="btn btn-primary btn-lg rounded-full px-8 text-white font-bold border-none hover:brightness-110 shadow-lg shadow-primary/30">
              Get Started for Free
            </Link>
            <Link to="/login" className="btn btn-ghost btn-lg rounded-full px-8 font-semibold hover:bg-base-300">
              Log in to Account
            </Link>
          </div>
          
          <div className="flex flex-wrap justify-center gap-x-8 gap-y-4 text-sm font-medium text-base-content/60 border-t border-base-300 pt-8 w-full max-w-2xl mx-auto">
            <div className="flex items-center gap-2">
              <CheckCircle weight="fill" className="text-success w-5 h-5" />
              <span>Real-time matching</span>
            </div>
            <div className="flex items-center gap-2">
              <CheckCircle weight="fill" className="text-success w-5 h-5" />
              <span>Verified donors</span>
            </div>
            <div className="flex items-center gap-2">
              <CheckCircle weight="fill" className="text-success w-5 h-5" />
              <span>Always free</span>
            </div>
          </div>
        </motion.div>
      </section>

      {/* How it Works Section */}
      <section className="py-24 bg-base-200/50">
        <div className="container mx-auto px-4 max-w-6xl">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-extrabold mb-4">How it works</h2>
            <p className="text-base-content/70 max-w-xl mx-auto">Three simple steps to bridge the gap between critical shortages and those ready to help.</p>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {steps.map((step, index) => (
              <motion.div
                key={index}
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-100px" }}
                transition={{ duration: 0.5, delay: index * 0.2 }}
                className="bg-base-100 p-8 rounded-3xl shadow-sm border border-base-300 hover:-translate-y-2 transition-all duration-300"
              >
                <div className="mb-6 bg-primary/10 w-20 h-20 rounded-2xl flex items-center justify-center">
                  {step.icon}
                </div>
                <h3 className="text-xl font-bold mb-3">{step.title}</h3>
                <p className="text-base-content/70 leading-relaxed">
                  {step.description}
                </p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
};

export default HomePage;
