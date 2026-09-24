const path = require('path');
const { spawnSync } = require('child_process');
const { findMissingEnvVars, REQUIRED_ENV_VARS, PUSH_ENV_VARS } = require('../config/env');

const SERVER_DIR = path.join(__dirname, '..');

describe('findMissingEnvVars', () => {
  it('should require JWT_SECRET and MONGO_URI, and report both when neither is set', () => {
    expect(REQUIRED_ENV_VARS).toEqual(['JWT_SECRET', 'MONGO_URI']);
    expect(findMissingEnvVars({})).toEqual(['JWT_SECRET', 'MONGO_URI']);
  });

  it('should report only the missing variable', () => {
    expect(findMissingEnvVars({ JWT_SECRET: 'some-secret' })).toEqual(['MONGO_URI']);
    expect(findMissingEnvVars({ MONGO_URI: 'mongodb://localhost/donor' })).toEqual(['JWT_SECRET']);
  });

  it('should treat empty and whitespace-only values as missing', () => {
    expect(findMissingEnvVars({ JWT_SECRET: '', MONGO_URI: '   ' })).toEqual(['JWT_SECRET', 'MONGO_URI']);
  });

  it('should return an empty list when every required variable is set', () => {
    expect(findMissingEnvVars({ JWT_SECRET: 'some-secret', MONGO_URI: 'mongodb://localhost/donor' })).toEqual([]);
  });

  it('should return names only, never values', () => {
    const secretValue = 'value-that-must-never-be-printed';
    const missing = findMissingEnvVars({ JWT_SECRET: secretValue, MONGO_URI: '' });
    expect(missing).toEqual(['MONGO_URI']);
    expect(JSON.stringify(missing)).not.toContain(secretValue);
  });

  it('should check the optional push keys only when asked to', () => {
    const requiredOnly = { JWT_SECRET: 'some-secret', MONGO_URI: 'mongodb://localhost/donor' };
    expect(findMissingEnvVars(requiredOnly)).toEqual([]);
    expect(findMissingEnvVars(requiredOnly, PUSH_ENV_VARS)).toEqual(['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY']);
    expect(findMissingEnvVars({ ...requiredOnly, VAPID_PUBLIC_KEY: 'public', VAPID_PRIVATE_KEY: 'private' }, PUSH_ENV_VARS)).toEqual([]);
  });
});

describe('server startup without required config', () => {
  it('should make index.js exit 1 naming the missing variable, without printing any value', () => {
    const secretValue = 'value-that-must-never-be-printed';
    // '' rather than absent: dotenv never overwrites a variable that is already set, so a
    // developer's server/.env cannot fill MONGO_URI in. The process exits before connecting.
    const result = spawnSync(process.execPath, ['index.js'], {
      cwd: SERVER_DIR,
      env: { JWT_SECRET: secretValue, MONGO_URI: '' },
      encoding: 'utf8',
      timeout: 10000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing required environment variables: MONGO_URI');
    expect(result.stdout + result.stderr).not.toContain(secretValue);
  }, 15000);
});
