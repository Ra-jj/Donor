const { getFirstName, MAX_FIRST_NAME_LENGTH, FIRST_NAME_FALLBACK } = require('../utils/firstName');

// What a push notification shows of the requester's name (sendNewRequestAlerts in
// controllers/request.controller.js): the first word, capped, or a fallback.

// Splits a string the way a reader sees it, to check where a cut landed
const graphemesOf = (text) =>
  Array.from(new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text), ({ segment }) => segment);

describe('getFirstName', () => {
  it('keeps only the first word of a name with several', () => {
    expect(getFirstName('Rita Requester')).toBe('Rita');
    expect(getFirstName('Mary Ann Smith')).toBe('Mary');
    // A hyphen or an apostrophe is part of the word
    expect(getFirstName("Jean-Luc O'Brien")).toBe('Jean-Luc');
  });

  it('returns a one-word name as it is', () => {
    expect(getFirstName('Raj')).toBe('Raj');
  });

  it('ignores spaces around the name and treats any run of whitespace as one gap, Unicode spaces too', () => {
    expect(getFirstName('   Rita    Requester  ')).toBe('Rita');
    expect(getFirstName('\tRita\n\nRequester')).toBe('Rita');
    // No-break space, ideographic space and em space, before and inside the name
    expect(getFirstName('\u00A0Rita\u3000Sen')).toBe('Rita');
    expect(getFirstName('\u2003\u00A0Anil\u2003\u2003Kumar')).toBe('Anil');
  });

  it('keeps emoji whole, inside the first word or as a word of their own', () => {
    expect(getFirstName('\u{1FA78}Rita Sen')).toBe('\u{1FA78}Rita');
    // Woman health worker: woman, zero-width joiner, staff of Aesculapius, variation selector
    expect(getFirstName('\u{1F469}\u200D\u2695\uFE0F Priya')).toBe('\u{1F469}\u200D\u2695\uFE0F');
    expect(getFirstName('Priya \u{1F469}\u200D\u2695\uFE0F')).toBe('Priya');
  });

  it('keeps names in Indian scripts, with their vowel signs', () => {
    // Priya Sharma, in Devanagari; Ananya Bose, in Bengali
    expect(getFirstName('\u092A\u094D\u0930\u093F\u092F\u093E \u0936\u0930\u094D\u092E\u093E')).toBe('\u092A\u094D\u0930\u093F\u092F\u093E');
    expect(getFirstName('\u0985\u09A8\u09A8\u09CD\u09AF\u09BE \u09AC\u09B8\u09C1')).toBe('\u0985\u09A8\u09A8\u09CD\u09AF\u09BE');
  });

  it('skips a title before the name, in any letter case, with or without its dot', () => {
    expect(getFirstName('Dr. Rita Sen')).toBe('Rita');
    expect(getFirstName('dr rita sen')).toBe('rita');
    expect(getFirstName('DR. Rita')).toBe('Rita');
    expect(getFirstName('Mr Anil Kumar')).toBe('Anil');
    expect(getFirstName('Mrs. Bina Das')).toBe('Bina');
    expect(getFirstName('ms. Tara')).toBe('Tara');
    expect(getFirstName('Shri Anil Kumar')).toBe('Anil');
    expect(getFirstName('Smt. Priya Sharma')).toBe('Priya');
    expect(getFirstName('SRI Lakshmi')).toBe('Lakshmi');
    expect(getFirstName('Kumari Selja')).toBe('Selja');
    expect(getFirstName('Prof. Uma Rao')).toBe('Uma');
    // Several titles, and extra spaces between them
    expect(getFirstName('  Prof.   Dr.  Rita Sen')).toBe('Rita');
    // A stray dot typed apart from its title
    expect(getFirstName('Dr . Rita')).toBe('Rita');
    expect(getFirstName('- Rita')).toBe('Rita');
  });

  it('keeps a title when no other word follows it, and words that only start like one', () => {
    expect(getFirstName('Dr.')).toBe('Dr.');
    expect(getFirstName('  Smt  ')).toBe('Smt');
    expect(getFirstName('Dr. Prof.')).toBe('Prof.');
    expect(getFirstName('Drew Barry')).toBe('Drew');
    expect(getFirstName('Mr.Bean Sen')).toBe('Mr.Bean');
    expect(getFirstName('Dr.. Rita')).toBe('Dr..');
    expect(getFirstName('Professor Rita')).toBe('Professor');
  });

  it(`falls back to "${FIRST_NAME_FALLBACK}" when there is no word at all`, () => {
    expect(getFirstName('')).toBe(FIRST_NAME_FALLBACK);
    expect(getFirstName('   ')).toBe(FIRST_NAME_FALLBACK);
    expect(getFirstName('\u00A0\t\n')).toBe(FIRST_NAME_FALLBACK);
    expect(getFirstName(null)).toBe(FIRST_NAME_FALLBACK);
    expect(getFirstName(undefined)).toBe(FIRST_NAME_FALLBACK);
  });

  it(`keeps a first word of exactly ${MAX_FIRST_NAME_LENGTH} characters, and cuts a longer one to that many with "…"`, () => {
    expect(MAX_FIRST_NAME_LENGTH).toBe(30);
    const longest = 'A'.repeat(MAX_FIRST_NAME_LENGTH);
    expect(getFirstName(`${longest} Sen`)).toBe(longest);
    expect(getFirstName(`${longest}B Sen`)).toBe(`${'A'.repeat(MAX_FIRST_NAME_LENGTH - 1)}…`);
    // Names have no length limit, and one this long has no space to stop at
    const cut = getFirstName('B'.repeat(5000));
    expect(cut).toBe(`${'B'.repeat(MAX_FIRST_NAME_LENGTH - 1)}…`);
    expect(cut).toHaveLength(MAX_FIRST_NAME_LENGTH);
  });

  it('never splits a surrogate pair, an emoji sequence or a letter from its vowel sign when it cuts', () => {
    // 40 drops of blood: each one is a surrogate pair, so a cut by UTF-16 unit could split one
    const drops = '\u{1FA78}'.repeat(40);
    // 40 woman health workers: 5 UTF-16 units each, so a cut by code point could split one too
    const healthWorkers = '\u{1F469}\u200D\u2695\uFE0F'.repeat(40);
    // "Priya" in Devanagari, 20 times over: 2 graphemes and 6 code points each
    const devanagari = '\u092A\u094D\u0930\u093F\u092F\u093E'.repeat(20);

    [drops, healthWorkers, devanagari].forEach((word) => {
      const cut = getFirstName(word);
      expect(cut.isWellFormed()).toBe(true);
      expect(cut.endsWith('…')).toBe(true);
      const kept = cut.slice(0, -1);
      expect(graphemesOf(kept)).toEqual(graphemesOf(word).slice(0, MAX_FIRST_NAME_LENGTH - 1));
      expect(graphemesOf(cut)).toHaveLength(MAX_FIRST_NAME_LENGTH);
    });
  });
});
