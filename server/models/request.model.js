const mongoose = require('mongoose');

// declinedBy holds the ids of OTHER donors who declined. The server filters on it (a donor who
// declined no longer sees the request), but it must never leave the server, so it is dropped
// from every toJSON (res.json, socket emits) and toObject result. Queries, $addToSet and
// document getters (request.declinedBy) are unaffected.
const hideDeclinedBy = (doc, ret) => {
  delete ret.declinedBy;
  return ret;
};

const requestSchema = new mongoose.Schema(
  {
    // null only on a fulfilled request whose requester deleted their account: the donation is
    // kept, anonymised, for the donor's history, stats and donation gap (see deleteAccount in
    // user.controller.js). Every other request of that user is deleted, so it is required there.
    requesterId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: function () {
        return this.status !== 'fulfilled';
      },
    },
    bloodGroup: {
      type: String,
      required: true,
      enum: ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'],
    },
    unitsNeeded: {
      type: Number,
      required: true,
      min: 1,
    },
    hospitalName: {
      type: String,
      required: true,
      trim: true,
    },
    // IMPORTANT: MongoDB expects GeoJSON coordinates in the order [longitude, latitude]!
    // Do NOT use [latitude, longitude].
    hospitalLocation: {
      type: {
        type: String,
        enum: ['Point'],
        required: true,
        default: 'Point',
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
        required: true,
      },
    },
    urgency: {
      type: String,
      enum: ['low', 'medium', 'high'],
      default: 'medium',
    },
    status: {
      type: String,
      enum: ['pending', 'accepted', 'fulfilled', 'cancelled'],
      default: 'pending',
    },
    // Also null on a fulfilled or cancelled request whose donor deleted their account
    matchedDonorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    declinedBy: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    }],
    fulfilledAt: {
      type: Date,
      default: null,
    },
    rating: {
      type: Number,
      min: 1,
      max: 5,
      default: null,
    },
    ratingNote: {
      type: String,
      default: '',
      trim: true,
      maxlength: 500,
    },
  },
  {
    timestamps: true,
    toJSON: { transform: hideDeclinedBy },
    toObject: { transform: hideDeclinedBy },
  }
);

// Create a 2dsphere index on the hospitalLocation field for geospatial queries
requestSchema.index({ hospitalLocation: '2dsphere' });

// A donor can give blood once per donation window: MongoDB rejects a second 'accepted' request for the same donor (E11000)
requestSchema.index(
  { matchedDonorId: 1 },
  { unique: true, partialFilterExpression: { status: 'accepted' }, name: 'one_active_donation_per_donor' }
);

// Serves findNextEligibleDonationAt in utils/donationGap.js: one donor's latest fulfilled request, newest first
requestSchema.index({ matchedDonorId: 1, status: 1, fulfilledAt: -1 });

// Serves createRequest's distinct busy-or-resting donor query: an index scan per $or branch instead of a collection scan
requestSchema.index({ status: 1, fulfilledAt: 1, matchedDonorId: 1 });

module.exports = mongoose.model('Request', requestSchema);
