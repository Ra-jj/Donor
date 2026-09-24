// Without these the server cannot work at all: JWT_SECRET signs and verifies every login token
// (jwt.sign throws without it, so every login would be a 500), and MONGO_URI is the database.
const REQUIRED_ENV_VARS = ['JWT_SECRET', 'MONGO_URI'];

// Optional, but without both keys pushes go out unsigned and the push service rejects them, so
// they never arrive (an error is logged per donor; see controllers/request.controller.js)
const PUSH_ENV_VARS = ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'];

const isUnset = (value) => value === undefined || value === null || String(value).trim() === '';

/**
 * Lists which of the given variables are unset, empty or whitespace-only in env (normally
 * process.env). Returns names only, never values, so the result is safe to log.
 *
 * - names defaults to REQUIRED_ENV_VARS; pass PUSH_ENV_VARS to check the push keys instead
 * - an empty array means everything asked about is set
 */
const findMissingEnvVars = (env, names = REQUIRED_ENV_VARS) => names.filter((name) => isUnset(env[name]));

module.exports = { findMissingEnvVars, REQUIRED_ENV_VARS, PUSH_ENV_VARS };
