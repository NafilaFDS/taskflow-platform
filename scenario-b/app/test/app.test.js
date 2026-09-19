'use strict';

// B5 Task 41 - tests run by .github/workflows/pr.yml on every Pull Request.
//
// The app calls app.listen() at require time, so requiring app.js from the
// test process would leave a stray listener open. Instead every test starts
// the real entrypoint (`node app.js`) as a child process on a free port and
// talks to it over HTTP - the same thing the CI job does to the container,
// so the tests exercise the app exactly as it is shipped.
//
// No MongoDB is available in CI, so MONGODB_URI is passed empty on purpose:
// the app must still boot and stay live. That is what /healthz means here.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

const APP_DIR = path.join(__dirname, '..');
const APP_ENTRY = path.join(APP_DIR, 'app.js');
const BOOT_TIMEOUT_MS = 20000;

// Ask the OS for a port, then release it. Avoids a hard-coded port clashing
// with anything else on the machine or on the runner.
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function request(port, urlPath, options = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, options);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Non-JSON body: tests that care assert on `text` instead.
  }
  return { status: res.status, headers: res.headers, text, json };
}

async function startApp(extraEnv = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [APP_ENTRY], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      // Empty (not unset) so a stray .env cannot inject a real database:
      // dotenv never overwrites a key that is already in process.env.
      MONGODB_URI: '',
      APP_VERSION: 'test',
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  // Kept so a boot failure reports why instead of just timing out.
  let output = '';
  child.stdout.on('data', d => { output += d; });
  child.stderr.on('data', d => { output += d; });

  let exited = null;
  child.once('exit', code => { exited = code; });

  // `/` answers regardless of database state, so it works as a readiness probe
  // even for the BREAK_HEALTHZ instance whose /healthz is meant to return 500.
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited !== null) {
      throw new Error(`app exited with code ${exited} during startup:\n${output}`);
    }
    try {
      await request(port, '/');
      return { port, child };
    } catch {
      await sleep(150);
    }
  }
  child.kill('SIGKILL');
  throw new Error(`app did not answer on port ${port} within ${BOOT_TIMEOUT_MS}ms:\n${output}`);
}

function stopApp(app) {
  if (!app || app.child.exitCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    const kill = setTimeout(() => app.child.kill('SIGKILL'), 5000);
    app.child.once('exit', () => { clearTimeout(kill); resolve(); });
    app.child.kill('SIGTERM');
  });
}

let app;

before(async () => { app = await startApp(); });
after(async () => { await stopApp(app); });

// Test 1 - the contract the Docker HEALTHCHECK, Swarm and the CI job all rely
// on: a running process answers /healthz with 200 and identifies itself.
test('GET /healthz returns 200 and reports the process as ok', async () => {
  const res = await request(app.port, '/healthz');

  assert.equal(res.status, 200);
  assert.equal(res.json.status, 'ok');
  assert.equal(res.json.version, 'test');
  assert.equal(typeof res.json.served_by, 'string');
  assert.ok(res.json.served_by.length > 0);
  assert.equal(typeof res.json.uptime, 'number');
  // Task 36 - every response names the replica and the image version.
  assert.equal(res.headers.get('x-app-version'), 'test');
  assert.ok(res.headers.get('x-served-by'));
});

// Test 2 - liveness is not readiness. With no database, /healthz must stay
// 200 (the process is fine) while /readyz must be 503 (it cannot serve data).
// Getting this backwards is what makes an orchestrator restart healthy
// containers during a database outage.
test('/healthz stays 200 without MongoDB while /readyz reports 503', async () => {
  const health = await request(app.port, '/healthz');
  const ready = await request(app.port, '/readyz');

  assert.equal(health.status, 200, '/healthz must not depend on MongoDB');
  assert.equal(ready.status, 503, '/readyz must fail when MongoDB is absent');
  assert.equal(ready.json.status, 'not_ready');
  assert.equal(ready.json.mongodb, 'not_configured');
});

// Test 3 - the data API refuses to answer instead of erroring at query time,
// and the root route reports the real connection state rather than pretending.
test('data routes return 503 and / reports the MongoDB state honestly', async () => {
  const root = await request(app.port, '/');
  const notes = await request(app.port, '/api/notes', {
    headers: { 'X-Tenant': 'acme' }
  });

  assert.equal(root.status, 200);
  assert.equal(root.json.service, 'taskflow-scenario-b');
  assert.equal(root.json.status, 'running');
  assert.equal(root.json.mongodb, 'not_configured');

  assert.equal(notes.status, 503);
  assert.equal(notes.json.error, 'MongoDB unavailable');
});

// Test 4 - the deliberate failure switch used for the Task 38 rollback still
// works. If this regressed, the rollback drill would silently prove nothing.
test('BREAK_HEALTHZ=1 makes /healthz fail with 500', async () => {
  const broken = await startApp({ BREAK_HEALTHZ: '1' });
  try {
    const health = await request(broken.port, '/healthz');
    const root = await request(broken.port, '/');

    assert.equal(health.status, 500);
    assert.equal(health.json.status, 'broken');
    // The process is still up and serving - only /healthz reports failure.
    assert.equal(root.status, 200);
  } finally {
    await stopApp(broken);
  }
});
