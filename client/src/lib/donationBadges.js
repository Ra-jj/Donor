// Milestones for donations completed through Donor: fulfilled requests where the user was the
// donor, the count GET /users/stats returns as donor.livesSaved (getStats in
// server/controllers/user.controller.js), which keeps a donation after its requester deleted their
// account. Outside donations are self-reported, so they never count toward one.
export const DONATION_BADGES = [
  { count: 1, name: 'First donation' },
  { count: 3, name: '3 donations' },
  { count: 5, name: '5 donations' },
  { count: 10, name: '10 donations' },
];

// The badges this many donations has earned, and the next one with how many donations it still
// needs (null once all are earned)
export const describeDonationBadges = (donationCount) => {
  const nextBadge = DONATION_BADGES.find((milestone) => donationCount < milestone.count);
  return {
    earned: DONATION_BADGES.filter((milestone) => donationCount >= milestone.count),
    next: nextBadge ? { ...nextBadge, remaining: nextBadge.count - donationCount } : null,
  };
};
