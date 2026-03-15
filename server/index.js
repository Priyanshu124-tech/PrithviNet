/* ==========================================
   PrithviNet — Express Server Entry Point
   ==========================================
   - Serves frontend static files
   - Mounts REST API at /api
   - Starts data fetch / simulation scheduler
   - Purges old data daily
   ========================================== */

'use strict';

require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const db       = require('./db');
const fetcher  = require('./fetcher');
const apiRoute = require('./routes/api');

const PORT          = process.env.PORT || 3000;
const FETCH_INTERVAL = 60 * 1000;       // 60 seconds — WAQI rate-limit safe
const PURGE_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

const app = express();

/* ---------- MIDDLEWARE ---------- */
app.use(cors());
app.use(express.json({ limit: '20mb' }));

/* ---------- STATIC FILES (frontend) ---------- */
const frontendDir = path.join(__dirname, '..');
app.use(express.static(frontendDir));

/* ---------- API ROUTES ---------- */
const entitiesRoute = require('./routes/entities');
const complianceRoute = require('./routes/compliance');
const forecastRoute = require('./routes/forecast');
const copilotRoute = require('./routes/copilot');
app.use('/api/entities', entitiesRoute);
app.use('/api/compliance', complianceRoute);
app.use('/api/forecast', forecastRoute);
app.use('/api/copilot', copilotRoute);
app.use('/api', apiRoute);

/* ---------- FALLBACK → index.html ---------- */
app.get('*', (req, res) => {
  // Only for non-API routes
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(frontendDir, 'index.html'));
  }
});

/* ---------- START ---------- */
function start() {
  // 1. Init database
  db.init();
  db.seedDemoData();
  console.log('[Server] Database initialized + demo data ready');

  // 2. Start Express
  app.listen(PORT, () => {
    console.log(`[Server] PrithviNet backend running at http://localhost:${PORT}`);
    console.log(`[Server] API available at http://localhost:${PORT}/api`);
    console.log(`[Server] Frontend served from ${frontendDir}`);
  });

  // 3. Start AQICN fetch scheduler
  fetcher.startScheduler(FETCH_INTERVAL);

  // 4. Daily purge of old data (keep 30 days)
  setInterval(() => {
    try {
      db.purgeOldData(30);
      console.log('[Server] Old data purged (>30 days)');
    } catch (err) {
      console.error('[Server] Purge error:', err.message);
    }
  }, PURGE_INTERVAL);
}

start();
