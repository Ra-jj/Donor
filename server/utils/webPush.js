/**
 * The one web-push setup for everything the server sends: request alerts
 * (controllers/request.controller.js) and donation reminders (utils/donationReminders.js).
 * Configured once, at load, from the VAPID keys in the environment.
 */
const webpush = require('web-push');
const { findMissingEnvVars, PUSH_ENV_VARS } = require('../config/env');

/**
 * Whether both VAPID keys are set. Without them a push goes out unsigned and the push service
 * rejects it (config/env.js). Read from the environment on each call, so tests can set the keys.
 * @returns {boolean}
 */
const isWebPushConfigured = () => findMissingEnvVars(process.env, PUSH_ENV_VARS).length === 0;

if (isWebPushConfigured()) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@donorapp.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

module.exports = { webpush, isWebPushConfigured };
