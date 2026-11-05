/**
 * A request's share token: the random code in the link a requester shares (/r/<token>), which
 * lets anyone open that one request's public page (GET /api/public/requests/:token).
 *
 * 16 random bytes, so a token can't be guessed, and it is not derived from the request id or
 * anything else about the request. The token reaches only the requester: in the create response,
 * and from POST /api/requests/:id/share-link (request.controller.js). The model's toJSON/toObject
 * drop it everywhere else (models/request.model.js).
 */
const crypto = require('crypto');

const SHARE_TOKEN_BYTES = 16;

// What crypto's base64url gives for 16 bytes: 22 characters, no padding. 16 bytes are 128 bits and
// 22 characters carry 132, so the last character holds 2 bits followed by four zero bits, which
// leaves only A, Q, g or w for it. Anything else was never made here.
const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{21}[AQgw]$/;

const generateShareToken = () => crypto.randomBytes(SHARE_TOKEN_BYTES).toString('base64url');

/**
 * @param {unknown} value
 * @returns {boolean} whether value has the exact form of a share token
 */
const isShareTokenFormat = (value) => typeof value === 'string' && SHARE_TOKEN_PATTERN.test(value);

module.exports = { generateShareToken, isShareTokenFormat };
