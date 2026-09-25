const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const request = require('supertest');

// How production serves the built client, against a small fake build in a temp dir
// (CLIENT_DIST_DIR), so it runs without a client build: CI builds the client in another job.
// No database: none of these routes touch MongoDB.

const INDEX_HTML = '<!doctype html><html><head><title>Donor test build</title></head><body></body></html>';
const HASHED_CHUNK = 'index-AbC123_x.js';

// supertest dials 127.0.0.1, so bind there explicitly (see securityHeaders.test.js)
const listenOnLoopback = async (expressApp) => {
  const httpServer = http.createServer(expressApp);
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  return httpServer;
};

let distDir;
let server;

beforeAll(async () => {
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'donor-client-dist-'));
  fs.mkdirSync(path.join(distDir, 'assets'));
  fs.writeFileSync(path.join(distDir, 'index.html'), INDEX_HTML);
  fs.writeFileSync(path.join(distDir, 'sw.js'), "self.addEventListener('push', () => {});\n");
  fs.writeFileSync(path.join(distDir, 'assets', HASHED_CHUNK), 'export const answer = 42;\n');

  const previousNodeEnv = process.env.NODE_ENV;
  const previousClientDistDir = process.env.CLIENT_DIST_DIR;
  process.env.NODE_ENV = 'production';
  process.env.CLIENT_DIST_DIR = distDir;
  let productionApp;
  try {
    // A fresh copy of the app, built in production mode so the static routes are registered
    jest.isolateModules(() => {
      productionApp = require('../index');
    });
  } finally {
    process.env.NODE_ENV = previousNodeEnv;
    if (previousClientDistDir === undefined) delete process.env.CLIENT_DIST_DIR;
    else process.env.CLIENT_DIST_DIR = previousClientDistDir;
  }
  server = await listenOnLoopback(productionApp);
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (distDir) fs.rmSync(distDir, { recursive: true, force: true });
});

describe('production static serving of the client build', () => {
  it('should serve a hashed asset with a one-year immutable cache and the security headers', async () => {
    const res = await request(server).get(`/assets/${HASHED_CHUNK}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.headers['cache-control']).toContain('immutable');
    expect(res.headers['cache-control']).toContain('max-age=31536000');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('should answer a missing asset with a plain 404, not index.html or an HTML error page', async () => {
    const res = await request(server).get('/assets/RegisterPage-OldHash1.js');
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.text).toBe('Not Found');
    expect(res.headers['cache-control']).toBe('no-store');
    // helmet's CSP, not the "default-src 'none'" that Express's default error page would set
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
  });

  it('should also 404 a missing file in a subfolder of /assets', async () => {
    const res = await request(server).get('/assets/images/layers.png');
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).not.toMatch(/html/);
  });

  it.each(['/', '/index.html', '/dashboard', '/create-request'])('should serve index.html with max-age=0 for %s', async (url) => {
    const res = await request(server).get(url);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.text).toBe(INDEX_HTML);
    expect(res.headers['cache-control']).toBe('public, max-age=0');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
  });

  it('should keep root files such as sw.js at max-age=0', async () => {
    const res = await request(server).get('/sw.js');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.headers['cache-control']).toBe('public, max-age=0');
  });

  it('should still answer unknown API paths with a JSON 404 and known ones as before', async () => {
    const unknown = await request(server).get('/api/unknown');
    expect(unknown.statusCode).toBe(404);
    expect(unknown.headers['content-type']).toMatch(/application\/json/);
    expect(unknown.body).toEqual({ message: 'Not found' });

    const health = await request(server).get('/api/health');
    expect(health.statusCode).toBe(200);
    expect(health.body.status).toBe('ok');
  });
});
