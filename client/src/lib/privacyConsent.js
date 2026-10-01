// The two agreements every account needs, asked for at sign-up and on the consent screen. The
// server takes each only as the boolean true (server/validators/authValidator.js).
export const CONSENT_FIELD_NAMES = ['acceptPrivacy', 'confirmAdult'];

const MISSING_CONSENT_MESSAGES = {
  acceptPrivacy: 'Tick this box to agree to the Privacy Notice.',
  confirmAdult: 'Tick this box to confirm you are 18 or older. Donor is only for adults.',
};

// The inline error for each box that is not ticked, keyed by field name; {} when both are
export const findMissingConsentErrors = (values) =>
  Object.fromEntries(
    CONSENT_FIELD_NAMES.filter((name) => values[name] !== true).map((name) => [name, MISSING_CONSENT_MESSAGES[name]]),
  );
