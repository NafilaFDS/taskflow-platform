'use strict';

// Prometheus instrumentation (Task 29).
//
// Two integration points:
//   - requestMetrics(): Express middleware that measures every HTTP request.
//   - timedQuery(): wraps every MongoDB driver call the app makes.
// A per-request AsyncLocalStorage context connects the two, so each DB query
// is counted against the request that issued it (db_queries_per_request).

const { AsyncLocalStorage } = require('node:async_hooks');
const client = require('prom-client');

const register = new client.Registry();

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'HTTP requests handled, by route pattern, method, status code and tenant',
  labelNames: ['route', 'method', 'status', 'tenant'],
  registers: [register]
});

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency in seconds, by route pattern, method and tenant',
  labelNames: ['route', 'method', 'tenant'],
  // Measured: indexed endpoints answer in a few ms, /api/notes?limit=20 takes
  // about 1s (N+1 over an unindexed collection). 16 sits just above the 15s
  // request budget, so timed-out requests land in their own bucket.
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 5, 8, 12, 16, 30, 60],
  registers: [register]
});

const dbQueryDuration = new client.Histogram({
  name: 'db_query_duration_seconds',
  help: 'MongoDB query latency in seconds, by query name',
  labelNames: ['query_name'],
  // Doubling from 0.25ms to ~4s: indexed lookups take under 1ms, full
  // collection scans take 20-150ms, so both ends get several buckets.
  buckets: client.exponentialBuckets(0.00025, 2, 15),
  registers: [register]
});

const dbQueriesPerRequest = new client.Histogram({
  name: 'db_queries_per_request',
  help: 'Number of MongoDB queries issued while serving one request, by route pattern',
  labelNames: ['route'],
  // Query counts are integers. Boundaries at n+0.5 put each integer in the
  // middle of its own bucket, so histogram_quantile() returns the exact count
  // (21, not an interpolated 20.5) for the common values.
  buckets: [0.5, 1.5, 2.5, 3.5, 5.5, 10.5, 20.5, 21.5, 50.5, 100.5, 250.5, 500.5, 1000.5, 5000.5, 5001.5],
  registers: [register]
});

const dbRowsReturned = new client.Histogram({
  name: 'db_rows_returned',
  help: 'Documents returned by one MongoDB query, by query name',
  labelNames: ['query_name'],
  buckets: [0, 1, 5, 10, 20, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000],
  registers: [register]
});

const httpRequestsInFlight = new client.Gauge({
  name: 'http_requests_in_flight',
  help: 'HTTP requests currently being served',
  registers: [register]
});

// Process metrics (event loop lag, heap, CPU) help explain saturation.
client.collectDefaultMetrics({ register });

const requestContext = new AsyncLocalStorage();

class RequestTimeoutError extends Error {
  constructor() {
    super('request time budget exceeded');
    this.name = 'RequestTimeoutError';
  }
}

// The route label must be the pattern (/api/notes/:id), never the real path
// (/api/notes/48213): one series per note id would explode cardinality.
function routeLabel(req) {
  return req.route ? req.baseUrl + req.route.path : 'unmatched';
}

// Probed every few seconds by Docker; logging them would bury real traffic.
const UNLOGGED_PATHS = ['/healthz'];

function requestMetrics({ timeoutMs }) {
  return (req, res, next) => {
    if (req.path === '/metrics') return next();

    const ctx = { queries: 0, deadline: Date.now() + timeoutMs };
    const started = process.hrtime.bigint();
    let recorded = false;

    httpRequestsInFlight.inc();

    const record = status => {
      if (recorded) return;
      recorded = true;
      httpRequestsInFlight.dec();

      const route = routeLabel(req);
      const tenant = req.tenantLabel || 'none';
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;

      httpRequestsTotal.inc({ route, method: req.method, status, tenant });
      httpRequestDuration.observe({ route, method: req.method, tenant }, seconds);
      if (ctx.queries > 0) dbQueriesPerRequest.observe({ route }, ctx.queries);

      if (!UNLOGGED_PATHS.includes(req.path)) {
        console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl} route=${route} tenant=${tenant} status=${status} duration_ms=${(seconds * 1000).toFixed(1)} db_queries=${ctx.queries}`);
      }
    };

    res.on('finish', () => record(String(res.statusCode)));
    // 'close' without 'finish' means the client disconnected before the
    // response was sent. 499 is the nginx convention for that case.
    res.on('close', () => record('499'));

    requestContext.run(ctx, next);
  };
}

function rowCount(result) {
  if (Array.isArray(result)) return result.length;
  if (result === null || result === undefined) return 0;
  return 1;
}

// Every MongoDB call goes through here. Also enforces the request time budget:
// once it is spent, no further queries run and the request fails with 504
// instead of holding the database for minutes.
async function timedQuery(queryName, operation) {
  const ctx = requestContext.getStore();
  if (ctx) {
    if (Date.now() > ctx.deadline) throw new RequestTimeoutError();
    ctx.queries += 1;
  }

  const stopTimer = dbQueryDuration.startTimer({ query_name: queryName });
  try {
    const result = await operation();
    dbRowsReturned.observe({ query_name: queryName }, rowCount(result));
    return result;
  } finally {
    stopTimer();
  }
}

async function metricsHandler(req, res) {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
}

module.exports = {
  requestMetrics,
  timedQuery,
  metricsHandler,
  RequestTimeoutError
};
