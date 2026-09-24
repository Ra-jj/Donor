const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI);
    console.log(`MongoDB Connected: ${conn.connection.host}`);

    // Mongoose builds indexes silently in the background; surface a failed build so the
    // one_active_donation_per_donor guarantee is never missing without anyone knowing
    const Request = require('../models/request.model');
    try {
      await Request.init();
    } catch (err) {
      console.error(`requests index build failed (${err.codeName || err.code}): ${err.message}. List donors with more than one accepted request: db.requests.aggregate([{ $match: { status: 'accepted' } }, { $group: { _id: '$matchedDonorId', n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }])`);
    }
  } catch (error) {
    console.error(`Error connecting to MongoDB: ${error.message}`);
    process.exit(1);
  }
};

module.exports = connectDB;
