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
    lastDonationDate: {
      type: Date,
      default: null,
    },
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
