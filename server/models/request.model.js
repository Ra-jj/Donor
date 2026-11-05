const mongoose = require('mongoose');

// declinedBy holds the ids of OTHER donors who declined. The server filters on it (a donor who
// declined no longer sees the request), but it must never leave the server, so it is dropped
// from every toJSON (res.json, socket emits) and toObject result. Queries, $addToSet and
// document getters (request.declinedBy) are unaffected.
// shareToken is dropped the same way: it opens the request's public page, so it goes only to the
// requester, and only where a controller sends it on purpose (createRequest, getShareLink).
const hideServerOnlyFields = (doc, ret) => {
  delete ret.declinedBy;
  delete ret.shareToken;
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
    // Set only on a request the server cancelled itself: 'expired' when it was still pending
    // REQUEST_OPEN_HOURS after it was created (utils/requestExpiry.js). Absent on every other one.
    closedReason: {
      type: String,
      enum: ['expired'],
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
    // The random code in the link to this request's public page (utils/shareToken.js). Set when the
    // request is created; a request from before links existed gets one when its requester first
    // shares it. No default: a default would also fill it in, unsaved, on every older request read.
    // Never set to null, which the sparse index below would count as a value.
    shareToken: {
      type: String,
    },
  },
  {
    timestamps: true,
    toJSON: { transform: hideServerOnlyFields },
    toObject: { transform: hideServerOnlyFields },
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

// Serves the expiry sweep (utils/requestExpiry.js): pending requests created before a cutoff, a
// range that is empty or nearly so between sweeps
requestSchema.index({ status: 1, createdAt: 1 });

// Finds a request by the token in its public link. Unique, so one link always means one request.
// Sparse: requests without a token (those from before links existed) are not in it at all.
requestSchema.index({ shareToken: 1 }, { unique: true, sparse: true, name: 'share_token' });

module.exports = mongoose.model('Request', requestSchema);
