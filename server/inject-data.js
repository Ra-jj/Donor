const mongoose = require('mongoose');
const dotenv = require('dotenv');
const User = require('../server/models/user.model');
const Request = require('../server/models/request.model');

dotenv.config({ path: '../server/.env' });

(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    
    // Find Ashish (the logged in user from previous screenshots)
    const ashish = await User.findOne({ name: 'Ashish' });
    if (!ashish) throw new Error("Could not find user Ashish");
    
    // Clear old test requests for this demo
    await Request.deleteMany({ hospitalName: { $regex: /Demo Hospital/ } });

    // Create a dummy requester
    let dummyRequester = await User.findOne({ email: 'dummy_requester@test.com' });
    if (!dummyRequester) {
      dummyRequester = await User.create({
        name: 'City Hospital',
        email: 'dummy_requester@test.com',
        password: 'password123',
        bloodGroup: 'B+',
        location: ashish.location, // Same location so it matches radius
      });
    }

    // Inject two requests that Ashish (O+) is eligible for
    await Request.create([
      {
        requesterId: dummyRequester._id,
        bloodGroup: 'O+', // Exact match for Ashish (O+)
        unitsNeeded: 2,
        hospitalName: 'Apollo Demo Hospital (Exact)',
        hospitalLocation: ashish.location,
        urgency: 'high',
        status: 'pending'
      },
      {
        requesterId: dummyRequester._id,
        bloodGroup: 'AB+', // Compatible match for Ashish (O+)
        unitsNeeded: 1,
        hospitalName: 'Fortis Demo Hospital (Compatible)',
        hospitalLocation: ashish.location,
        urgency: 'medium',
        status: 'pending'
      }
    ]);

    console.log("✅ Injected demo requests for Ashish (O+).");
    console.log("Please refresh your browser dashboard to see the badges!");

  } catch (err) {
    console.error("Error:", err.message);
  } finally {
    mongoose.disconnect();
  }
})();
