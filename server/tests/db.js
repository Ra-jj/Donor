const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let replSet;

const connectDB = async () => {
  // Transactions need a replica set (a standalone mongod rejects them), and production
  // runs on an Atlas replica set. One wiredTiger member is enough for the tests.
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  const uri = replSet.getUri();
  // mongodb driver 7.6 loads `os` with a dynamic import(), which Jest rejects outside ESM mode, so
  // the handshake loses its client metadata and mongod refuses every connection (NODE-7832).
  // Passing Node's own `os` avoids that; remove once the driver fixes it. The short server
  // selection timeout makes a failed connect show the real error inside Jest's 5s hook limit.
  await mongoose.connect(uri, { runtimeAdapters: { os: require('os') }, serverSelectionTimeoutMS: 4000 });
};

const closeDB = async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.connection.close();
  if (replSet) {
    await replSet.stop();
  }
};

const clearDB = async () => {
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    const collection = collections[key];
    await collection.deleteMany();
  }
};

module.exports = { connectDB, closeDB, clearDB };
