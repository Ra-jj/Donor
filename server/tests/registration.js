// Sign-up requires both consent checkboxes, each as the boolean true (validators/authValidator.js).
// Every test that registers through the API spreads this into its request body, so the requirement
// is written down once. Not a test file itself: Jest only collects *.test.js, like tests/db.js.
const REGISTRATION_CONSENT = Object.freeze({ acceptPrivacy: true, confirmAdult: true });

module.exports = { REGISTRATION_CONSENT };
