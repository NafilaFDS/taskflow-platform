'use strict';

require('dotenv').config();

const express = require('express');
const { MongoClient } = require('mongodb');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const MONGODB_URI = process.env.MONGODB_URI;

let mongoClient = null;
let mongoState = 'not_connected';

const app = express();
app.use(express.json());

// Placeholder root route so the server can be verified as running.
// Real API routes are added in a later task.
app.get('/', (req, res) => {
  res.json({
    service: 'taskflow-scenario-b',
    status: 'running',
    mongodb: mongoState
  });
});

// Liveness endpoint used by the Docker HEALTHCHECK.
// Reports the process itself, not MongoDB, so the container is healthy
// as soon as the HTTP server can serve traffic.
app.get('/healthz', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: process.uptime()
  });
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

async function shutdown(signal) {
  console.log(`${signal} received. Shutting down.`);
  server.close();
  if (mongoClient) {
    await mongoClient.close();
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = app;
