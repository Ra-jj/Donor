// The hospital name a requester sends with a New Request (CreateRequestPage). The server decides
// what it accepts (createRequestSchema in server/validators/requestValidator.js); this only keeps
// the form inside that, so a long name never comes back as an error.

// Same value as the server's MAX_HOSPITAL_NAME_LENGTH; server/tests/request.test.js checks it.
// Counted in UTF-16 code units, as both maxLength and the server's check count them.
export const MAX_HOSPITAL_NAME_LENGTH = 150;

/**
 * A place name from the hospital search, cut to MAX_HOSPITAL_NAME_LENGTH when it is longer. It
 * fills the name field, which maxLength does not shorten when the value is set by the page. The
 * cut never splits a character made of two code units (an emoji, for example).
 * @param {string} name
 */
export const fitHospitalName = (name) => {
  if (name.length <= MAX_HOSPITAL_NAME_LENGTH) return name;
  const lastKeptCode = name.charCodeAt(MAX_HOSPITAL_NAME_LENGTH - 1);
  const isFirstHalfOfPair = lastKeptCode >= 0xd800 && lastKeptCode <= 0xdbff;
  return name.slice(0, isFirstHalfOfPair ? MAX_HOSPITAL_NAME_LENGTH - 1 : MAX_HOSPITAL_NAME_LENGTH).trimEnd();
};
