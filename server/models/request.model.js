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
  },
  { timestamps: true }
);

// Create a 2dsphere index on the hospitalLocation field for geospatial queries
requestSchema.index({ hospitalLocation: '2dsphere' });

module.exports = mongoose.model('Request', requestSchema);
