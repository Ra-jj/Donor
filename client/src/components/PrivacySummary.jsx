import { Link } from 'react-router-dom';
import { ArrowSquareOutIcon, ShieldCheckIcon } from '@phosphor-icons/react';

// The short, itemised version of the Privacy Notice, shown where people agree to it: sign-up and
// the consent screen. The full notice opens in a new window, so a half-filled form here stays as
// it is (and a route change in this window could reload it into a new build).
const PrivacySummary = ({ headingLevel = 3 }) => {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';

  return (
    <section
      aria-labelledby="privacy-summary-heading"
      className="rounded-2xl border border-base-300 bg-base-200/60 p-4 sm:p-5 text-sm leading-relaxed text-base-content/80"
    >
      <Heading id="privacy-summary-heading" className="font-display font-bold text-base text-base-content flex items-center gap-2 mb-2">
        <ShieldCheckIcon weight="duotone" className="w-5 h-5 text-primary shrink-0" aria-hidden="true" />
        What Donor keeps about you, and why
      </Heading>
      <ul className="list-disc pl-5 space-y-1.5">
        <li>
          <strong className="text-base-content">Name, email and password</strong> for your account. The password is
          stored only as a hash.
        </li>
        <li>
          <strong className="text-base-content">Blood group and location</strong> to match you with blood requests
          within 15 km. Other users never see your exact location; anyone with a Donor account who asks for blood
          near you can see it rounded to about 1 km, without your name.
        </li>
        <li>
          <strong className="text-base-content">Requests, donations, ratings and chat messages</strong> to arrange
          donations. When you ask for blood, your name, the hospital and its exact location are shown to donors near
          the hospital, and can be seen by anyone with a Donor account.
        </li>
        <li>
          <strong className="text-base-content">Optional:</strong> notifications, and the date of a donation you made
          outside Donor.
        </li>
        <li>Stored with Render and MongoDB Atlas, which may keep it outside India.</li>
        <li>You can delete your account in Profile at any time. It takes effect immediately.</li>
      </ul>
      <Link
        to="/privacy"
        target="_blank"
        rel="noopener"
        className="mt-3 inline-flex items-center gap-1.5 font-semibold text-primary underline min-h-11"
      >
        Read the full Privacy Notice
        <ArrowSquareOutIcon weight="bold" className="w-4 h-4 shrink-0" aria-hidden="true" />
        <span className="sr-only">(opens in a new window)</span>
      </Link>
    </section>
  );
};

export default PrivacySummary;
