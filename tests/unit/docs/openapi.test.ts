import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../../src/app.ts';
import { createPrismaClient } from '../../../src/config/database.ts';
import { buildOpenApiDocument, OPERATIONS } from '../../../src/docs/openapi.ts';
import { MemoryOtpStore } from '../../../src/modules/auth/otp.ts';
import { HealthService } from '../../../src/modules/health/health.service.ts';
import { MemoryDocumentStorage } from '../../../src/modules/kyc/document-storage.ts';
import { MockKycProvider } from '../../../src/modules/kyc/providers/mock-kyc-provider.ts';
import { MemoryMessageSender } from '../../../src/modules/notifications/notification.service.ts';
import { MockPaymentProvider } from '../../../src/modules/payments/providers/mock-payment-provider.ts';
import { MemoryRateLimitStore } from '../../../src/middleware/rate-limit.middleware.ts';

const SRC = join(import.meta.dirname, '../../../src');
const read = (path: string) => readFileSync(join(SRC, path), 'utf8');

/** Every `router.<method>('<path>'` in the source, with the prefix its router is mounted at. */
function mountedRoutes(): string[] {
  const mounts = new Map<string, string>();
  const mountPattern = /\.use\(\s*'([^']+)',\s*create(\w+)Router/g;
  for (const match of read('routes/index.ts').matchAll(mountPattern)) {
    mounts.set(match[2] ?? '', `/api/v1${match[1] ?? ''}`);
  }
  for (const match of read('app.ts').matchAll(mountPattern))
    mounts.set(match[2] ?? '', match[1] ?? '');

  const routes: string[] = [];
  const modules = join(SRC, 'modules');
  for (const dir of readdirSync(modules)) {
    for (const file of readdirSync(join(modules, dir)).filter((f) => f.endsWith('.routes.ts'))) {
      const source = read(`modules/${dir}/${file}`);
      const name = /export function create(\w+)Router/.exec(source)?.[1];
      // The admin router is built from ADMIN_ROUTES, which the document uses directly.
      if (name === undefined || name === 'Admin') continue;
      const prefix = mounts.get(name);
      if (prefix === undefined) throw new Error(`create${name}Router is not mounted anywhere`);
      for (const route of source.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']*)'/g)) {
        const path = route[2] === '/' ? '' : (route[2] ?? '');
        routes.push(`${route[1] ?? ''} ${prefix}${path}`);
      }
    }
  }
  return routes.sort();
}

describe('OpenAPI document', () => {
  it('lists every mounted route, and nothing that is not mounted', () => {
    const documented = OPERATIONS.filter((op) => !op.path.startsWith('/api/v1/admin'))
      .map((op) => `${op.method} ${op.path}`)
      .sort();
    expect(documented).toEqual(mountedRoutes());
  });

  it('has no duplicate operations', () => {
    const keys = OPERATIONS.map((op) => `${op.method} ${op.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  const doc = buildOpenApiDocument('test');

  it('is OpenAPI 3.1 and serialises to JSON', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(() => JSON.stringify(doc)).not.toThrow();
  });

  it('declares every path parameter, and the Idempotency-Key where money moves', () => {
    for (const [path, methods] of Object.entries(doc.paths)) {
      const names = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      for (const [method, op] of Object.entries(methods)) {
        const params = (op as { parameters: { name: string; in: string }[] }).parameters;
        for (const name of names) {
          expect(
            params.some((p) => p.in === 'path' && p.name === name),
            `${method} ${path} ${String(name)}`,
          ).toBe(true);
        }
      }
    }
    const transfer = doc.paths['/api/v1/transfers']?.post as { parameters: { name: string }[] };
    expect(transfer.parameters.some((p) => p.name === 'Idempotency-Key')).toBe(true);
  });

  it('describes request bodies from the real schemas (amounts as kobo strings)', () => {
    const transfer = doc.paths['/api/v1/transfers']?.post as {
      requestBody: {
        content: {
          'application/json': { schema: { properties: Record<string, { type?: string }> } };
        };
      };
    };
    expect(transfer.requestBody.content['application/json'].schema.properties.amount?.type).toBe(
      'string',
    );
  });

  it('names the permission on every admin operation', () => {
    for (const op of OPERATIONS.filter((o) => o.path.startsWith('/api/v1/admin'))) {
      expect(op.permission, op.path).toBeDefined();
    }
  });
});

describe('docs routes', () => {
  const app = createApp({
    db: createPrismaClient({ connectionString: 'postgresql://u:p@localhost:1/none' }),
    health: new HealthService([]),
    rateLimitStore: new MemoryRateLimitStore(),
    otpStore: new MemoryOtpStore(),
    messageSender: new MemoryMessageSender(),
    kycProvider: new MockKycProvider(),
    documentStorage: new MemoryDocumentStorage(),
    paymentProvider: new MockPaymentProvider({
      webhookSecret: 'test-only-payment-webhook-secret-not-for-production',
    }),
    webhookQueue: { add: () => Promise.reject(new Error('none')) },
    maintenanceQueue: { add: () => Promise.reject(new Error('none')) },
    statementStorage: new MemoryDocumentStorage(),
  });

  it('serves the document at /api/v1/openapi.json, publicly', async () => {
    const res = await request(app).get('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect((res.body as { openapi: string }).openapi).toBe('3.1.0');
  });

  it('serves Swagger UI at /docs/ from the installed package, pointed at our document', async () => {
    const page = await request(app).get('/docs/');
    expect(page.status).toBe(200);
    expect(page.text).toContain('swagger-ui');
    const init = await request(app).get('/docs/swagger-initializer.js');
    expect(init.text).toContain("url: '/api/v1/openapi.json'");
    expect(init.text).not.toContain('petstore');
    expect((await request(app).get('/docs/swagger-ui-bundle.js')).status).toBe(200);
  });

  it('keeps the strict CSP (no inline scripts allowed)', async () => {
    const page = await request(app).get('/docs/');
    const csp = String(page.headers['content-security-policy']);
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });
});
