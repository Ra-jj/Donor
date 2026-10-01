/**
 * Consent to the privacy notice.
 *
 * The notice's text ships with the client (client/src/pages/PrivacyPage.jsx), so its version lives
 * there too (client/src/config/privacy.js), where the page shows it. This is the server's copy: the
 * version stamped on a user when they agree, and the one every user is compared with to decide who
 * must agree again. tests/privacyConsent.test.js fails if the two copies differ.
 *
 * Changing the notice means a new version in both places. Every signed-in user then sees the
 * consent screen once, at their next visit, before any other page.
 */
const PRIVACY_NOTICE_VERSION = '2026-10-01';

/**
 * The User fields one agreement writes: the notice version and the moment, from the server's clock
 * (never the client's), and the 18+ confirmation, which is always given together with it.
 * @param {Date} [now]
 * @returns {{ privacyConsent: { version: string, acceptedAt: Date }, adultConfirmedAt: Date }}
 */
const buildPrivacyConsentFields = (now = new Date()) => ({
  privacyConsent: { version: PRIVACY_NOTICE_VERSION, acceptedAt: now },
  adultConfirmedAt: now,
});

// Every agreement is also kept in privacyConsentHistory, because the app must be able to prove
// consent was given (DPDP Act s.6(10)) after a later version has replaced privacyConsent. The
// history entry is written in the same operation as the fields it repeats, so the two never differ.

/**
 * The consent fields of a new account (sign-up): one agreement, and a history holding just it.
 * @param {Date} [now]
 */
const buildSignUpPrivacyConsentFields = (now = new Date()) => {
  const fields = buildPrivacyConsentFields(now);
  return { ...fields, privacyConsentHistory: [{ ...fields.privacyConsent }] };
};

/**
 * The update for an existing account agreeing to the current notice: sets the fields and appends
 * the same agreement to the history. Pair it with privacyConsentMissingFilter, so a repeat of an
 * agreement already recorded matches nothing and appends nothing.
 * @param {Date} [now]
 */
const buildPrivacyConsentUpdate = (now = new Date()) => {
  const fields = buildPrivacyConsentFields(now);
  return { $set: fields, $push: { privacyConsentHistory: { ...fields.privacyConsent } } };
};

/**
 * Whether a user must still agree to the current notice: an account from before consent was
 * recorded has neither field, and an older agreement names an older version.
 * @param {{ privacyConsent?: { version?: string } | null, adultConfirmedAt?: Date | null }} user
 * @returns {boolean}
 */
const needsPrivacyConsent = (user) =>
  user.privacyConsent?.version !== PRIVACY_NOTICE_VERSION || !user.adultConfirmedAt;

// Update filter for the users needsPrivacyConsent is true for. $ne also matches a missing or null
// privacyConsent, and `null` matches a missing adultConfirmedAt.
const privacyConsentMissingFilter = () => ({
  $or: [{ 'privacyConsent.version': { $ne: PRIVACY_NOTICE_VERSION } }, { adultConfirmedAt: null }],
});

/**
 * The consent fields of the signed-in user's own profile response. Only ever built for the user
 * themselves: other users' records never leave the server. privacyConsentHistory is not one of
 * them: it is kept as proof, and no screen shows it (withDonationEligibility leaves it out).
 * @param {import('mongoose').Document} userDocument
 * @returns {{ privacyConsent: { version: string, acceptedAt: Date } | null, needsPrivacyConsent: boolean }}
 */
const describePrivacyConsent = (userDocument) => {
  const { privacyConsent } = userDocument;
  return {
    privacyConsent: privacyConsent?.version
      ? { version: privacyConsent.version, acceptedAt: privacyConsent.acceptedAt }
      : null,
    needsPrivacyConsent: needsPrivacyConsent(userDocument),
  };
};

module.exports = {
  PRIVACY_NOTICE_VERSION,
  buildPrivacyConsentFields,
  buildSignUpPrivacyConsentFields,
  buildPrivacyConsentUpdate,
  needsPrivacyConsent,
  privacyConsentMissingFilter,
  describePrivacyConsent,
};
