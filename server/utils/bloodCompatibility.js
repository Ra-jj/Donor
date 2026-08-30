/**
 * Blood Compatibility Logic
 * 
 * This module encodes standard medical rules for blood donation compatibility.
 * 
 * Rules for Blood Types (ABO System + Rh Factor):
 * 1. O-  can give to anyone (Universal Donor) but can only receive from O-.
 * 2. O+  can give to any positive blood type (O+, A+, B+, AB+).
 * 3. A-  can give to A-, A+, AB-, AB+.
 * 4. A+  can give to A+, AB+.
 * 5. B-  can give to B-, B+, AB-, AB+.
 * 6. B+  can give to B+, AB+.
 * 7. AB- can give to AB-, AB+.
 * 8. AB+ can only give to AB+, but can receive from anyone (Universal Recipient).
 */

// Maps a DONOR's blood group to the RECIPIENTS they can give to.
const donorToRecipients = {
    'O-': ['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+'],
    'O+': ['O+', 'A+', 'B+', 'AB+'],
    'A-': ['A-', 'A+', 'AB-', 'AB+'],
    'A+': ['A+', 'AB+'],
    'B-': ['B-', 'B+', 'AB-', 'AB+'],
    'B+': ['B+', 'AB+'],
    'AB-': ['AB-', 'AB+'],
    'AB+': ['AB+']
};
  
// Maps a RECIPIENT's blood group to the DONORS they can receive from.
const recipientToDonors = {
    'O-': ['O-'],
    'O+': ['O-', 'O+'],
    'A-': ['O-', 'A-'],
    'A+': ['O-', 'O+', 'A-', 'A+'],
    'B-': ['O-', 'B-'],
    'B+': ['O-', 'O+', 'B-', 'B+'],
    'AB-': ['O-', 'A-', 'B-', 'AB-'],
    'AB+': ['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+']
};

/**
 * Checks if a specific donor can give blood to a specific recipient.
 * @param {string} donorGroup - The donor's blood group (e.g., 'O-')
 * @param {string} recipientGroup - The recipient's blood group (e.g., 'A+')
 * @returns {boolean} True if compatible, false otherwise
 */
const isCompatibleDonor = (donorGroup, recipientGroup) => {
    if (!donorToRecipients[donorGroup]) return false;
    return donorToRecipients[donorGroup].includes(recipientGroup);
};

/**
 * Returns an array of donor blood groups compatible with the given recipient.
 * Useful for querying the database for all valid donors for a request.
 * @param {string} recipientGroup - The recipient's blood group
 * @returns {string[]} Array of compatible donor blood groups
 */
const getCompatibleDonorGroups = (recipientGroup) => {
    return recipientToDonors[recipientGroup] || [];
};

/**
 * Returns an array of recipient blood groups a given donor can donate to.
 * Useful for finding all valid incoming requests for a donor's dashboard.
 * @param {string} donorGroup - The donor's blood group
 * @returns {string[]} Array of compatible recipient blood groups
 */
const getCompatibleRecipientGroups = (donorGroup) => {
    return donorToRecipients[donorGroup] || [];
};

module.exports = {
    isCompatibleDonor,
    getCompatibleDonorGroups,
    getCompatibleRecipientGroups,
    donorToRecipients,
    recipientToDonors
};
