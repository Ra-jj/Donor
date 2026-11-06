import { DropIcon, HandHeartIcon, HeartbeatIcon, MedalIcon, LockSimpleIcon } from '@phosphor-icons/react';
import { describeDonationBadges } from '../lib/donationBadges';

// One icon per milestone, by its donation count (lib/donationBadges.js)
const BADGE_ICONS = { 1: DropIcon, 3: HandHeartIcon, 5: HeartbeatIcon, 10: MedalIcon };

// Each one says in words whether it is earned, so nothing depends on its color. Only the next one
// to earn is shown besides those already earned, so a new donor sees one goal, not a row of locks.
const DonationBadges = ({ donationCount }) => {
  const { earned, next } = describeDonationBadges(donationCount);

  return (
    <div className="mt-6 pt-6 border-t border-base-300">
      <h3 id="donation-badges-heading" className="text-base font-bold text-base-content mb-3">
        Donation badges
      </h3>
      <ul aria-labelledby="donation-badges-heading" className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
        {earned.map((milestone) => {
          const Icon = BADGE_ICONS[milestone.count];
          return (
            <li key={milestone.count} className="flex items-center gap-3 rounded-xl border border-primary/25 bg-primary/5 p-3">
              <span className="w-10 h-10 rounded-full bg-primary text-primary-content flex items-center justify-center shrink-0">
                <Icon weight="fill" className="w-5 h-5" aria-hidden="true" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-bold text-base-content">{milestone.name}</span>
                <span className="block text-xs text-base-content/70">Earned</span>
              </span>
            </li>
          );
        })}
        {next && (
          <li className="flex items-center gap-3 rounded-xl border border-dashed border-base-content/25 p-3">
            <span className="w-10 h-10 rounded-full bg-base-200 text-base-content/60 flex items-center justify-center shrink-0">
              <LockSimpleIcon weight="bold" className="w-5 h-5" aria-hidden="true" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-bold text-base-content/80">{next.name}</span>
              <span className="block text-xs text-base-content/70">
                <span className="sr-only">Locked: </span>
                {next.remaining} more to go
              </span>
            </span>
          </li>
        )}
      </ul>
      <p className="mt-3 text-xs text-base-content/70 leading-relaxed max-w-prose">
        Only donations completed through Donor count. An outside donation you add in Profile doesn't, as Donor can't
        confirm it.
      </p>
    </div>
  );
};

export default DonationBadges;
