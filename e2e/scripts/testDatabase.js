// The replica set name of the in-memory MongoDB that scripts/start-server.js starts. Its own name,
// not mongodb-memory-server's default 'testset', so tests/support/database.js can tell this run's
// database from any other mongod on the machine and refuse to write anywhere else.
export const TEST_REPLICA_SET_NAME = 'donor-e2e';
