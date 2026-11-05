/**
 * Reads of the blocks between users (models/block.model.js). A block works both ways, so every
 * check here looks at both directions: who this user blocked, and who blocked them.
 */
const Block = require('../models/block.model');

// The most people one user can block. Only the blocks a user makes are capped, which keeps their
// own list bounded; how many people block one user is not (each of those is another user's own
// block). block.controller.js enforces it after the write, so two blocks sent at once can never
// take a user past it.
const MAX_BLOCKS_PER_USER = 200;

/**
 * The ids of every user in a block with this one, in either direction. Two index-only scans on
 * models/block.model.js's indexes.
 * @param {import('mongoose').Types.ObjectId | string} userId
 * @returns {Promise<import('mongoose').Types.ObjectId[]>}
 */
const findBlockedPairUserIds = async (userId) => {
  const blocks = await Block.find({ $or: [{ blockerId: userId }, { blockedId: userId }] })
    .select('blockerId blockedId -_id')
    .lean();
  return blocks.map((block) => (String(block.blockerId) === String(userId) ? block.blockedId : block.blockerId));
};

/**
 * Whether either of two users has blocked the other
 * @param {import('mongoose').Types.ObjectId | string} firstUserId
 * @param {import('mongoose').Types.ObjectId | string} secondUserId
 * @returns {Promise<boolean>}
 */
const isBlockedPair = async (firstUserId, secondUserId) =>
  Boolean(
    await Block.exists({
      $or: [
        { blockerId: firstUserId, blockedId: secondUserId },
        { blockerId: secondUserId, blockedId: firstUserId },
      ],
    })
  );

module.exports = {
  MAX_BLOCKS_PER_USER,
  findBlockedPairUserIds,
  isBlockedPair,
};
