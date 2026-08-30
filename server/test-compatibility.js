const mongoose = require('mongoose');
const dotenv = require('dotenv');
const User = require('../server/models/user.model');
const Request = require('../server/models/request.model');
const { getCompatibleDonorGroups } = require('../server/utils/bloodCompatibility');

dotenv.config({ path: '../server/.env' });

const testMatching = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('📦 Connected to MongoDB');

    // 1. Clear existing test users created by this script
    await User.deleteMany({ email: { $regex: /test_matching_/ } });
    
    // 2. Create 8 dummy donors (one for each blood group) in the same location
    const bloodGroups = ['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+'];
    const location = { type: 'Point', coordinates: [77.5946, 12.9716] }; // Bangalore
    
    const donors = await Promise.all(bloodGroups.map(bg => 
      User.create({
        name: `Test Donor ${bg}`,
        email: `test_matching_${bg.toLowerCase().replace('+','p').replace('-','n')}@example.com`,
        password: 'password123',
        bloodGroup: bg,
        location,
        isAvailable: true
      })
    ));

    console.log(`✅ Created ${donors.length} test donors (one of each blood group)`);

    // 3. Create a hospital user to act as requester
    const requester = await User.create({
      name: 'Test Hospital',
      email: 'test_matching_hospital@example.com',
      password: 'password123',
      bloodGroup: 'O+',
      location,
      isAvailable: true
    });

    console.log(`✅ Created test hospital (Requester ID: ${requester._id})`);

    // Helper to simulate request creation logic without hitting the HTTP endpoint
    // since we want to specifically test the DB query logic in isolation
    const simulateRequestMatching = async (requestedGroup) => {
      const radiusInRadians = 15 / 6378.1;
      const compatibleDonorGroups = getCompatibleDonorGroups(requestedGroup);
      
      const matchedDonors = await User.find({
        _id: { $ne: requester._id },
        bloodGroup: { $in: compatibleDonorGroups },
        email: { $regex: /test_matching_/ }, // Only check our test donors to avoid interference from existing users
        isAvailable: true,
        location: {
          $geoWithin: {
            $centerSphere: [location.coordinates, radiusInRadians],
          },
        },
      });
      return matchedDonors;
    };

    // TEST 1: AB+ Request (Universal Recipient)
    console.log('\n--- TEST 1: Requesting AB+ (Universal Recipient) ---');
    const abMatches = await simulateRequestMatching('AB+');
    console.log(`Matches found: ${abMatches.length}`);
    if (abMatches.length === 8) {
      console.log('✅ PASS: AB+ matched with ALL 8 blood groups.');
    } else {
      console.log('❌ FAIL: AB+ did not match with all 8 blood groups.');
      console.log('Matched groups:', abMatches.map(d => d.bloodGroup));
    }

    // TEST 2: O- Request (Universal Donor, but can only receive O-)
    console.log('\n--- TEST 2: Requesting O- (Can only receive O-) ---');
    const oNegMatches = await simulateRequestMatching('O-');
    console.log(`Matches found: ${oNegMatches.length}`);
    if (oNegMatches.length === 1 && oNegMatches[0].bloodGroup === 'O-') {
      console.log('✅ PASS: O- matched ONLY with O- donor.');
    } else {
      console.log('❌ FAIL: O- matched incorrectly.');
      console.log('Matched groups:', oNegMatches.map(d => d.bloodGroup));
    }

    // TEST 3: A+ Request (Can receive from O-, O+, A-, A+)
    console.log('\n--- TEST 3: Requesting A+ (Can receive O-, O+, A-, A+) ---');
    const aPosMatches = await simulateRequestMatching('A+');
    console.log(`Matches found: ${aPosMatches.length}`);
    const aPosGroups = aPosMatches.map(d => d.bloodGroup).sort();
    const expectedAPos = ['A+', 'A-', 'O+', 'O-'].sort();
    if (JSON.stringify(aPosGroups) === JSON.stringify(expectedAPos)) {
      console.log('✅ PASS: A+ matched correctly with O-, O+, A-, A+.');
    } else {
      console.log('❌ FAIL: A+ matched incorrectly.');
      console.log('Matched groups:', aPosGroups);
    }

    // Cleanup
    console.log('\n🧹 Cleaning up test users...');
    await User.deleteMany({ email: { $regex: /test_matching_/ } });
    console.log('✅ Cleanup complete');

  } catch (error) {
    console.error('Test script error:', error);
  } finally {
    mongoose.disconnect();
    process.exit();
  }
};

testMatching();
