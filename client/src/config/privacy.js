// The privacy notice's settings, in one place.

// The address the notice gives for privacy questions, copies of data, corrections and complaints.
// A placeholder: replace it with a real, monitored address before deploying.
export const PRIVACY_CONTACT_EMAIL = 'donor@example.com';

// The notice's version, shown at the top of /privacy. The server keeps its own copy
// (server/utils/privacyConsent.js), records it when a user agrees and asks everyone who agreed to
// an older one to agree again; server/tests/privacyConsent.test.js fails if the two differ. Any
// change to the notice text gets a new version here and there, and a new date below.
export const PRIVACY_NOTICE_VERSION = '2026-10-01';
export const PRIVACY_NOTICE_LAST_UPDATED = '1 October 2026';
