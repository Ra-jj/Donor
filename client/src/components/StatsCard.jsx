import React, { useEffect } from 'react';
import { useMotionValue, animate } from 'motion/react';
import { Heartbeat, Star } from '@phosphor-icons/react';

const AnimatedCounter = ({ from = 0, to, duration = 2, format = (v) => v }) => {
  const count = useMotionValue(from);
  const [displayValue, setDisplayValue] = React.useState(from);

  useEffect(() => {
    const controls = animate(count, to, {
      duration,
      ease: 'easeOut',
      onUpdate: (value) => {
        setDisplayValue(value);
      },
    });
    return () => controls.stop();
  }, [count, to, duration]);

  return <span>{format(displayValue)}</span>;
};

const StatsCard = ({ donorStats, requesterStats }) => {
  return (
    <div className="glass-card rounded-2xl p-6 sm:p-8 mb-8 shadow-sm">
      <div className="flex items-center gap-3 mb-6">
        <Heartbeat weight="fill" className="w-6 h-6 text-primary" />
        <h2 className="text-lg font-bold text-base-content">Your Impact</h2>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-success/5 border border-success/20 rounded-xl p-5 text-center">
          <div className="text-4xl font-display font-bold text-success mb-1">
            <AnimatedCounter to={donorStats?.livesSaved || 0} format={(v) => Math.floor(v)} />
          </div>
          <div className="text-xs font-semibold text-base-content/60 uppercase tracking-wider">Life Saved</div>
        </div>
        <div className="bg-warning/5 border border-warning/20 rounded-xl p-5 text-center">
          <div className="text-4xl font-display font-bold text-warning flex items-center justify-center gap-1 mb-1">
            <AnimatedCounter to={donorStats?.avgRating || 0} format={(v) => v === 0 ? '-' : v.toFixed(1)} />
            <Star weight="fill" className="w-6 h-6" />
          </div>
          <div className="text-xs font-semibold text-base-content/60 uppercase tracking-wider">
            Avg Rating ({donorStats?.totalRated || 0})
          </div>
        </div>
        <div className="bg-info/5 border border-info/20 rounded-xl p-5 text-center">
          <div className="text-4xl font-display font-bold text-info mb-1">
            <AnimatedCounter to={requesterStats?.totalCreated || 0} format={(v) => Math.floor(v)} />
          </div>
          <div className="text-xs font-semibold text-base-content/60 uppercase tracking-wider">Requests Made</div>
        </div>
      </div>
    </div>
  );
};

export default StatsCard;
