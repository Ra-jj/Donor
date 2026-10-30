// The text a requester can share about their own open request, to WhatsApp or any other app.
// Built here in the browser from four fields of the request, plus the app's address. It never
// holds the requester's name or email, the hospital's coordinates or the request id. Donor sends
// nothing anywhere: the requester's own phone or browser hands the text to the app they choose.
import { URGENCY_LEVELS } from './urgencyLevels';

const URGENCY_LABELS = Object.fromEntries(URGENCY_LEVELS.map(({ value, label }) => [value, label]));
// The request model's default urgency (server/models/request.model.js)
const DEFAULT_URGENCY = 'medium';

// A UTF-16 surrogate pair, or one half on its own
const SURROGATES = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g;

// encodeURIComponent throws a URIError on a lone surrogate, and the WhatsApp address is built
// while the page renders, so one stray half of an emoji in a hospital name would take the page
// down. Each lone half becomes U+FFFD, as String.prototype.toWellFormed does (not used here:
// Safari has it only from 16.4).
const toWellFormed = (text) =>
  text.replace(SURROGATES, (match) => (match.length === 2 ? match : '\uFFFD'));

/**
 * The shared text, one fact per line. Example:
 *   🩸 Urgent: B+ blood needed
 *   2 units at Apollo Gleneagles Hospital
 *   Urgency: High (Immediate/Emergency)
 *
 *   Can you donate, or share with someone who can?
 *   Donor app: https://rajcodes-donor.onrender.com/
 *
 * @param {{ bloodGroup: string, unitsNeeded: number, hospitalName: string, urgency?: string }} request
 * @param {string} appUrl where people are sent, e.g. `${window.location.origin}/`
 */
export const buildRequestShareText = ({ bloodGroup, unitsNeeded, hospitalName, urgency }, appUrl) => {
  const units = Number(unitsNeeded);
  // Own keys only: a plain lookup would also find inherited ones, e.g. 'constructor'
  const urgencyLabel = Object.hasOwn(URGENCY_LABELS, urgency) ? URGENCY_LABELS[urgency] : URGENCY_LABELS[DEFAULT_URGENCY];
  // "Urgent" only when the requester chose High, so a request for within 48 hours is not oversold
  const headline = urgency === 'high' ? `🩸 Urgent: ${bloodGroup} blood needed` : `🩸 ${bloodGroup} blood needed`;
  // One line however the name was typed: line breaks or runs of spaces would break the layout
  const hospital = String(hospitalName).replace(/\s+/g, ' ').trim();

  return [
    headline,
    `${units} ${units === 1 ? 'unit' : 'units'} at ${hospital}`,
    `Urgency: ${urgencyLabel}`,
    '',
    'Can you donate, or share with someone who can?',
    `Donor app: ${appUrl}`,
  ].join('\n');
};

// WhatsApp's own share address: it opens WhatsApp (the app on a phone, WhatsApp Web elsewhere)
// with the text filled in, and the requester picks the chat or group. encodeURIComponent also
// encodes the emoji, "+" in a blood group like "B+", "&" and "#" in a hospital name, and the
// line breaks (%0A).
export const buildWhatsAppShareUrl = (text) => `https://wa.me/?text=${encodeURIComponent(toWellFormed(text))}`;
