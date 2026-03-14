/* ==========================================
   PrithviNet — REST API Routes
   ========================================== */

'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db');
const fetcher = require('../fetcher');
const fetch   = require('node-fetch');
const authz   = require('../authz');

router.use(authz.attachActor);

const GEMINI_KEY = 'AIzaSyBL_3mmL4VNAifThsgfbui81kd31FNTnGY';
// Model fallback chain — each model has its own separate free-tier quota
const GEMINI_MODELS = [
  'gemini-2.0-flash-lite',     // lowest cost, highest RPM (30)
  'gemini-2.5-flash-lite',     // newer lite variant
  'gemini-2.0-flash',          // mid-tier
  'gemini-2.5-flash'           // newest flash
];
function geminiUrl(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
}

const DEFAULT_RECO_CONTEXT = {
  ward: 'Bhilai Steel Plant (Industrial Zone)',
  lat: 21.1938,
  lng: 81.3509,
  radiusKm: 25
};

/* ---------- WARD DATA (main dashboard feed) ---------- */
router.get('/wards', (req, res) => {
  try {
    let wards = db.getLatestWardAqi();
    // Citizen gets only public-safe aggregate ward fields.
    if (req.actor.role === authz.ROLES.CITIZEN) {
      wards = wards.map(w => ({ ward_name: w.ward_name, aqi: w.aqi, dominant: w.dominant }));
    }
    const city  = db.getCityAverage();
    res.json({ status: 'ok', city, wards, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/* ---------- CITY AVERAGE ---------- */
router.get('/city', (req, res) => {
  try {
    const city = db.getCityAverage();
    res.json({ status: 'ok', data: city });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/* ---------- ALL STATIONS ---------- */
router.get('/stations', (req, res) => {
  try {
    if (req.actor.role === authz.ROLES.CITIZEN) {
      return res.status(403).json({ status: 'error', message: 'Stations endpoint is not available for citizen role' });
    }
    const stations = db.getAllStations();
    const readings = db.getLatestReadings();
    res.json({ status: 'ok', stations, readings });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/* ---------- SINGLE STATION DETAIL ---------- */
router.get('/station/:uid', (req, res) => {
  try {
    const uid    = parseInt(req.params.uid);
    const detail = db.getStationDetail(uid);
    if (!detail.station) {
      return res.status(404).json({ status: 'error', message: 'Station not found' });
    }
    res.json({ status: 'ok', data: detail });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});



/* ---------- WARD HISTORY (trend) ---------- */
router.get('/ward-history', (req, res) => {
  try {
    const ward = req.query.ward;
    const days = parseInt(req.query.days) || 7;
    if (!ward) return res.status(400).json({ status: 'error', message: 'ward query param required' });
    const history = db.getWardHistory(ward, days);
    res.json({ status: 'ok', data: history });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/* ---------- CITY HISTORY (chart) ---------- */
router.get('/city-history', (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const history = db.getCityHistory(days);
    res.json({ status: 'ok', data: history });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/* ---------- FORCE REFRESH ---------- */
router.post('/refresh', async (req, res) => {
  try {
    if (!authz.hasRole(req, authz.ROLES.SUPER_ADMIN, authz.ROLES.REGIONAL_OFFICER)) {
      return res.status(403).json({ status: 'error', message: 'Only Super Admin or Regional Officer can trigger refresh' });
    }
    await fetcher.runFetchCycle();
    res.json({ status: 'ok', message: 'Fetch cycle completed' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/* ---------- CITIZEN REPORTS ---------- */

/** Submit a new report */
router.post('/reports', (req, res) => {
  try {
    if (!authz.hasRole(req, authz.ROLES.CITIZEN, authz.ROLES.MONITORING_TEAM, authz.ROLES.REGIONAL_OFFICER, authz.ROLES.SUPER_ADMIN)) {
      return res.status(403).json({ status: 'error', message: 'Role not allowed to submit reports' });
    }

    const { lat, lng, category, description, media, voter_uid } = req.body;
    if (!lat || !lng || !category) {
      return res.status(400).json({ status: 'error', message: 'lat, lng, category required' });
    }

    const actorVoterUid = req.actor.userId || 'anon';
    const effectiveVoter = req.actor.role === authz.ROLES.CITIZEN ? actorVoterUid : (voter_uid || actorVoterUid);

    const id = db.saveReport({
      lat, lng, category,
      description: description || '',
      media: media || null,
      voter_uid: effectiveVoter
    });
    res.json({ status: 'ok', id });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/** Get all active (non-expired) reports with confidence */
router.get('/reports', (req, res) => {
  try {
    const reports = db.getActiveReports();
    if (req.actor.role === authz.ROLES.INDUSTRY_USER) {
      return res.status(403).json({ status: 'error', message: 'Industry user cannot access citizen reports listing' });
    }
    let visible = reports;

    if (req.actor.role === authz.ROLES.CITIZEN) {
      visible = reports.filter(r => String(r.voter_uid) === String(req.actor.userId));
    } else if (req.actor.role === authz.ROLES.INDUSTRY_USER) {
      visible = [];
    }

    const enriched = visible.map(r => {
      const conf = db.getReportConfidence(r.id);
      const pollOpen = db.isPollOpen(r);
      const workflow = db.getReportWorkflow(r.id);
      const expiryHours = db.REPORT_EXPIRY[r.category] || 3;
      const created = new Date(r.created_at + 'Z').getTime();
      const expiresAt = new Date(created + expiryHours * 3600000).toISOString();
      const pollClosesAt = new Date(created + db.POLL_WINDOW_MINUTES * 60000).toISOString();
      return {
        ...r,
        confidence: conf,
        workflow: workflow || { status: 'new', priority: 'normal' },
        pollOpen,
        expiresAt,
        pollClosesAt
      };
    });
    res.json({ status: 'ok', reports: enriched });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/** Citizen self-tracking reports */
router.get('/reports/mine', (req, res) => {
  try {
    if (req.actor.role !== authz.ROLES.CITIZEN) {
      return res.status(403).json({ status: 'error', message: 'Only citizen role can use /reports/mine' });
    }
    const reports = db.getActiveReports().filter(r => String(r.voter_uid) === String(req.actor.userId));
    const enriched = reports.map(r => ({
      ...r,
      confidence: db.getReportConfidence(r.id),
      workflow: db.getReportWorkflow(r.id) || { status: 'new', priority: 'normal' }
    }));
    res.json({ status: 'ok', reports: enriched });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/** Vote on a report */
router.post('/reports/:id/vote', (req, res) => {
  try {
    if (req.actor.role !== authz.ROLES.CITIZEN) {
      return res.status(403).json({ status: 'error', message: 'Only citizen role can vote on reports' });
    }

    const reportId = parseInt(req.params.id);
    const { vote, voter_uid, lat, lng } = req.body;
    if (!vote || !['confirmed', 'false', 'unsure'].includes(vote)) {
      return res.status(400).json({ status: 'error', message: 'vote must be confirmed|false|unsure' });
    }
    const effectiveVoterUid = req.actor.userId || voter_uid;
    if (!effectiveVoterUid) return res.status(400).json({ status: 'error', message: 'voter_uid required' });
    const report = db.getReportById(reportId);
    if (!report) {
      return res.status(404).json({ status: 'error', message: 'Report not found' });
    }
    if (!db.isPollOpen(report)) {
      return res.status(410).json({ status: 'error', message: 'Poll has closed for this report' });
    }
    // Proximity check: voter must be within ~2km of report
    if (lat != null && lng != null) {
      const dist = haversine(lat, lng, report.lat, report.lng);
      if (dist > 10.0) {
        return res.status(403).json({ status: 'error', message: 'You must be near this report to vote' });
      }
    }
    db.addVote(reportId, effectiveVoterUid, vote, lat || null, lng || null);
    const conf = db.getReportConfidence(reportId);
    res.json({ status: 'ok', confidence: conf });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/** Get single report detail */
router.get('/reports/:id', (req, res) => {
  try {
    const reportId = parseInt(req.params.id);
    const report = db.getReportById(reportId);
    if (!report) return res.status(404).json({ status: 'error', message: 'Not found' });

    if (req.actor.role === authz.ROLES.CITIZEN && String(report.voter_uid) !== String(req.actor.userId)) {
      return res.status(403).json({ status: 'error', message: 'Citizen can only view own report detail' });
    }
    if (req.actor.role === authz.ROLES.INDUSTRY_USER) {
      return res.status(403).json({ status: 'error', message: 'Industry user cannot access citizen report detail directly' });
    }

    const conf = db.getReportConfidence(reportId);
    const pollOpen = db.isPollOpen(report);
    const workflow = db.getReportWorkflow(reportId) || { status: 'new', priority: 'normal' };
    res.json({ status: 'ok', report, confidence: conf, workflow, pollOpen });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/** Moderation / assignment workflow */
router.put('/reports/:id/workflow', (req, res) => {
  try {
    if (!authz.hasRole(req, authz.ROLES.SUPER_ADMIN, authz.ROLES.REGIONAL_OFFICER, authz.ROLES.MONITORING_TEAM)) {
      return res.status(403).json({ status: 'error', message: 'Role not allowed to update report workflow' });
    }

    const reportId = parseInt(req.params.id);
    const report = db.getReportById(reportId);
    if (!report) return res.status(404).json({ status: 'error', message: 'Report not found' });

    const curr = db.getReportWorkflow(reportId) || { status: 'new', priority: 'normal', assigned_team_id: null, note: null };
    const status = req.body?.status || curr.status;
    const priority = req.body?.priority || curr.priority;
    const assignedTeamId = req.body?.assigned_team_id ?? curr.assigned_team_id;
    const note = req.body?.note || curr.note || '';

    if (req.actor.role === authz.ROLES.MONITORING_TEAM) {
      if (!['verified', 'closed'].includes(status)) {
        return res.status(403).json({ status: 'error', message: 'Monitoring Team can set only verified/closed status' });
      }
      if (priority !== curr.priority || assignedTeamId !== curr.assigned_team_id) {
        return res.status(403).json({ status: 'error', message: 'Monitoring Team cannot reassign team or change priority' });
      }
    }

    if (req.actor.role === authz.ROLES.REGIONAL_OFFICER) {
      if (!['assigned', 'high_priority', 'verified', 'closed'].includes(status)) {
        return res.status(403).json({ status: 'error', message: 'Regional Officer can set assigned/high_priority/verified/closed status' });
      }
    }

    db.upsertReportWorkflow({
      report_id: reportId,
      status,
      priority,
      assigned_team_id: assignedTeamId || null,
      note,
      updated_by: req.actor.userId,
      updated_by_role: req.actor.role
    });

    res.json({ status: 'ok', workflow: db.getReportWorkflow(reportId) });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/** Haversine distance in km */
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* ---------- SSE: Real-time Updates ---------- */
router.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive'
  });

  fetcher.addSSEClient(res);

  // Heartbeat every 30s
  const heartbeat = setInterval(() => {
    try { res.write(`event: ping\ndata: {}\n\n`); } catch (_) {}
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    fetcher.removeSSEClient(res);
  });
});

/* ---------- GEMINI MITIGATION RECOMMENDATIONS ---------- */

// In-memory cache: { key: { data, ts } }
const recoCache = {};
const RECO_CACHE_TTL = 5 * 60 * 1000; // 5 min

router.get('/recommendations', async (req, res) => {
  try {
    const wardName = req.query.ward || DEFAULT_RECO_CONTEXT.ward;
    const centerLat = Number.isFinite(Number(req.query.lat)) ? Number(req.query.lat) : DEFAULT_RECO_CONTEXT.lat;
    const centerLng = Number.isFinite(Number(req.query.lng)) ? Number(req.query.lng) : DEFAULT_RECO_CONTEXT.lng;
    const radiusKm = Number.isFinite(Number(req.query.radius_km)) ? Number(req.query.radius_km) : DEFAULT_RECO_CONTEXT.radiusKm;

    // 1. Get ward AQI
    const wards = db.getLatestWardAqi();
    const ward = wards.find(w => w.ward_name === wardName) || wards[0] || {};

    // 2. Get active reports near this ward
    const activeReports = db.getActiveReports();
    const regionReports = activeReports.filter(r => {
      if (!Number.isFinite(Number(r.lat)) || !Number.isFinite(Number(r.lng))) return false;
      return haversine(centerLat, centerLng, Number(r.lat), Number(r.lng)) <= radiusKm;
    });
    // Format reports with TTL info
    const REPORT_EXPIRY = db.REPORT_EXPIRY;
    const now = Date.now();
    const nearbyReports = regionReports.map(r => {
      const expiryH = REPORT_EXPIRY[r.category] || 3;
      const created = new Date(r.created_at + 'Z').getTime();
      const expiresAt = created + expiryH * 3600000;
      const minsLeft = Math.max(0, Math.round((expiresAt - now) / 60000));
      const conf = db.getReportConfidence(r.id);
      return {
        category: r.category,
        description: r.description,
        minsUntilExpiry: minsLeft,
        hoursUntilExpiry: (minsLeft / 60).toFixed(1),
        confidence: conf.score,
        confidenceLabel: conf.label
      };
    });

    // 3. Build cache key
    const cacheKey = `${wardName}_${ward.aqi || 0}_${nearbyReports.length}_${centerLat.toFixed(3)}_${centerLng.toFixed(3)}_${radiusKm}`;
    if (recoCache[cacheKey] && (now - recoCache[cacheKey].ts) < RECO_CACHE_TTL) {
      return res.json({ status: 'ok', ...recoCache[cacheKey].data, cached: true });
    }

    // 4. Build Gemini prompt
    const prompt = buildRecoPrompt(wardName, ward, nearbyReports);

    // 5. Call Gemini — try each model until one succeeds
    const payload = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 1024,
        responseMimeType: 'application/json'
      }
    });

    let geminiJson = null;
    for (const model of GEMINI_MODELS) {
      try {
        const resp = await fetch(geminiUrl(model), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload
        });
        if (resp.ok) {
          geminiJson = await resp.json();
          console.log('[Gemini] Success with model:', model);
          break;
        }
        const errText = await resp.text();
        console.warn(`[Gemini] ${model} → ${resp.status}, trying next...`);
      } catch (fetchErr) {
        console.warn(`[Gemini] ${model} fetch error:`, fetchErr.message);
      }
    }

    if (!geminiJson) {
      console.error('[Gemini] All models exhausted, using local fallback');
      const fb = buildFallbackReco(wardName, ward, nearbyReports);
      recoCache[cacheKey] = { data: fb, ts: now };
      return res.json({ status: 'ok', ...fb, fallback: true });
    }

    const rawText = geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (_) {
      // Try to extract JSON from markdown code blocks
      const match = rawText.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (match) parsed = JSON.parse(match[1]);
      else parsed = { headline: 'Stay Safe', summary: rawText, outdoor: [], indoor: [], alerts: [] };
    }

    const result = {
      ward: wardName,
      aqi: ward.aqi || 0,
      dominant: ward.dominant || 'PM2.5',
      headline: parsed.headline || 'Air Quality Advisory',
      summary: parsed.summary || '',
      confidence: parsed.confidence || (ward.aqi ? '~95%' : 'N/A'),
      outdoor: (parsed.outdoor || []).slice(0, 3),
      indoor: (parsed.indoor || []).slice(0, 3),
      alerts: (parsed.alerts || []).slice(0, 3),
      reportCount: nearbyReports.length,
      generatedAt: new Date().toISOString()
    };

    // Cache it
    recoCache[cacheKey] = { data: result, ts: now };

    res.json({ status: 'ok', ...result });
  } catch (err) {
    console.error('[Recommendations]', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/* ---------- FALLBACK when Gemini is rate-limited ---------- */
function buildFallbackReco(wardName, ward, reports) {
  const aqi = ward.aqi || 0;
  let headline, summary, level;
  if (aqi <= 50)       { headline = 'Air Quality is Good'; summary = 'Air quality is satisfactory. Enjoy outdoor activities freely.'; level = 'good'; }
  else if (aqi <= 100) { headline = 'Moderate Air Quality'; summary = 'Air quality is acceptable. Sensitive individuals should limit prolonged outdoor exertion.'; level = 'moderate'; }
  else if (aqi <= 200) { headline = 'Unhealthy for Sensitive'; summary = 'Members of sensitive groups may experience health effects. General public less likely to be affected.'; level = 'unhealthy-sg'; }
  else if (aqi <= 300) { headline = 'Unhealthy Air Quality'; summary = 'Everyone may begin to experience health effects. Sensitive groups may experience more serious effects.'; level = 'unhealthy'; }
  else if (aqi <= 400) { headline = 'Very Unhealthy Air'; summary = 'Health alert: everyone may experience serious health effects. Avoid outdoor activity.'; level = 'very-unhealthy'; }
  else                 { headline = 'Hazardous Air Quality'; summary = 'Health emergency. Everyone is at serious risk. Stay indoors with air purifiers.'; level = 'hazardous'; }

  const outdoorMap = {
    'good':           [{title:'Enjoy Outdoors',detail:'Air is clean — safe for jogging, cycling and walks.'},{title:'Stay Hydrated',detail:'Drink water regularly during outdoor exercise.'},{title:'Check Forecast',detail:'Monitor PrithviNet for any sudden changes in air quality.'}],
    'moderate':       [{title:'Limit Strenuous Activity',detail:'Reduce prolonged outdoor exertion if you feel symptoms.'},{title:'Wear Light Mask',detail:'Consider N95 mask for cycling or roadside activities.'},{title:'Avoid Rush Hours',detail:'Peak traffic times push roadside PM2.5 higher.'}],
    'unhealthy-sg':   [{title:'Reduce Outdoor Time',detail:'Keep outdoor sessions under 30 minutes.'},{title:'Wear N95 Mask',detail:'Use a well-fitted N95 respirator for any outdoor trips.'},{title:'Avoid Busy Roads',detail:'Roadside pollution is significantly elevated.'}],
    'unhealthy':      [{title:'Stay Indoors',detail:'Avoid outdoor exercise entirely if possible.'},{title:'N95 Required Outside',detail:'Mandatory N95 mask for any essential outdoor trips.'},{title:'Reschedule Activities',detail:'Postpone non-essential outdoor plans.'}],
    'very-unhealthy': [{title:'Avoid Going Outside',detail:'Do not exercise outdoors. Move all activities indoors.'},{title:'Seal Windows',detail:'Keep all windows and doors shut to prevent infiltration.'},{title:'Essential Trips Only',detail:'Use N95 mask + minimize time outside.'}],
    'hazardous':      [{title:'Do Not Go Outside',detail:'Health emergency — remain indoors at all times.'},{title:'Emergency Mask Only',detail:'If you must go out, use N95 and limit to minutes.'},{title:'Seek Medical Help',detail:'Visit a doctor if you feel breathlessness or chest pain.'}]
  };
  const indoorMap = {
    'good':           [{title:'Ventilate Naturally',detail:'Open windows to let fresh air circulate.'},{title:'Add Indoor Plants',detail:'Spider plants and pothos help filter indoor air.'},{title:'Dust Regularly',detail:'Keep surfaces clean to maintain good indoor air.'}],
    'moderate':       [{title:'Run Air Purifier',detail:'Use HEPA purifier in bedrooms and living areas.'},{title:'Limit Cooking Smoke',detail:'Use exhaust fan while cooking to reduce PM2.5 spikes.'},{title:'Monitor Indoor AQI',detail:'Use an indoor air quality monitor if available.'}],
    'unhealthy-sg':   [{title:'Air Purifier On',detail:'Run HEPA purifiers on medium/high in all occupied rooms.'},{title:'Seal Gaps',detail:'Use towels or tape to block gaps around doors and windows.'},{title:'Avoid Candles & Incense',detail:'These add particulate matter to already-stressed indoor air.'}],
    'unhealthy':      [{title:'Purifiers on High',detail:'Maximize HEPA filtration in every occupied room.'},{title:'Wet Mop Floors',detail:'Wet-mopping captures settled particles better than sweeping.'},{title:'Hydrate & Rest',detail:'Drink warm water and avoid strenuous indoor exercise.'}],
    'very-unhealthy': [{title:'Max Purification',detail:'Run all available HEPA purifiers on highest setting.'},{title:'Create Clean Room',detail:'Designate one sealed room with purifier for sleeping.'},{title:'Avoid Cooking Fumes',detail:'Prefer no-cook meals or use exhaust fan on maximum.'}],
    'hazardous':      [{title:'Seal Everything',detail:'Tape window edges and door cracks. Use wet towels at gaps.'},{title:'Clean Room Shelter',detail:'Stay in a single purified room as much as possible.'},{title:'Medical Supplies Ready',detail:'Keep inhalers, masks, and emergency contacts accessible.'}]
  };

  const alerts = [];
  if (reports.length > 0) {
    reports.slice(0, 3).forEach(r => {
      alerts.push({ text: `Active ${r.category} report nearby (${r.confidenceLabel}) — take precautions`, timeLeft: `${r.hoursUntilExpiry}h` });
    });
  }

  return {
    ward: wardName,
    aqi,
    dominant: ward.dominant || 'PM2.5',
    headline,
    summary,
    confidence: aqi ? '~80%' : 'N/A',
    outdoor: outdoorMap[level],
    indoor: indoorMap[level],
    alerts,
    reportCount: reports.length,
    generatedAt: new Date().toISOString()
  };
}

function buildRecoPrompt(wardName, ward, reports) {
  const reportsDesc = reports.length > 0
    ? reports.map(r =>
        `- ${r.category} report (${r.confidenceLabel} confidence: ${r.confidence}%): "${r.description}" — expires in ${r.hoursUntilExpiry}h (${r.minsUntilExpiry} min)`
      ).join('\n')
    : 'No active citizen reports.';

  return `You are PrithviNet, a concise environmental monitoring advisor.
Ward: "${wardName}" | AQI: ${ward.aqi || 'N/A'} | PM2.5: ${ward.pm25 || 'N/A'} | PM10: ${ward.pm10 || 'N/A'} | Dominant: ${ward.dominant || 'PM2.5'}
Reports: ${reportsDesc}

Rules — be VERY concise, NO markdown, plain text only:
- headline: max 5 words
- summary: 1 short sentence
- Each outdoor/indoor item: title (2-4 words, no asterisks), detail (max 12 words, specific action)
- If reports exist, reference category + time left in outdoor tips
- alerts: only for active reports, include category + remaining time + 1 action. Empty array if none.

Return ONLY JSON:
{"headline":"string","summary":"string","confidence":"string like 86%","outdoor":[{"title":"string","detail":"string"}],"indoor":[{"title":"string","detail":"string"}],"alerts":[{"text":"string","timeLeft":"string like 2h 15m"}]}`;
}

/* ==========================================
   CIVIC MONITORING & MITIGATION APIs
   ========================================== */

/** Haversine for civic ward–report proximity (reuse existing) */
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
    Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Compute trend from AQI history array [newest…oldest] */
function computeTrend(history) {
  if (!history || history.length < 2) return 'stable';
  const latest = history[0];
  const oldest = history[history.length - 1];
  const diff = latest - oldest;
  if (diff > 10) return 'rising';
  if (diff < -10) return 'falling';
  return 'stable';
}

/** Core ward summary builder (shared by ward-summary & hotspots) */
function buildWardSummaries() {
  const wards = db.getLatestWardAqi();
  const reports = db.getActiveReports();
  const trends = db.getAllWardTrends();
  const REPORT_EXPIRY = db.REPORT_EXPIRY;
  const now = Date.now();

  return wards.map(ward => {
    const wardName = ward.ward_name;
    const currentAQI = ward.aqi || 0;

    // Trend from history
    const histVals = trends[wardName] || [];
    const trend = computeTrend(histVals);

    // Reports near this ward (within 2km of ward centroid — approx from ward_aqi lat proxy)
    // ward_aqi doesn't store lat/lng, so use report proximity to each other
    // We'll match reports by ward_name substring or just use all reports (prototype)
    const wardReports = reports.map(r => {
      const conf = db.getReportConfidence(r.id);
      const expiryH = REPORT_EXPIRY[r.category] || 3;
      const created = new Date(r.created_at + 'Z').getTime();
      const expiresAt = created + expiryH * 3600000;
      const minsLeft = Math.max(0, Math.round((expiresAt - now) / 60000));
      return { ...r, confidence: conf.score, confidenceLabel: conf.label, minsLeft };
    });

    const totalReports = wardReports.length;
    const verifiedReports = wardReports.filter(r => r.confidence > 70).length;

    // Risk score
    const AQI_W = 0.5, REPORT_W = 0.3, TREND_W = 0.2;
    const normAQI = Math.min(currentAQI / 500, 1);
    const normReports = Math.min(verifiedReports / 5, 1);
    const risingFlag = trend === 'rising' ? 1 : 0;
    const riskScore = Math.round((AQI_W * normAQI + REPORT_W * normReports + TREND_W * risingFlag) * 100);

    // Hotspot detection
    const isHotspot = verifiedReports >= 3 && trend === 'rising';
    // Also flag if AQI > 300 with any verified reports
    const isEmergency = currentAQI > 300 && verifiedReports >= 1;

    // Category breakdown
    const categories = {};
    wardReports.forEach(r => { categories[r.category] = (categories[r.category] || 0) + 1; });

    return {
      ward_name: wardName,
      aqi: currentAQI,
      pm25: ward.pm25 || 0,
      pm10: ward.pm10 || 0,
      no2: ward.no2 || 0,
      dominant: ward.dominant || 'PM2.5',
      trend,
      trend_history: histVals,
      total_reports: totalReports,
      verified_reports: verifiedReports,
      categories,
      risk_score: riskScore,
      is_hotspot: isHotspot || isEmergency,
      hotspot_type: isEmergency ? 'emergency' : (isHotspot ? 'active_event' : null)
    };
  });
}

/* ---------- GET /api/civic/ward-summary ---------- */
router.get('/civic/ward-summary', (req, res) => {
  try {
    const summaries = buildWardSummaries();
    summaries.sort((a, b) => b.risk_score - a.risk_score);

    res.json({
      ok: true,
      timestamp: new Date().toISOString(),
      total_wards: summaries.length,
      severe_count: summaries.filter(w => w.risk_score >= 70).length,
      hotspot_count: summaries.filter(w => w.is_hotspot).length,
      top5: summaries.slice(0, 5),
      all: summaries
    });
  } catch (err) {
    console.error('[Civic] ward-summary error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ---------- GET /api/civic/hotspots ---------- */
router.get('/civic/hotspots', (req, res) => {
  try {
    const summaries = buildWardSummaries();
    const hotspots = summaries
      .filter(w => w.is_hotspot)
      .sort((a, b) => b.risk_score - a.risk_score)
      .map(w => ({
        ...w,
        event: w.hotspot_type === 'emergency' ? 'Pollution Emergency' : 'Active Pollution Event',
        severity: w.risk_score >= 80 ? 'critical' : 'warning'
      }));

    res.json({ ok: true, hotspots, count: hotspots.length });
  } catch (err) {
    console.error('[Civic] hotspots error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ---------- GET /api/civic/recommendations?ward=X ---------- */
const civicRecoCache = {};
const CIVIC_RECO_TTL = 5 * 60 * 1000;

router.get('/civic/recommendations', async (req, res) => {
  try {
    const wardName = req.query.ward;
    if (!wardName) return res.status(400).json({ ok: false, error: 'ward param required' });

    const summaries = buildWardSummaries();
    const ward = summaries.find(w => w.ward_name === wardName) || summaries[0];
    if (!ward) return res.status(404).json({ ok: false, error: 'Ward not found' });

    const now = Date.now();
    const cacheKey = `civic_${wardName}_${ward.aqi}_${ward.verified_reports}`;
    if (civicRecoCache[cacheKey] && (now - civicRecoCache[cacheKey].ts) < CIVIC_RECO_TTL) {
      return res.json({ ok: true, ...civicRecoCache[cacheKey].data, cached: true });
    }

    // Build administration prompt — purely for municipal officials, NOT citizens
    const catStr = Object.entries(ward.categories).map(([k,v]) => `${v} ${k}`).join(', ') || 'none';
    const prompt = `You are PrithviNet, an AI advisor for environmental monitoring and pollution control officers.
This is for GOVERNMENT OFFICIALS ONLY — not citizens. Never suggest personal actions like "wear mask" or "stay indoors".

Ward: "${wardName}" | AQI: ${ward.aqi} (${ward.trend}) | PM2.5: ${ward.pm25} | PM10: ${ward.pm10} | Dominant: ${ward.dominant}
Verified citizen reports: ${ward.verified_reports} (${catStr})
Risk score: ${ward.risk_score}/100

Give exactly 5 ADMINISTRATIVE mitigation orders. Each must be an official action a municipal body can execute.
Examples of valid actions: deploy inspection team, issue construction stop-work notice, increase mechanical road sweeping, activate water sprinkling tankers, issue public health advisory, coordinate with traffic police for diversions, send industrial emission audit team, escalate to GRAP Stage-II, order school closure advisory, set up air quality monitoring van, enforce anti-open-burning patrols, coordinate with fire department.
NO citizen-facing advice. NO markdown. Plain text only.

Return ONLY JSON:
{"actions":[{"title":"3-5 word directive","detail":"1 line specific administrative order with target area or department","urgency":"high|medium|low","dept":"responsible department or agency"}],"assessment":"1 sentence situation assessment for the ward commissioner"}`;

    const payload = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 512, responseMimeType: 'application/json' }
    });

    let geminiJson = null;
    for (const model of GEMINI_MODELS) {
      try {
        const resp = await fetch(geminiUrl(model), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload
        });
        if (resp.ok) { geminiJson = await resp.json(); console.log('[Civic Gemini] Success:', model); break; }
        console.warn(`[Civic Gemini] ${model} → ${resp.status}, next...`);
      } catch (e) { console.warn(`[Civic Gemini] ${model} error:`, e.message); }
    }

    let actions, assessment;
    if (geminiJson) {
      const raw = geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      try {
        const parsed = JSON.parse(raw);
        actions = (parsed.actions || []).slice(0, 5).map(a => ({
          title: a.title || 'Action Required',
          detail: a.detail || '',
          urgency: a.urgency || 'medium',
          dept: a.dept || 'Municipal Administration'
        }));
        assessment = parsed.assessment || '';
      } catch (_) {
        actions = null;
      }
    }

    // Fallback if Gemini fails — rule-based admin actions only
    let usedFallback = false;
    if (!actions || actions.length === 0) {
      actions = buildCivicFallback(ward);
      assessment = `Ward ${wardName}: AQI ${ward.aqi} (${ward.trend}), ${ward.verified_reports} verified citizen reports, risk ${ward.risk_score}/100. Immediate administrative review recommended.`;
      usedFallback = true;
    }

    const result = {
      ward_name: wardName,
      aqi: ward.aqi,
      trend: ward.trend,
      risk_score: ward.risk_score,
      verified_reports: ward.verified_reports,
      categories: ward.categories,
      actions,
      assessment,
      source: usedFallback ? 'rules' : 'ai',
      generatedAt: new Date().toISOString()
    };

    civicRecoCache[cacheKey] = { data: result, ts: now };
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[Civic] recommendations error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** Rule-based fallback — strictly administrative mitigation orders with departments */
function buildCivicFallback(ward) {
  const actions = [];
  const aqi = ward.aqi || 0;
  const cats = ward.categories || {};

  // --- HIGH URGENCY ---
  if (aqi > 400) {
    actions.push({ title: 'Declare Pollution Emergency', detail: 'Escalate to GRAP Stage-IV — halt all non-essential construction, ban diesel generators, enforce odd-even', urgency: 'high', dept: 'CPCB / DPCC' });
    actions.push({ title: 'Issue School Closure Order', detail: 'Close all primary schools and shift secondary to online mode for 48 hours', urgency: 'high', dept: 'Directorate of Education' });
  } else if (aqi > 300) {
    actions.push({ title: 'Activate GRAP Stage-III', detail: 'Ban construction dust-generating activities, enforce mechanical sweeping on arterial roads', urgency: 'high', dept: 'DPCC / PWD' });
    actions.push({ title: 'Deploy Emergency Sprinklers', detail: 'Station 10+ water tankers for continuous road sprinkling in ward hotspot zones', urgency: 'high', dept: 'MCD Public Works' });
  } else if (aqi > 200) {
    actions.push({ title: 'Increase Mechanical Sweeping', detail: 'Double road sweeper deployment frequency on all ward trunk roads', urgency: 'high', dept: 'MCD Sanitation' });
  }

  // --- REPORT-BASED ACTIONS ---
  if (cats.construction > 0) {
    actions.push({ title: 'Issue Stop-Work Notice', detail: `Dispatch inspection team — ${cats.construction} construction complaint(s). Enforce dust barriers and anti-smog guns`, urgency: 'high', dept: 'Building Dept / DPCC' });
  }
  if (cats.burning > 0) {
    actions.push({ title: 'Deploy Anti-Burning Patrol', detail: `${cats.burning} open burning report(s) — send enforcement squad with penalty challans`, urgency: 'high', dept: 'Fire Dept / MCD Enforcement' });
  }
  if (cats.industrial > 0) {
    actions.push({ title: 'Industrial Emission Audit', detail: `Send emission monitoring van — ${cats.industrial} industrial complaint(s). Check CPCB compliance`, urgency: 'high', dept: 'DPCC / Industrial Inspector' });
  }
  if (cats.vehicle > 0) {
    actions.push({ title: 'Traffic Diversion Order', detail: `Coordinate with traffic police — ${cats.vehicle} vehicle emission report(s). Deploy PUC checkpoints`, urgency: 'medium', dept: 'Traffic Police / Transport Dept' });
  }

  // --- TREND-BASED ---
  if (ward.trend === 'rising') {
    actions.push({ title: 'Escalation Watch Active', detail: 'AQI rising — pre-position GRAP resources and notify ward commissioner for next-stage readiness', urgency: 'medium', dept: 'Ward Commissioner Office' });
  }

  // --- MODERATE AQI STANDARD ACTIONS ---
  if (aqi > 150 && actions.length < 5) {
    actions.push({ title: 'Activate Water Sprinkling', detail: 'Deploy water sprinkling tankers on high-traffic corridors during peak hours', urgency: 'medium', dept: 'MCD Public Works' });
  }
  if (aqi > 100 && actions.length < 5) {
    actions.push({ title: 'Issue Public Advisory', detail: 'Push IVR and SMS advisory to ward residents about outdoor activity restrictions', urgency: 'medium', dept: 'District Magistrate Office' });
  }
  if (actions.length < 5) {
    actions.push({ title: 'Increase Monitoring Frequency', detail: 'Set mobile AQI monitoring van to 2-hourly measurement cycles in ward', urgency: 'low', dept: 'DPCC Monitoring Cell' });
  }
  if (actions.length < 5) {
    actions.push({ title: 'Standard Compliance Check', detail: 'Routine inspection of construction sites and industrial units for emission norms', urgency: 'low', dept: 'MCD Enforcement Wing' });
  }

  return actions.slice(0, 5);
}

/* ---------- GET /api/civic/timeline ---------- */
router.get('/civic/timeline', (req, res) => {
  try {
    const reports = db.getActiveReports();
    const REPORT_EXPIRY = db.REPORT_EXPIRY;
    const now = Date.now();

    const events = [];

    reports.forEach(r => {
      const created = new Date(r.created_at + 'Z').getTime();
      const expiryH = REPORT_EXPIRY[r.category] || 3;
      const expiresAt = created + expiryH * 3600000;
      const conf = db.getReportConfidence(r.id);

      events.push({
        type: 'report_created',
        time: r.created_at,
        category: r.category,
        description: r.description,
        report_id: r.id,
        icon: '📝'
      });

      if (conf.totalVotes > 0 && conf.score >= 70) {
        events.push({
          type: 'report_verified',
          time: r.created_at, // approximate
          category: r.category,
          report_id: r.id,
          confidence: conf.score,
          icon: '✅'
        });
      }

      if (expiresAt < now) {
        events.push({
          type: 'report_expired',
          time: new Date(expiresAt).toISOString().replace('Z', ''),
          category: r.category,
          report_id: r.id,
          icon: '⏰'
        });
      }
    });

    // Sort newest first
    events.sort((a, b) => new Date(b.time + 'Z') - new Date(a.time + 'Z'));

    res.json({ ok: true, events });
  } catch (err) {
    console.error('[Civic] timeline error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
