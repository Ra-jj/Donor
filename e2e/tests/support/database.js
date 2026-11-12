// The one change the tests make directly in the database, for the consent screen test.
//
// A user must agree again when the Privacy Notice's version changes, which in production happens
// with a deploy, never through the API. So the test signs a user up normally and then sets the
// version they agreed to back to an older one, as if the notice had changed since.
//
// Only ever the in-memory MongoDB of this run: its URI comes from the line the e2e server prints
// when it is ready (playwright.config.js puts it in E2E_MONGO_URI), and any URI that is not on
// 127.0.0.1 or does not name the run's own replica set is refused. That also rules out another
// mongod on this machine, such as one on port 27018.
import { createRequire } from 'node:module';
import { TEST_REPLICA_SET_NAME } from '../../scripts/testDatabase.js';

// The MongoDB driver bundled with the server's own Mongoose, so the e2e package needs no copy
const serverRequire = createRequire(new URL('../../../server/package.json', import.meta.url));
const { MongoClient, ObjectId } = serverRequire('mongoose').mongo;

const OLDER_NOTICE_VERSION = '2020-01-01';

const connectToTestDatabase = async () => {
  const uri = process.env.E2E_MONGO_URI;
  if (!uri) {
    throw new Error('E2E_MONGO_URI is not set. Run the tests with `npm test` in e2e/, whose web server sets it.');
  }
  const { hostname, searchParams } = new URL(uri);
  const replicaSetName = searchParams.get('replicaSet');
  if (hostname !== '127.0.0.1' || replicaSetName !== TEST_REPLICA_SET_NAME) {
    throw new Error(
      `Refusing to write to host ${hostname}, replica set ${replicaSetName}: only the run's in-memory MongoDB ` +
        `(127.0.0.1, replica set ${TEST_REPLICA_SET_NAME}) may be changed.`,
    );
  }
  return MongoClient.connect(uri, { serverSelectionTimeoutMS: 5000 });
};

/** Makes the user's recorded agreement an older notice version's, so the app asks them again */
export const makePrivacyConsentOutOfDate = async (userId) => {
  const client = await connectToTestDatabase();
  try {
    const result = await client
      .db()
      .collection('users')
      .updateOne({ _id: new ObjectId(userId) }, { $set: { 'privacyConsent.version': OLDER_NOTICE_VERSION } });
    if (result.modifiedCount !== 1) {
      throw new Error(`Expected to change one user's privacy consent, changed ${result.modifiedCount} (user ${userId}).`);
    }
  } finally {
    await client.close();
  }
};
