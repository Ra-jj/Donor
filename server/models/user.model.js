const mongoose = require('mongoose');

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
  },
  { timestamps: true }
);

// Create a 2dsphere index on the location field for geospatial queries ($near, $geoNear)
userSchema.index({ location: '2dsphere' });

module.exports = mongoose.model('User', userSchema);
