/**
 * The requester's name as a push notification shows it: the first word only, after any title such
 * as "Dr." or "Smt.", which would say nothing about who is asking. A push can appear on a locked
 * phone's screen, where anyone near it can read it (sendNewRequestAlerts in
 * controllers/request.controller.js). Inside the app, nearby donors still get the full name.
 *
 * Names have no length limit (validators/authValidator.js), so a first word longer than
 * MAX_FIRST_NAME_LENGTH is cut, and ends with "…". Length is counted in what a reader sees as one
 * character (a grapheme, by Intl.Segmenter), so a cut never splits a surrogate pair, an emoji made
 * of several code points, or a Devanagari or Bengali letter from its vowel sign.
 */

const MAX_FIRST_NAME_LENGTH = 30;
// When the name has no word at all
const FIRST_NAME_FALLBACK = 'Someone';

// A title before the name ("Dr. Rita Sen", "Smt Priya"), in any letter case, with or without its
// dot. Skipped only while another word follows it, so a name that is just "Dr." stays as it is.
const HONORIFIC_PATTERN = /^(dr|mr|mrs|ms|shri|smt|sri|kumari|prof)\.?$/i;

const graphemeSegmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

/**
 * @param {unknown} name - a user's name, as stored
 * @returns {string} its first word after any titles: trimmed, split at any run of whitespace
 * (Unicode spaces included), at most MAX_FIRST_NAME_LENGTH graphemes with the "…", or
 * FIRST_NAME_FALLBACK
 */
const getFirstName = (name) => {
  const words = String(name ?? '').trim().split(/\s+/);
  // A word that is only punctuation ("Dr . Rita") is skipped the same way
  while (words.length > 1 && (HONORIFIC_PATTERN.test(words[0]) || /^\p{P}+$/u.test(words[0]))) words.shift();
  const [firstWord] = words;
  if (!firstWord) return FIRST_NAME_FALLBACK;

  const graphemes = Array.from(graphemeSegmenter.segment(firstWord), ({ segment }) => segment);
  if (graphemes.length <= MAX_FIRST_NAME_LENGTH) return firstWord;
  return `${graphemes.slice(0, MAX_FIRST_NAME_LENGTH - 1).join('')}…`;
};

module.exports = { getFirstName, MAX_FIRST_NAME_LENGTH, FIRST_NAME_FALLBACK };
