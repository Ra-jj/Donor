const http = require('http');
const express = require('express');
const request = require('supertest');
const app = require('../index');
const { buildCspDirectives } = require('../middleware/securityHeaders');
const { parseTrustProxy } = require('../utils/parseTrustProxy');

// No database: /api/health and /api/debug/ip never touch MongoDB.
// supertest dials 127.0.0.1, so bind there explicitly. request(app) binds `::`, and another
// local app on the same ephemeral port can answer instead.
const listenOnLoopback = async (expressApp) => {
  const httpServer = http.createServer(expressApp);
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  return httpServer;
};

let server;

beforeAll(async () => {
  server = await listenOnLoopback(app);
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('security headers on /api/health', () => {
  it('should send a CSP with frame-ancestors, X-Content-Type-Options, and no X-Powered-By', async () => {
    const res = await request(server).get('/api/health');
    expect(res.statusCode).toBe(200);

    const csp = res.headers['content-security-policy'];
    expect(csp).toBeDefined();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self';");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("connect-src 'self' ws: wss: https://nominatim.openstreetmap.org");
    expect(csp).toContain("img-src 'self' data: blob: https://tile.openstreetmap.org");
    // Jest runs with NODE_ENV=test, so this production-only directive is absent
    expect(csp).not.toContain('upgrade-insecure-requests');

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('should add upgrade-insecure-requests only in production', () => {
    expect(buildCspDirectives({ isProduction: true }).upgradeInsecureRequests).toEqual([]);
    expect(buildCspDirectives({ isProduction: false }).upgradeInsecureRequests).toBeNull();
  });
});

describe('GET /api/debug/ip', () => {
  it('should not exist when DEBUG_IP_ENDPOINT is not set', async () => {
    expect(process.env.DEBUG_IP_ENDPOINT).toBeUndefined();
    const res = await request(server).get('/api/debug/ip');
    expect(res.statusCode).toBe(404);
  });

  it('should report req.ip from the last X-Forwarded-For hop when DEBUG_IP_ENDPOINT=1', async () => {
    process.env.DEBUG_IP_ENDPOINT = '1';
    let debugApp;
    try {
      // A fresh copy of the app, built while the env var is set
      jest.isolateModules(() => {
        debugApp = require('../index');
      });
    } finally {
      delete process.env.DEBUG_IP_ENDPOINT;
    }

    const debugServer = await listenOnLoopback(debugApp);
    try {
      const res = await request(debugServer)
        .get('/api/debug/ip')
        .set('X-Forwarded-For', '198.51.100.1, 203.0.113.9');
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({
        ip: '203.0.113.9',
        ips: ['203.0.113.9'],
        xff: '198.51.100.1, 203.0.113.9',
      });
    } finally {
      await new Promise((resolve) => debugServer.close(resolve));
    }
  });
});

describe('parseTrustProxy', () => {
  it('should default to 1 hop when TRUST_PROXY is unset or empty', () => {
    expect(parseTrustProxy(undefined)).toBe(1);
    expect(parseTrustProxy('')).toBe(1);
    expect(parseTrustProxy('  ')).toBe(1);
  });

  it('should parse hop counts, booleans and subnet lists', () => {
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy('0')).toBe(0);
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('FALSE')).toBe(false);
    expect(parseTrustProxy('loopback, 10.0.0.0/8 ,173.245.48.0/20')).toEqual([
      'loopback',
      '10.0.0.0/8',
      '173.245.48.0/20',
    ]);
  });

  it('should produce values Express accepts, and Express should reject a malformed subnet', () => {
    const probeApp = express();
    expect(() => probeApp.set('trust proxy', parseTrustProxy('loopback, 10.0.0.0/8'))).not.toThrow();
    expect(() => probeApp.set('trust proxy', parseTrustProxy('not-an-ip'))).toThrow();
  });
});
