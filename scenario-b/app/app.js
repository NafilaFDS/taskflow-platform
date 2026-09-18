'use strict';

require('dotenv').config();

const os = require('os');
const express = require('express');
const { MongoClient } = require('mongodb');
const {
  requestMetrics,
  timedQuery,
  metricsHandler,
  RequestTimeoutError
} = require('./metrics');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const MONGODB_URI = process.env.MONGODB_URI;
// Time budget for one request. Checked before every DB query (see timedQuery).
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS) || 15000;

// B4 (Swarm). APP_VERSION is baked into the image at build time (v1 / v2 / v3)
// so a running replica can say which image it came from.
const APP_VERSION = process.env.APP_VERSION || 'dev';
// B4 Task 38 - the deliberately broken v3. When set, /healthz answers 500:
// the process still runs, but the container healthcheck fails, so Swarm can
// detect the bad version and roll back. Never set for v1 or v2.
const BREAK_HEALTHZ = process.env.BREAK_HEALTHZ === '1';
// Inside a container this is the container ID, which identifies the replica.
const SERVED_BY = os.hostname();

let mongoClient = null;
let mongoState = 'not_connected';

const app = express();

// B4 Task 36 - every response names the replica that produced it, and the
// image version that replica runs. Set first so it applies to all routes.
app.use((req, res, next) => {
  res.set('X-Served-By', SERVED_BY);
  res.set('X-App-Version', APP_VERSION);
  next();
});

app.use(requestMetrics({ timeoutMs: REQUEST_TIMEOUT_MS }));

// Parsed per route rather than app-wide, so a malformed body is rejected
// after routing and its 400 is recorded under the real route label.
const jsonBody = express.json();

// Prometheus scrape endpoint (Task 29).
app.get('/metrics', metricsHandler);

// Root route reports process and MongoDB connection state.
app.get('/', (req, res) => {
  res.json({
    service: 'taskflow-scenario-b',
    status: 'running',
    version: APP_VERSION,
    served_by: SERVED_BY,
    mongodb: mongoState
  });
});

// Liveness endpoint used by the Docker HEALTHCHECK.
// Reports the process itself, not MongoDB, so the container is healthy
// as soon as the HTTP server can serve traffic.
app.get('/healthz', (req, res) => {
  if (BREAK_HEALTHZ) {
    // v3 only (Task 38). Predictable, immediate, and detectable by Swarm.
    return res.status(500).json({
      status: 'broken',
      version: APP_VERSION,
      served_by: SERVED_BY
    });
  }
  res.status(200).json({
    status: 'ok',
    version: APP_VERSION,
    served_by: SERVED_BY,
    uptime: process.uptime()
  });
});

// Readiness: 200 only if MongoDB answers a query.
app.get('/readyz', async (req, res) => {
  if (mongoState !== 'connected') {
    return res.status(503).json({ status: 'not_ready', mongodb: mongoState });
  }
  try {
    await timedQuery('ping', () => mongoClient.db().command({ ping: 1 }));
    res.json({ status: 'ready' });
  } catch (err) {
    res.status(503).json({ status: 'not_ready', error: err.message });
  }
});

function collection(name) {
  return mongoClient.db().collection(name);
}

// Notes API (Task 27 - persistence test). Returns 503 when MongoDB is not
// connected so a failed startup connection is visible to API callers.
function notesCollection(res) {
  if (mongoState !== 'connected') {
    res.status(503).json({ error: 'MongoDB unavailable', mongodb: mongoState });
    return null;
  }
  return collection('notes');
}

app.get('/notes', async (req, res) => {
  const notes = notesCollection(res);
  if (!notes) return;
  const items = await timedQuery('legacy_notes_list', () => notes.find().sort({ createdAt: 1 }).toArray());
  res.json({ count: items.length, notes: items });
});

app.post('/notes', jsonBody, async (req, res) => {
  const notes = notesCollection(res);
  if (!notes) return;
  const { title, body } = req.body || {};
  if (typeof title !== 'string' || title.trim() === '') {
    return res.status(400).json({ error: 'title is required' });
  }
  const note = {
    title: title.trim(),
    body: typeof body === 'string' ? body : '',
    createdAt: new Date()
  };
  await timedQuery('legacy_note_insert', () => notes.insertOne(note));
  res.status(201).json(note);
});

// ---------------------------------------------------------------------------
// Multi-tenant Notes API (Scenario B). Collections: tenants, notes, tags
// (see seed/seed.js). Tenant comes from the X-Tenant header and every query
// filters by tenant_id.
// ---------------------------------------------------------------------------

function requireDb(req, res, next) {
  if (mongoState !== 'connected') {
    return res.status(503).json({ error: 'MongoDB unavailable', mongodb: mongoState });
  }
  next();
}

// Tenants never change at runtime, so each slug is looked up once.
const tenantCache = new Map();

async function requireTenant(req, res, next) {
  const slug = req.get('X-Tenant');
  if (!slug) {
    return res.status(400).json({ error: 'X-Tenant header is required' });
  }
  let tenant = tenantCache.get(slug);
  if (!tenant) {
    tenant = await timedQuery('tenant_by_slug', () => collection('tenants').findOne({ slug }));
    if (tenant) tenantCache.set(slug, tenant);
  }
  if (!tenant) {
    // Never use an unverified header value as a metric label: any client
    // could create unlimited series by sending random tenant names.
    req.tenantLabel = 'unknown';
    return res.status(404).json({ error: 'unknown tenant' });
  }
  req.tenant = tenant;
  req.tenantLabel = tenant.slug;
  next();
}

const api = [requireDb, requireTenant];

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// GET /api/notes - DELIBERATELY BAD (Problems 1 and 4 are still in place).
// Problem 1 (N+1): one query for the notes, then one query per note for its tags.
// Problem 4 (unbounded limit): ?limit is not capped, limit=5000 returns 5000 notes.
app.get('/api/notes', api, async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 20;
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);

  const notes = await timedQuery('notes_list', () =>
    collection('notes')
      .find({ tenant_id: req.tenant._id })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray()
  );

  for (const note of notes) {
    // Problem 3 was the missing index on tags.note_id, which made each of these
    // queries scan the whole tags collection. Fixed in Task 34 by
    // seed/fix-idx-tags-note-id.js; the N+1 loop itself is still here.
    const tags = await timedQuery('tags_by_note', () =>
      collection('tags').find({ note_id: note._id }, { projection: { _id: 0, name: 1 } }).toArray()
    );
    note.tags = tags.map(t => t.name);
  }

  res.json(notes);
});

app.get('/api/notes/:id', api, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'id must be an integer' });
  }

  const note = await timedQuery('note_by_id', () =>
    collection('notes').findOne({ _id: id, tenant_id: req.tenant._id })
  );
  if (!note) {
    return res.status(404).json({ error: 'note not found' });
  }

  const tags = await timedQuery('tags_by_note', () =>
    collection('tags').find({ note_id: note._id }, { projection: { _id: 0, name: 1 } }).toArray()
  );
  note.tags = tags.map(t => t.name);
  res.json(note);
});

app.post('/api/notes', api, jsonBody, async (req, res) => {
  const { title, body, tags = [] } = req.body || {};
  if (typeof title !== 'string' || title.trim() === '' || typeof body !== 'string') {
    return res.status(400).json({ error: 'title and body are required' });
  }
  if (!Array.isArray(tags) || !tags.every(t => typeof t === 'string' && t.trim() !== '')) {
    return res.status(400).json({ error: 'tags must be an array of strings' });
  }

  const counters = collection('counters');
  const { seq: noteId } = await timedQuery('notes_next_id', () =>
    counters.findOneAndUpdate({ _id: 'notes' }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' })
  );
  const note = {
    _id: noteId,
    tenant_id: req.tenant._id,
    title: title.trim(),
    body,
    created_at: new Date()
  };
  await timedQuery('note_insert', () => collection('notes').insertOne(note));

  if (tags.length > 0) {
    const { seq: lastTagId } = await timedQuery('tags_next_id', () =>
      counters.findOneAndUpdate({ _id: 'tags' }, { $inc: { seq: tags.length } }, { upsert: true, returnDocument: 'after' })
    );
    const firstTagId = lastTagId - tags.length + 1;
    const tagDocs = tags.map((name, i) => ({ _id: firstTagId + i, note_id: noteId, name: name.trim() }));
    await timedQuery('tags_insert', () => collection('tags').insertMany(tagDocs));
  }

  res.status(201).json({ ...note, tags: tags.map(t => t.trim()) });
});

// GET /api/search - DELIBERATELY BAD (Problem 2 is still in place).
// Problem 2 (unindexed search): an unanchored regex (the equivalent of
// LIKE '%word%') cannot use an index, so every search scans all notes.
app.get('/api/search', api, async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  if (q === '') {
    return res.status(400).json({ error: 'q is required' });
  }

  const notes = await timedQuery('notes_search', () =>
    collection('notes')
      .find({ tenant_id: req.tenant._id, body: { $regex: escapeRegex(q) } })
      .toArray()
  );
  res.json({ count: notes.length, notes });
});

// GET /api/stats - counts for the tenant across tenants, notes and tags.
// Counting tags by note_id was a full scan until Problem 3 was fixed (Task 34).
app.get('/api/stats', api, async (req, res) => {
  const noteIds = await timedQuery('stats_note_ids', () =>
    collection('notes').find({ tenant_id: req.tenant._id }, { projection: { _id: 1 } }).toArray()
  );
  const tagCount = await timedQuery('stats_tag_count', () =>
    collection('tags').countDocuments({ note_id: { $in: noteIds.map(n => n._id) } })
  );
  res.json({ tenant: req.tenant.slug, notes: noteIds.length, tags: tagCount });
});

// Errors thrown by async handlers (Express 5 forwards rejected promises here).
// Responding here, instead of letting Express print HTML, keeps the status
// code accurate in http_requests_total.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof RequestTimeoutError) {
    return res.status(504).json({ error: 'request timed out', timeout_ms: REQUEST_TIMEOUT_MS });
  }
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(`${req.method} ${req.originalUrl} failed: ${err.message}`);
  res.status(status).json({ error: status >= 500 ? 'internal server error' : err.message });
});

async function connectToMongo() {
  if (!MONGODB_URI) {
    mongoState = 'not_configured';
    console.warn('MONGODB_URI is not set. Skipping MongoDB connection.');
    return;
  }

  try {
    mongoClient = new MongoClient(MONGODB_URI, {
      serverSelectionTimeoutMS: 5000
    });
    await mongoClient.connect();
    await mongoClient.db().command({ ping: 1 });
    mongoState = 'connected';
    console.log('Connected to MongoDB');
  } catch (err) {
    mongoState = 'connection_failed';
    console.warn(`MongoDB connection failed: ${err.message}`);
  }
}

const server = app.listen(PORT, HOST, () => {
  console.log(`Server listening on ${HOST}:${PORT}`);
  connectToMongo();
});

// Graceful shutdown. Swarm sends SIGTERM to the old task during a rolling
// update or a scale-down, then waits stop_grace_period before SIGKILL.
// server.close() stops accepting new connections and fires its callback only
// once in-flight requests have finished, so replies are not cut off mid-flight.
let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received. Draining connections.`);

  // Idle keep-alive sockets would otherwise hold server.close() open until
  // their timeout expires.
  if (typeof server.closeIdleConnections === 'function') {
    server.closeIdleConnections();
  }

  server.close(async () => {
    if (mongoClient) {
      try {
        await mongoClient.close();
      } catch (err) {
        console.warn(`MongoDB close failed: ${err.message}`);
      }
    }
    console.log('Drained. Exiting.');
    process.exit(0);
  });

  // Backstop: never outlive the orchestrator's grace period.
  setTimeout(() => {
    console.warn('Drain timed out. Forcing exit.');
    process.exit(0);
  }, 10000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = app;

// Task 23 - layer caching test: source change invalidates only the COPY app.js layer onward.
// task23 cache demo 1789144878
