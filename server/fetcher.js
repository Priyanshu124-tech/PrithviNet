/* ==========================================
   PrithviNet — Hybrid Data Ingestion Engine
   ==========================================
   - Air Quality: LIVE data from WAQI API
   - Water / Noise: Simulated IoT data
   - Broadcasts all updates via SSE
   ========================================== */

const EventEmitter = require('events');
const db = require('./db');
const simulator = require('./simulator');
const fetch = require('node-fetch');

const WAQI_TOKEN = 'b584b150e750a7e27dbcffb9cea73ae408dc7622';

// Bhilai / Raipur / Chhattisgarh region bounding box (lat/lng)
const BBOX = { lat1: 20.5, lng1: 80.5, lat2: 22.0, lng2: 82.5 };

// Fallback city search keywords if bbox returns nothing
const CITY_KEYWORDS = ['bhilai', 'raipur', 'durg', 'bilaspur', 'korba'];

class Fetcher extends EventEmitter {
  constructor() {
    super();
    this.intervalId = null;
    this.clients = [];
    this.latestDataCache = {
      air: [],
      water: [],
      noise: []
    };
  }

  /* ---------- SSE CONNECTION HANDLING ---------- */
  addSSEClient(res) {
    res.write(`event: update\ndata: ${JSON.stringify({ type: 'connected', message: 'SSE connection established' })}\n\n`);

    if (this.latestDataCache.air.length > 0) {
      res.write(`event: update\ndata: ${JSON.stringify({ type: 'update', dataType: 'air', payload: this.latestDataCache.air })}\n\n`);
    }
    if (this.latestDataCache.water.length > 0) {
      res.write(`event: update\ndata: ${JSON.stringify({ type: 'update', dataType: 'water', payload: this.latestDataCache.water })}\n\n`);
    }
    if (this.latestDataCache.noise.length > 0) {
      res.write(`event: update\ndata: ${JSON.stringify({ type: 'update', dataType: 'noise', payload: this.latestDataCache.noise })}\n\n`);
    }

    this.clients.push(res);
  }

  removeSSEClient(res) {
    this.clients = this.clients.filter(client => client !== res);
  }

  broadcast(dataType, payload) {
    if (this.clients.length === 0) return;
    const eventString = `event: update\ndata: ${JSON.stringify({ type: 'update', dataType, payload })}\n\n`;
    let deadClients = [];
    
    this.clients.forEach(client => {
      try {
        client.write(eventString);
      } catch (err) {
        deadClients.push(client);
      }
    });

    if (deadClients.length > 0) {
      this.clients = this.clients.filter(c => !deadClients.includes(c));
    }
  }

  /* ---------- WAQI API: Fetch Real Air Quality ---------- */
  async fetchWAQIStations() {
    const airReadings = [];

    try {
      // 1. Try bounding box search first (returns multiple stations)
      const bboxUrl = `https://api.waqi.info/v2/map/bounds/?latlng=${BBOX.lat1},${BBOX.lng1},${BBOX.lat2},${BBOX.lng2}&networks=all&token=${WAQI_TOKEN}`;
      console.log('[WAQI] Fetching stations via bounding box...');
      
      const bboxResp = await fetch(bboxUrl, { timeout: 10000 });
      const bboxJson = await bboxResp.json();

      let stationUids = [];

      if (bboxJson.status === 'ok' && bboxJson.data && bboxJson.data.length > 0) {
        console.log(`[WAQI] Found ${bboxJson.data.length} stations in bounding box`);
        stationUids = bboxJson.data.slice(0, 8).map(s => s.uid); // Limit to 8 stations
      } else {
        // 2. Fallback: city keyword search
        console.log('[WAQI] Bounding box empty, trying city search...');
        for (const keyword of CITY_KEYWORDS) {
          try {
            const searchUrl = `https://api.waqi.info/search/?keyword=${keyword}&token=${WAQI_TOKEN}`;
            const searchResp = await fetch(searchUrl, { timeout: 8000 });
            const searchJson = await searchResp.json();
            if (searchJson.status === 'ok' && searchJson.data) {
              searchJson.data.forEach(s => {
                if (s.uid && !stationUids.includes(s.uid)) stationUids.push(s.uid);
              });
            }
          } catch (e) {
            console.warn(`[WAQI] Search for "${keyword}" failed:`, e.message);
          }
        }
        console.log(`[WAQI] City search found ${stationUids.length} station UIDs`);
      }

      // 3. Fetch detailed data for each station
      // Also always include the "here" (geo-based) endpoint as a guaranteed fallback
      const feedUrls = [
        `https://api.waqi.info/feed/here/?token=${WAQI_TOKEN}`,
        ...stationUids.map(uid => `https://api.waqi.info/feed/@${uid}/?token=${WAQI_TOKEN}`)
      ];

      // Resolve the air-type monitoring locations
      const airLocations = db.getAllMonitoringLocations().filter(l => l.type === 'air');

      for (let i = 0; i < feedUrls.length; i++) {
        try {
          const resp = await fetch(feedUrls[i], { timeout: 8000 });
          const json = await resp.json();

          if (json.status !== 'ok' || !json.data) continue;

          const d = json.data;
          const iaqi = d.iaqi || {};

          // Map this WAQI station to the closest monitoring_location in our DB
          // Use round-robin assignment if we have more WAQI stations than DB locations
          const targetLoc = airLocations[i % airLocations.length];
          if (!targetLoc) continue;

          const reading = {
            location_id: targetLoc.id,
            industry_id: targetLoc.industry_id || null,
            type: 'air',
            aqi: d.aqi || null,
            pm25: iaqi.pm25?.v ?? null,
            pm10: iaqi.pm10?.v ?? null,
            no2: iaqi.no2?.v ?? null,
            o3: iaqi.o3?.v ?? null,
            so2: iaqi.so2?.v ?? null,
            co: iaqi.co?.v ?? null,
            ph: null,
            dissolved_oxygen: null,
            bod: null,
            cod: null,
            turbidity: null,
            conductivity: null,
            noise_level_db: null,
            noise_min_db: null,
            noise_max_db: null,
            temperature: iaqi.t?.v ?? null,
            humidity: iaqi.h?.v ?? null,
            wind_speed: iaqi.w?.v ?? null,
            pressure: iaqi.p?.v ?? null,
            dominant: d.dominentpol || null,
            submitted_by: null,
            source: 'waqi_api'
          };

          airReadings.push(reading);
          console.log(`[WAQI] Station "${d.city?.name || feedUrls[i]}": AQI=${d.aqi}, PM2.5=${iaqi.pm25?.v ?? 'N/A'}`);

        } catch (stationErr) {
          console.warn(`[WAQI] Failed to fetch station ${feedUrls[i]}:`, stationErr.message);
        }
      }

    } catch (err) {
      console.error('[WAQI] API fetch failed entirely:', err.message);
    }

    return airReadings;
  }

  /* ---------- HYBRID DATA FETCH CYCLE ---------- */
  async runFetchCycle() {
    console.log(`\n[Ingestion] === Starting hybrid cycle ===`);
    const startTime = Date.now();

    try {
      // === PHASE 1: Real Air Data from WAQI API ===
      let airData = [];
      try {
        airData = await this.fetchWAQIStations();
        console.log(`[Ingestion] WAQI returned ${airData.length} air readings`);
      } catch (waqiErr) {
        console.error('[Ingestion] WAQI phase failed (non-fatal):', waqiErr.message);
      }

      // If WAQI returned nothing (rate-limited, network down), fall back to simulated air
      if (airData.length === 0) {
        console.warn('[Ingestion] WAQI returned no data — falling back to simulated air');
        airData = simulator.generateAirFallback();
      }

      // === PHASE 2: Simulated Water + Noise ===
      const waterNoiseData = simulator.generateData(); // Now only water + noise
      console.log(`[Ingestion] Simulator returned ${waterNoiseData.length} water/noise readings`);

      // === PHASE 3: Combine All & Save to DB ===
      const allData = [...airData, ...waterNoiseData];

      if (allData.length > 0) {
        db.saveMonitoringDataBatch(allData);
        console.log(`[Ingestion] Saved ${allData.length} total readings to DB`);

        // Evaluate for compliance violations
        const complianceEngine = require('./compliance-engine');
        complianceEngine.evaluateBatch(allData);

        // === PHASE 4: Enrich with location data & Broadcast via SSE ===
        const locations = db.getAllMonitoringLocations();
        const locMap = new Map(locations.map(l => [l.id, l]));

        const airPayload = [];
        const waterPayload = [];
        const noisePayload = [];

        allData.forEach(d => {
          const loc = locMap.get(d.location_id);
          if (loc) {
            const enrichedData = { ...d, ...loc };
            enrichedData.location_id = d.location_id;
            enrichedData.id = d.location_id;

            if (d.type === 'air') airPayload.push(enrichedData);
            else if (d.type === 'water') waterPayload.push(enrichedData);
            else if (d.type === 'noise') noisePayload.push(enrichedData);
          }
        });

        this.latestDataCache.air = airPayload;
        this.latestDataCache.water = waterPayload;
        this.latestDataCache.noise = noisePayload;

        if (airPayload.length > 0) this.broadcast('air', airPayload);
        if (waterPayload.length > 0) this.broadcast('water', waterPayload);
        if (noisePayload.length > 0) this.broadcast('noise', noisePayload);
      }

    } catch (err) {
      console.error('[Ingestion] Error during hybrid cycle:', err);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Ingestion] === Hybrid cycle complete in ${duration}s ===`);
  }

  /* ---------- SCHEDULER ---------- */
  startScheduler(intervalMs = 60000) {
    // WAQI free tier: ~1000 req/day. At 60s intervals that's ~1440/day for feeds.
    // Using 60s interval (not 30s) to stay within limits.
    console.log(`[Ingestion] Hybrid scheduler started: every ${intervalMs / 1000}s`);
    
    // Run immediately first
    this.runFetchCycle();

    // Then interval
    this.intervalId = setInterval(() => {
      this.runFetchCycle();
    }, intervalMs);
  }

  stopScheduler() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[Ingestion] Scheduler stopped');
    }
  }
}

// Export singleton instance
const fetcherInstance = new Fetcher();
module.exports = fetcherInstance;
