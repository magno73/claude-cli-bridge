/**
 * smoke.test.ts — Smoke tests for the Claude CLI Bridge.
 *
 * These tests verify the bridge's HTTP interface without requiring
 * a live Claude CLI. They test:
 *   - Health endpoint
 *   - Models endpoint
 *   - Request validation (missing messages, invalid JSON)
 *   - 404 handling
 *
 * Tests that require a live Claude CLI are marked and can be run
 * separately with: npm test -- --testPathPattern=smoke
 */

import * as http from 'http';

const BASE_URL = process.env.BRIDGE_URL || 'http://127.0.0.1:3457';

/**
 * Helper to make HTTP requests and return parsed response.
 */
function request(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options: http.RequestOptions = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
    };

    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        try {
          resolve({ status: res.statusCode || 0, body: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode || 0, body: raw });
        }
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function runTests(): Promise<void> {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, name: string): void {
    if (condition) {
      console.log(`  [PASS] ${name}`);
      passed++;
    } else {
      console.log(`  [FAIL] ${name}`);
      failed++;
    }
  }

  console.log('=== Claude CLI Bridge — Smoke Tests ===\n');

  // Test 1: Health endpoint
  console.log('1. GET /health');
  try {
    const res = await request('GET', '/health');
    assert(res.status === 200, 'returns 200');
    assert((res.body as Record<string, unknown>).status === 'ok', 'status is "ok"');
    assert(typeof (res.body as Record<string, unknown>).activeSessions === 'number', 'has activeSessions');
  } catch (e) {
    console.log(`  [FAIL] Could not connect to bridge at ${BASE_URL}`);
    console.log(`  Make sure the bridge is running: node dist/server.js`);
    process.exit(1);
  }

  // Test 2: Models endpoint
  console.log('\n2. GET /v1/models');
  {
    const res = await request('GET', '/v1/models');
    assert(res.status === 200, 'returns 200');
    const data = res.body as { data: Array<{ id: string }> };
    assert(Array.isArray(data.data), 'returns data array');
    assert(data.data.some(m => m.id === 'claude-sonnet'), 'includes claude-sonnet');
    assert(data.data.some(m => m.id === 'claude-haiku'), 'includes claude-haiku');
    assert(data.data.some(m => m.id === 'claude-opus'), 'includes claude-opus');
  }

  // Test 3: Invalid JSON body
  console.log('\n3. POST /v1/chat/completions — invalid JSON');
  {
    const res = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const url = new URL('/v1/chat/completions', BASE_URL);
      const req = http.request({
        method: 'POST',
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: { 'Content-Type': 'application/json' },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            body: JSON.parse(Buffer.concat(chunks).toString()),
          });
        });
      });
      req.on('error', reject);
      req.write('not valid json{{{');
      req.end();
    });
    assert(res.status === 400, 'returns 400');
  }

  // Test 4: Missing messages
  console.log('\n4. POST /v1/chat/completions — missing messages');
  {
    const res = await request('POST', '/v1/chat/completions', { model: 'claude-sonnet' });
    assert(res.status === 400, 'returns 400');
  }

  // Test 5: Empty messages array
  console.log('\n5. POST /v1/chat/completions — empty messages');
  {
    const res = await request('POST', '/v1/chat/completions', {
      model: 'claude-sonnet',
      messages: [],
    });
    assert(res.status === 400, 'returns 400');
  }

  // Test 6: 404 for unknown route
  console.log('\n6. GET /unknown-route');
  {
    const res = await request('GET', '/unknown-route');
    assert(res.status === 404, 'returns 404');
  }

  // Summary
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
