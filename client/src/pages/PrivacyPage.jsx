import { Link } from 'react-router-dom';
import { FileTextIcon } from '@phosphor-icons/react';
import { PRIVACY_CONTACT_EMAIL, PRIVACY_NOTICE_LAST_UPDATED, PRIVACY_NOTICE_VERSION } from '../config/privacy';

// The full Privacy Notice, public and complete on its own. Every statement here was checked
// against the code that does it (server models, controllers, security headers and this client);
// change the notice when that code changes, with a new version in config/privacy.js.

const ContactEmail = () => (
  <a href={`mailto:${PRIVACY_CONTACT_EMAIL}`} className="font-semibold text-primary underline wrap-anywhere">
    {PRIVACY_CONTACT_EMAIL}
  </a>
);

const NoticeSection = ({ id, title, children }) => (
  <section aria-labelledby={id} className="space-y-3">
    <h2 id={id} className="text-xl font-display font-bold text-base-content">
      {title}
    </h2>
    {children}
  </section>
);

// An item that starts with its subject in bold, so a long run of items stays easy to scan
const Item = ({ lead, children }) => (
  <li>
    <strong className="font-semibold text-base-content">{lead}</strong> {children}
  </li>
);

const itemsClassName = 'list-disc pl-5 space-y-2';

const PrivacyPage = () => (
  <article aria-labelledby="privacy-title" className="space-y-6">
    <header className="space-y-3">
      <div className="w-12 h-12 bg-primary/10 text-primary rounded-2xl flex items-center justify-center">
        <FileTextIcon weight="duotone" className="w-6 h-6" aria-hidden="true" />
      </div>
      <h1 id="privacy-title" className="text-3xl sm:text-4xl font-display font-extrabold text-base-content tracking-tight">
        Privacy Notice
      </h1>
      <div className="text-sm text-base-content/70">
        <p>Last updated: {PRIVACY_NOTICE_LAST_UPDATED}</p>
        <p>Version: {PRIVACY_NOTICE_VERSION}</p>
      </div>
      <p className="text-base-content/80 leading-relaxed max-w-prose">
        Donor is a small personal project that helps people who need blood find donors nearby. This notice says, in
        plain words, what Donor stores about you, why, who can see it, and what you can do about it. It is complete on
        its own.
      </p>
    </header>

    <div className="bg-base-100 rounded-3xl border border-base-300 shadow-sm p-5 sm:p-8 md:p-10 space-y-10 text-base-content/80 leading-relaxed">
      <NoticeSection id="who-we-are" title="Who we are">
        <p>
          Donor is a personal project by Raj. It is run by one person, not by a company, hospital or blood bank.
        </p>
        <p>
          For anything about your data, email <ContactEmail />. We reply within 30 days.
        </p>
      </NoticeSection>

      <NoticeSection id="what-we-store" title="What we store">
        <p>When you use Donor, we store:</p>
        <ul className={itemsClassName}>
          <Item lead="Name and email address,">and when your account was created and last changed.</Item>
          <Item lead="Password,">
            only as a bcrypt hash: a scrambled form that can't be turned back into the password. The password itself is
            never stored.
          </Item>
          <Item lead="Blood group." />
          <Item lead="Your location:">
            one exact point (latitude and longitude). At sign-up it comes from your device's location, or from a place
            you search for. It is stored exactly as given, and replaced when you update it in Profile.
          </Item>
          <Item lead="Availability:">whether "Available to donate" is on in Profile.</Item>
          <Item lead="Last donation outside Donor:">optional, a date you can add in Profile.</Item>
          <Item lead="Push subscription:">
            only if you turn on notifications. It is an address at your browser's push service, plus the keys to
            encrypt messages to it. It holds no phone number.
          </Item>
          <Item lead="Blood requests you make:">
            hospital name, hospital location, blood group needed, units, urgency, status and dates.
          </Item>
          <Item lead="Donations:">
            the requests you accepted, declined or completed as a donor, and when each donation was completed.
          </Item>
          <Item lead="Ratings and notes:">
            the 1 to 5 star rating, and the optional note of up to 500 characters, that a requester gives their donor
            after a donation.
          </Item>
          <Item lead="Chat messages:">the text, who sent it to whom, for which request, and when.</Item>
          <Item lead="Your consent:">
            each version of this notice you agreed to and when, and when you confirmed you are 18 or older.
          </Item>
          <Item lead="Cookies:">
            <code>jwt</code> keeps you logged in for up to 7 days. It is httpOnly, so scripts on the page can't read it.{' '}
            <code>theme</code> remembers light or dark mode for a year. There are no advertising or tracking cookies.
            Your browser also stores the app's own files so Donor opens quickly; they hold no personal data.
          </Item>
          <Item lead="Your IP address,">
            which reaches our server with every request. To limit repeated sign-ups and login attempts, the server keeps
            it in memory for up to two hours after your last attempt, and does not save it in the database. Render,
            which hosts Donor, may also record it in its own request logs.
          </Item>
        </ul>
      </NoticeSection>

      <NoticeSection id="why-we-use-it" title="Why we use it">
        <ul className={itemsClassName}>
          <Item lead="Your account.">Name, email, password hash and the jwt cookie let you sign up and log in.</Item>
          <Item lead="Matching.">
            Your blood group, location and availability decide which nearby requests you are told about. A request
            reaches compatible donors within 15 km of the hospital.
          </Item>
          <Item lead="The gap between donations.">
            Under India's blood donation rules (G.S.R. 166(E), 2020), whole blood can be given once every 90 days by men
            and once every 120 days by women. Donor doesn't ask your sex, so it uses 120 days for everyone. It works out
            the date from your last donation through Donor and the outside donation date you gave. Until then you get
            no new request alerts and can't accept a request.
          </Item>
          <Item lead="Notifications.">
            Your push subscription lets Donor alert your phone or computer when a compatible request is made nearby.
            While the app is open, alerts also arrive over a live connection.
          </Item>
          <Item lead="Arranging a donation.">Chat lets a matched donor and requester agree on the details.</Item>
          <Item lead="History and ratings.">
            Your past requests and donations, and the ratings donors receive, are shown to you in Profile.
          </Item>
          <Item lead="Safety.">
            Your IP address, held for a short time, slows down automated sign-ups and password guessing. Your consent
            record shows what you agreed to, and when.
          </Item>
        </ul>
      </NoticeSection>

      <NoticeSection id="who-can-see-what" title="Who can see what">
        <p>
          <strong className="font-semibold text-base-content">Other users never see your exact home location.</strong>{' '}
          While "Available to donate" is on and you are free to donate, your location rounded to about 1 km is shown as
          an unnamed dot on the map of anyone who asks for blood within 15 km of you. Donor does not check where a
          request is really made, so treat these dots as visible to anyone with a Donor account. In a quiet area one
          dot can show where you live to within about 1 km, and that someone there can give the blood group that was
          asked for.
        </p>
        <ul className={itemsClassName}>
          <Item lead="When you ask for blood,">
            your name, the hospital's name and exact location, the blood group, units needed and urgency are sent to
            compatible donors within 15 km of the hospital. Those who have "Available to donate" on and are not resting
            after a donation or busy with another one get a live alert, and a push notification showing your name if
            they turned notifications on. Until the request is accepted, cancelled or fulfilled, it is also listed for
            every signed-in user whose saved blood group is compatible and whose saved location is within 15 km. Donor
            does not check anyone's blood group or location, and users can change both in Profile, so treat an open
            request as visible to anyone with a Donor account. Nobody is sent your email or your home location.
          </Item>
          <Item lead="The hospital location">
            is the place you pick by searching, which sends what you type to OpenStreetMap Nominatim, or, if you choose
            “I'm at the hospital – use my location”, where your device is at that moment.
          </Item>
          <Item lead="As the requester,">
            you see how many compatible, available donors are near the hospital, and their positions on a map rounded
            to about 1 km, with no names. Only donors who can give the blood group you asked for are shown.
          </Item>
          <Item lead="When a donor accepts,">
            you see their name, and the two of you can chat until the request is fulfilled or cancelled. In the app,
            only the two of you can read that chat.
          </Item>
          <Item lead="After a donation,">
            you see each other's names in your histories, and the donor sees the rating and note you gave.
          </Item>
          <Item lead="Raj, who runs Donor,">
            can access the database, including chat messages, when needed to run or fix the service. Messages travel
            over HTTPS but are not end-to-end encrypted.
          </Item>
        </ul>
        <p>We don't sell your data or show ads.</p>
      </NoticeSection>

      <NoticeSection id="services" title="Services that handle your data">
        <ul className={itemsClassName}>
          <Item lead="Render">
            hosts the app and its server; Render's network (Cloudflare) carries the traffic.
          </Item>
          <Item lead="MongoDB Atlas">hosts the database.</Item>
        </ul>
        <p>Render and MongoDB Atlas may store or process your data outside India.</p>
        <ul className={itemsClassName}>
          <Item lead="Browser push services">
            deliver notifications if you turn them on: Google (Chrome and Android), Mozilla (Firefox), Apple (Safari) or
            Microsoft (Edge), depending on your browser. The message itself is encrypted on its way through them.
          </Item>
          <Item lead="OpenStreetMap.">
            Your browser loads the maps straight from OpenStreetMap's tile servers, which shows them your IP address
            and the area of the map you look at.
          </Item>
          <Item lead="OpenStreetMap Nominatim.">
            When you search for a place at sign-up, or for the hospital on the New Request form, your browser sends what
            you type to Nominatim to find it, which also shows Nominatim your IP address. Your saved location is never
            sent with a search.
          </Item>
          <Item lead="Google Fonts.">Your browser loads the app's fonts from Google, which shows Google your IP address.</Item>
        </ul>
        <p>Donor has no ads, analytics or tracking scripts.</p>
      </NoticeSection>

      <NoticeSection id="how-long" title="How long we keep it">
        <p>Everything above stays until you delete your account, except as described here.</p>
        <p>When you delete your account, these are erased immediately:</p>
        <ul className={itemsClassName}>
          <li>
            your profile: name, email, password hash, blood group, location, availability, outside donation date, push
            subscription and consent record;
          </li>
          <li>every request you made that wasn't fulfilled, with its chat messages;</li>
          <li>every chat message you sent or received;</li>
          <li>
            the record of requests you declined, and your place as donor on cancelled requests. An accepted request
            where you were the donor goes back to open for its requester.
          </li>
        </ul>
        <ul className={itemsClassName}>
          <Item lead="Finished donations are kept, without your name.">
            A fulfilled request stays in the other person's history and still counts toward the donor's gap between
            donations. It shows "Deleted user" instead of you, and its rating note is removed. The hospital name and
            location, blood group, units, urgency, dates and star rating stay.
          </Item>
          <Item lead="Chat messages">
            stay stored after a request ends, even though the app no longer shows them, until you or the other person
            deletes their account.
          </Item>
          <Item lead="Server logs.">
            Our server writes short technical logs, such as errors. They usually hold only internal IDs, but a rare error
            can include an email address. Render keeps these logs under its own rules.
          </Item>
          <Item lead="Backups.">
            If our providers keep backups, deleted data can remain in them until those backups expire.
          </Item>
        </ul>
      </NoticeSection>

      <NoticeSection id="your-rights" title="Your choices and rights">
        <ul className={itemsClassName}>
          <Item lead="Stop request alerts.">
            Turn off "Available to donate" in <Link to="/profile" className="font-semibold text-primary underline">Profile</Link>.
            You then get no new request alerts, push included, and aren't counted or shown on requesters' maps. You can
            still see open requests near you.
          </Item>
          <Item lead="Turn notifications off.">
            Donor asks for permission only when you tap Enable Now on the dashboard. To turn notifications off, block
            them for this site in your browser or phone settings. There is no switch for this in the app.
          </Item>
          <Item lead="Edit your details.">
            Change your name, blood group, location, availability and outside donation date in Profile. Your email
            can't be changed in the app: email us to correct it.
          </Item>
          <Item lead="Get a copy, or a correction.">
            Email us for a copy of your data, or to correct anything that's wrong.
          </Item>
          <Item lead="Delete your account">
            in Profile, with your password. It happens immediately and can't be undone.
          </Item>
          <Item lead="Withdraw consent">
            by deleting your account. Donor can't work without this data, so consent can't be withdrawn while keeping
            the account.
          </Item>
          <Item lead="Name someone to act for you.">
            You can name another person to use these rights if you die or can no longer act yourself. Email us.
          </Item>
        </ul>
      </NoticeSection>

      <NoticeSection id="complaints" title="Complaints">
        <p>
          Contact us first at <ContactEmail />. If we don't resolve your complaint, you can complain to the Data
          Protection Board of India.
        </p>
      </NoticeSection>

      <NoticeSection id="languages" title="Other languages">
        <p>
          To read this notice in Hindi, Bengali or another language listed in the Eighth Schedule of the Constitution,
          email us.
        </p>
      </NoticeSection>

      <NoticeSection id="age" title="Age limit">
        <p>
          Donor is only for people aged 18 or older, which is also the minimum age for donating blood. Accounts we learn
          belong to someone under 18 will be deleted.
        </p>
      </NoticeSection>

      <NoticeSection id="security" title="Security">
        <p>
          Donor is served over HTTPS, stores passwords only as bcrypt hashes, and keeps your login in an httpOnly cookie
          that scripts on the page can't read. No system is perfectly secure. If a breach ever affects your data, we
          will tell you, and report it to the Data Protection Board of India.
        </p>
      </NoticeSection>

      <NoticeSection id="changes" title="Changes to this notice">
        <p>
          If this notice changes, it gets a new version and date. You will be shown the new version the next time you
          open Donor, and asked to agree to it before you continue.
        </p>
      </NoticeSection>
    </div>
  </article>
);

export default PrivacyPage;
