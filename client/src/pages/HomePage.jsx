import { Link } from 'react-router-dom';
import { motion, useScroll, useTransform } from 'motion/react';
import { 
  UserPlusIcon, HandHeartIcon, CheckCircleIcon, ArrowRightIcon, DropIcon,
  LightningIcon, ChatCircleDotsIcon, MapPinIcon,
  HeartIcon, HeartbeatIcon
} from '@phosphor-icons/react';

/* ──────────────────────────────── DATA ──────────────────────────────── */

const STEPS = [
  {
    icon: UserPlusIcon,
    title: "Sign Up",
    description: "Create your account in seconds with your name, email, blood group and location."
  },
  {
    icon: HandHeartIcon,
    title: "Request or Respond",
    description: "Ask for blood for a patient at a hospital. Compatible donors within 15 km are alerted right away."
  },
  {
    icon: CheckCircleIcon,
    title: "Coordinate & Save",
    description: "Connect via real-time chat to coordinate the drop-off. It's that simple."
  }
];

const TRUST_ITEMS = [
  { icon: LightningIcon, label: "Real-time Matching" },
  { icon: DropIcon, label: "Blood-Group Matching" },
  { icon: ChatCircleDotsIcon, label: "In-App Chat" },
  { icon: MapPinIcon, label: "15km Radius" },
];

const STATS = [
  { value: "15 km", label: "Matching Radius" },
  { value: "8", label: "Blood Groups Matched" },
  { value: "0", label: "Ads or Trackers" },
];

/* ──────────────────────────── COMPONENTS ─────────────────────────── */

/** Stat that fades in once it scrolls into view */
const AnimatedStat = ({ value, label }) => (
  <motion.div
    initial={{ opacity: 0, y: 16 }}
    whileInView={{ opacity: 1, y: 0 }}
    viewport={{ once: true }}
    transition={{ duration: 0.5 }}
    className="text-center"
  >
    <div className="text-3xl md:text-4xl font-display font-extrabold text-base-content tracking-tight whitespace-nowrap">
      {value}
    </div>
    <div className="text-sm text-base-content/50 font-medium mt-1">{label}</div>
  </motion.div>
);

/* ──────────────────────────── MAIN PAGE ──────────────────────────── */

const HomePage = () => {
  const { scrollYProgress } = useScroll();
  const backgroundY = useTransform(scrollYProgress, [0, 1], ['0%', '30%']);

  return (
    <div className="w-full overflow-hidden">

      {/* ═══════════════════════ HERO ═══════════════════════ */}
      <section className="relative min-h-[92vh] flex flex-col justify-center items-center text-center px-4 pt-20 pb-16">
        {/* Subtle background decoration */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <motion.div 
            style={{ y: backgroundY }}
            className="absolute top-1/4 left-1/2 -translate-x-1/2 w-150 h-150 rounded-full bg-primary/3 blur-3xl"
          />
          <div className="absolute bottom-0 left-0 right-0 h-px bg-linear-to-r from-transparent via-base-300 to-transparent" />
        </div>

        <div className="relative z-10 max-w-3xl mx-auto">
          {/* Badge */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.1 }}
            className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-primary/5 border border-primary/10 text-sm font-medium text-primary mb-8"
          >
            <HeartbeatIcon weight="fill" className="w-4 h-4" />
            <span>Saving lives, one match at a time</span>
          </motion.div>

          {/* Headline — staggered word reveal */}
          <motion.h1
            className="text-4xl md:text-5xl lg:text-7xl font-display font-extrabold text-base-content leading-[1.08] tracking-tight mb-6"
          >
            {["Find", "blood", "donors"].map((word, i) => (
              <motion.span
                key={word}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: 0.2 + i * 0.1 }}
                className="inline-block mr-[0.3em]"
              >
                {word}
              </motion.span>
            ))}
            <br className="hidden md:block" />
            {["in", "real", "time."].map((word, i) => (
              <motion.span
                key={word}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: 0.5 + i * 0.1 }}
                className={`inline-block mr-[0.3em] ${word === "time." ? "text-primary" : ""}`}
              >
                {word}
              </motion.span>
            ))}
          </motion.h1>

          {/* Subheadline */}
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.6, delay: 0.8 }}
            className="text-lg md:text-xl text-base-content/55 max-w-xl mx-auto mb-10 leading-relaxed font-body font-normal"
          >
            A fast, direct way to ask for blood near a hospital and reach compatible donors nearby.
          </motion.p>

          {/* CTAs */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 1 }}
            className="flex flex-col sm:flex-row gap-3 justify-center items-center mb-16 w-full"
          >
            <Link 
              to="/register" 
              className="group btn btn-primary btn-lg rounded-full w-full sm:w-auto px-8 text-white font-bold border-none shadow-lg shadow-primary/20 glow-primary hover:shadow-primary/30 transition-all active:scale-98"
            >
              Get Started
              <ArrowRightIcon weight="bold" className="w-5 h-5 ml-1 group-hover:translate-x-1 transition-transform" />
            </Link>
            <Link 
              to="/login" 
              className="btn btn-ghost btn-lg rounded-full w-full sm:w-auto px-8 font-semibold text-base-content/70 hover:text-base-content hover:bg-base-300/50 active:scale-98 transition-transform"
            >
              Log in
            </Link>
          </motion.div>

          {/* Stats */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.6, delay: 1.2 }}
            className="flex justify-center gap-12 md:gap-16 border-t border-base-300/80 pt-10 max-w-lg mx-auto"
          >
            {STATS.map((stat) => (
              <AnimatedStat key={stat.label} value={stat.value} label={stat.label} />
            ))}
          </motion.div>
        </div>
      </section>

      {/* ═══════════════════ TRUST BAR ═══════════════════ */}
      <section className="py-12 border-y border-base-300/60 bg-base-100">
        <div className="container mx-auto px-4 max-w-4xl">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            {TRUST_ITEMS.map((item, index) => (
              <motion.div
                key={item.label}
                initial={{ opacity: 0, y: 12 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-50px" }}
                transition={{ duration: 0.4, delay: index * 0.1 }}
                className="flex flex-col items-center gap-2.5 text-center"
              >
                <div className="w-10 h-10 rounded-xl bg-base-200 flex items-center justify-center">
                  <item.icon weight="duotone" className="w-5 h-5 text-primary" />
                </div>
                <span className="text-sm font-semibold text-base-content/60">{item.label}</span>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ══════════════════ HOW IT WORKS ══════════════════ */}
      <section className="py-24 md:py-32">
        <div className="container mx-auto px-4 max-w-5xl">
          <motion.div
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
            className="text-center mb-16"
          >
            <h2 className="text-3xl md:text-4xl font-display font-extrabold text-base-content tracking-tight mb-4">
              How it works
            </h2>
            <p className="text-base-content/50 max-w-md mx-auto font-normal">
              Three simple steps to bridge the gap between critical shortages and willing donors.
            </p>
          </motion.div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 md:gap-8 relative">
            {/* Connecting line (desktop only) */}
            <div className="hidden md:block absolute top-12 left-[16.66%] right-[16.66%] h-px bg-base-300" />
            
            {STEPS.map((step, index) => (
              <motion.div
                key={index}
                initial={{ opacity: 0, y: 24 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-80px" }}
                transition={{ duration: 0.5, delay: index * 0.15 }}
                className="group relative bg-base-100 p-8 rounded-2xl border border-base-300/60 hover:border-primary/20 hover:shadow-lg hover:shadow-primary/4 transition-all duration-300"
              >
                {/* Step number */}
                <div className="relative z-10 w-10 h-10 rounded-full bg-base-200 group-hover:bg-primary/10 flex items-center justify-center mb-6 transition-colors duration-300">
                  <step.icon weight="duotone" className="w-5 h-5 text-primary" />
                </div>
                <h3 className="text-lg font-bold font-display mb-2 tracking-tight">{step.title}</h3>
                <p className="text-base-content/50 text-sm leading-relaxed">
                  {step.description}
                </p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ══════════════════════ FINAL CTA ══════════════════════ */}
      {/* No top padding: "How it works" above has the same background, and its bottom padding is the gap */}
      <section className="pb-24 md:pb-32">
        <div className="container mx-auto px-4 max-w-3xl">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
            className="bg-gradient-animated rounded-3xl p-12 md:p-16 text-center text-white relative overflow-hidden"
          >
            {/* Subtle pattern overlay */}
            <div className="absolute inset-0 opacity-4" style={{
              backgroundImage: 'radial-gradient(circle at 1px 1px, white 1px, transparent 0)',
              backgroundSize: '24px 24px'
            }} />

            <div className="relative z-10">
              <HeartIcon weight="fill" className="w-10 h-10 mx-auto mb-6 opacity-80" />
              <h2 className="text-3xl md:text-4xl font-display font-extrabold tracking-tight mb-4">
                Ready to make a difference?
              </h2>
              <p className="text-white/70 max-w-md mx-auto mb-8 font-normal">
                Sign up as a donor, or ask for blood when someone needs it.
              </p>
              <Link
                to="/register"
                className="group inline-flex justify-center items-center gap-2 w-full sm:w-auto bg-white text-primary font-bold px-8 py-3.5 rounded-full hover:bg-white/90 transition-all shadow-lg active:scale-98"
              >
                Create Free Account
                <ArrowRightIcon weight="bold" className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
              </Link>
            </div>
          </motion.div>
        </div>
      </section>

      {/* ══════════════════════ FOOTER ══════════════════════ */}
      <footer className="border-t border-base-300/60 py-10">
        <div className="container mx-auto px-4 max-w-5xl">
          <div className="flex flex-col md:flex-row justify-between items-center gap-6">
            <div className="flex items-center gap-2">
              <DropIcon weight="duotone" className="w-6 h-6 text-primary" />
              <span className="text-lg font-display font-extrabold text-base-content tracking-tight">Donor</span>
            </div>
            
            <div className="flex items-center gap-6 text-sm text-base-content/70 font-medium">
              <Link to="/register" className="hover:text-base-content transition-colors">Sign up</Link>
              <Link to="/login" className="hover:text-base-content transition-colors">Log in</Link>
              <Link to="/privacy" className="hover:text-base-content transition-colors">Privacy</Link>
            </div>

            <p className="text-sm text-base-content/30 font-medium">
              Made with <HeartIcon weight="fill" className="w-3.5 h-3.5 text-primary inline-block mx-0.5" /> for those who give.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default HomePage;
