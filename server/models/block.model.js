const mongoose = require('mongoose');

// One user blocking another (controllers/block.controller.js). A block works both ways: neither
// user is matched with the other (no incoming requests, no alerts, no accepts), whichever of them
// made it. Only the blocker ever sees it, in their Profile; the blocked user is never told.
// Deleted when the blocker unblocks, or when either user deletes their account (deleteAccount in
// user.controller.js).
const blockSchema = new mongoose.Schema(
  {
    blockerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    blockedId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  // createdAt is the date the blocker sees in Profile; nothing ever changes a block, so no updatedAt
  { timestamps: { createdAt: true, updatedAt: false } }
);

// One block per blocker and blocked user, even when two blocks are sent at once (E11000). Also
// serves a blocker's own list, their block count (MAX_BLOCKS_PER_USER in utils/blocks.js), and the
// blockerId branch of findBlockedPairUserIds.
blockSchema.index({ blockerId: 1, blockedId: 1 }, { unique: true, name: 'one_block_per_pair' });

// The other branch of findBlockedPairUserIds: everyone who blocked one user. Both branches only
// read these two fields, so each is answered from its index alone.
blockSchema.index({ blockedId: 1, blockerId: 1 });

module.exports = mongoose.model('Block', blockSchema);
