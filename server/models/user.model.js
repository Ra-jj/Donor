const mongoose = require('mongoose');

// One agreement to the privacy notice. Both fields are always written together, so an agreement
// never exists without its version or its time.
const privacyConsentSchema = new mongoose.Schema(
  {
    version: { type: String, required: true },
    // The server's clock when the user agreed
    acceptedAt: { type: Date, required: true },
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    password: {
      type: String,
      required: true,
      minlength: 6,
    },
    bloodGroup: {
      type: String,
      required: true,
      enum: ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'],
    },
    // IMPORTANT: MongoDB expects GeoJSON coordinates in the order [longitude, latitude]!
    // Do NOT use [latitude, longitude].
    location: {
      type: {
        type: String,
        enum: ['Point'],
        required: true,
        default: 'Point',
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
        required: true,
        default: [0, 0],
      },
    },
    pushSubscription: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    // A whole-blood donation the donor made OUTSIDE this app (hospital, blood camp), entered by
    // them on the Profile page; null if they have not given one. It is NOT their last donation
    // overall: donations completed through the app are read from fulfilled Requests and never
    // copied here (see utils/donationGap.js, which takes the more recent of the two).
    // A calendar date, not an instant: stored as 00:00 UTC of the date picked, which is 05:30
    // IST on that same date, so the IST calendar day the gap rules use is the date the donor chose.
    lastOutsideDonationDate: {
      type: Date,
      default: null,
    },
    // ONLY the donor's own choice, set from the Profile toggle. Nothing else writes it.
    // "Busy" is derived, never stored here: a donor holding a Request with status 'accepted'
    // and matchedDonorId set to them is busy, and createRequest skips them even when this is true.
    // The minimum gap after a donation is derived the same way (utils/donationGap.js) and never
    // writes this either.
    isAvailable: {
      type: Boolean,
      default: true,
    },
    profilePic: {
      type: String,
      default: '',
    },
    // The privacy notice version this user last agreed to, and when; null for an account created
    // before consent was recorded. Written only by sign-up and POST /api/users/privacy-consent,
    // from utils/privacyConsent.js, never from a request body: PATCH /api/users/profile cannot
    // reach it (its validator drops unknown fields and updateProfile copies named fields only).
    // Deleting the account deletes this document, and the record with it.
    privacyConsent: {
      type: privacyConsentSchema,
      default: null,
    },
    // When the user confirmed they are 18 or older, set with every agreement above
    adultConfirmedAt: {
      type: Date,
      default: null,
    },
    // Every agreement this user has given, oldest first, appended in the same write that sets
    // privacyConsent (utils/privacyConsent.js), so an agreement to an older version is still on
    // record after a new one replaces privacyConsent. Repeating an agreement already recorded adds
    // nothing. Never sent to anyone, the user included (withDonationEligibility leaves it out),
    // and deleted with this document.
    privacyConsentHistory: {
      type: [privacyConsentSchema],
      // Not []: a stale document saved later would write [] over entries added since it was loaded
      default: undefined,
    },
  },
  { timestamps: true }
);

// Create a 2dsphere index on the location field for geospatial queries ($near, $geoNear)
userSchema.index({ location: '2dsphere' });

module.exports = mongoose.model('User', userSchema);
