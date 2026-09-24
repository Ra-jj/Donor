const mongoose = require('mongoose');

const requestSchema = new mongoose.Schema(
  {
    requesterId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
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
  { timestamps: true }
);

// Create a 2dsphere index on the hospitalLocation field for geospatial queries
requestSchema.index({ hospitalLocation: '2dsphere' });

// A donor can give blood once per donation window: MongoDB rejects a second 'accepted' request for the same donor (E11000)
requestSchema.index(
  { matchedDonorId: 1 },
  { unique: true, partialFilterExpression: { status: 'accepted' }, name: 'one_active_donation_per_donor' }
);

module.exports = mongoose.model('Request', requestSchema);
