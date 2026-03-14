const express = require('express');
const router = express.Router();
const db = require('../db');
const fetch = require('node-fetch');
const authz = require('../authz');

router.use(authz.attachActor);

const GEMINI_KEY = 'AIzaSyAQyqmDTcB_vCk6SiwVjfPsHCNvEizLDfY';
const GEMINI_MODEL = 'gemini-2.0-flash'; // High-capability model for the Copilot

function geminiUrl(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
}

// Helper to bundle all context for a specific location
function buildLiveContext(locationId) {
  // 1. Get the current status of the location
  const locations = db.getAllMonitoringLocations();
  const loc = locations.find(l => l.id === parseInt(locationId)) || locations[0]; // fallback
  
  if (!loc) return "No location active.";

  const rawDb = db.getDb();

  // 2. Get latest live readings
  const stmt1 = rawDb.prepare(`
    SELECT * FROM monitoring_data 
    WHERE location_id = ? AND type = ?
    ORDER BY recorded_at DESC LIMIT 1
  `);
  let airLatest = stmt1.get(loc.id, 'air') || {};
  let waterLatest = stmt1.get(loc.id, 'water') || {};
  let noiseLatest = stmt1.get(loc.id, 'noise') || {};

  // fallback if the actual ID mismatch (e.g demo vs location select)
  if (!airLatest.aqi) airLatest = rawDb.prepare(`SELECT * FROM monitoring_data WHERE type = 'air' ORDER BY recorded_at DESC LIMIT 1`).get() || {};
  if (!waterLatest.ph) waterLatest = rawDb.prepare(`SELECT * FROM monitoring_data WHERE type = 'water' ORDER BY recorded_at DESC LIMIT 1`).get() || {};
  if (!noiseLatest.noise_level_db) noiseLatest = rawDb.prepare(`SELECT * FROM monitoring_data WHERE type = 'noise' ORDER BY recorded_at DESC LIMIT 1`).get() || {};

  // 3. Get Prescribed Limits (table has NO location_id — it stores global CPCB/NAAQS limits)
  let limits = [];
  try {
     limits = rawDb.prepare(`SELECT * FROM prescribed_limits ORDER BY type, parameter`).all();
  } catch(e) { console.error('Limits Error:', e); }
  
  // 4. Get latest active alerts with location names
  let alerts = [];
  try {
     alerts = rawDb.prepare(`
       SELECT ca.*, ml.name as location_name 
       FROM compliance_alerts ca
       LEFT JOIN monitoring_locations ml ON ml.id = ca.location_id
       WHERE ca.status = 'open' OR ca.status = 'escalated'
       ORDER BY ca.created_at DESC LIMIT 10
     `).all();
  } catch(e) { console.error('Alerts Error:', e); }

  let context = `
========== DASHBOARD LIVE CONTEXT ==========
You are the PrithviNet AI Compliance Copilot. You assist government Regional Officers (ROs) and environmental regulators in analyzing data, determining compliance, and planning mitigation strategies.

Always use the following real-time data from the dashboard to answer the user's query:

[CURRENT FOCUS LOCATION]
Name: ${loc?.name || 'Unknown'}
Type: ${loc?.type || 'Unknown'}
Region: ${loc?.region || 'Unknown'}

[LATEST LIVE READINGS]
-- Air Quality --
AQI: ${airLatest?.aqi ?? 'N/A'}
PM2.5: ${airLatest?.pm25 ?? 'N/A'} µg/m³
PM10: ${airLatest?.pm10 ?? 'N/A'} µg/m³
SO2: ${airLatest?.so2 ?? 'N/A'} ppb
NO2: ${airLatest?.no2 ?? 'N/A'} ppb
CO: ${airLatest?.co ?? 'N/A'} mg/m³
O3: ${airLatest?.o3 ?? 'N/A'} ppb

-- Water Quality --
pH: ${waterLatest?.ph ?? 'N/A'}
DO: ${waterLatest?.dissolved_oxygen ?? 'N/A'} mg/L
BOD: ${waterLatest?.bod ?? 'N/A'} mg/L
COD: ${waterLatest?.cod ?? 'N/A'} mg/L
Turbidity: ${waterLatest?.turbidity ?? 'N/A'} NTU

-- Noise --
Level: ${noiseLatest?.noise_level_db ?? 'N/A'} dB(A)
Min: ${noiseLatest?.noise_min_db ?? 'N/A'} dB(A)
Max: ${noiseLatest?.noise_max_db ?? 'N/A'} dB(A)

[MANDATED LEGAL LIMITS (CPCB/NAAQS)]
${limits.map(l => `- ${l.type.toUpperCase()} / ${l.parameter}: ${l.limit_min !== null ? `Min ${l.limit_min}` : ''} ${l.limit_max !== null ? `Max ${l.limit_max}` : ''} ${l.unit} (${l.source})`).join('\n')}

[ACTIVE COMPLIANCE ALERT QUEUE (${alerts.length} active)]
${alerts.length === 0 ? 'No active alerts.' : alerts.map(a => `- [${(a.severity || 'warning').toUpperCase()}] ${a.location_name || 'Unknown'}: ${a.parameter} recorded ${a.recorded_value} vs limit ${a.prescribed_limit} (${a.message || ''})`).join('\n')}

INSTRUCTIONS:
1. Ground your analysis strictly on the numbers above.
2. If the user asks for a scenario simulation, use the Current Live Readings as your baseline, apply the simulation adjustments, check them against the Legal Limits, and output the required actions for the RO.
3. Format your response cleanly using Markdown (bullet points, bolding for emphasis on parameters, avoid overly verbose paragraphs).
============================================`;

  return context;
}


// POST /api/copilot/ask
router.post('/ask', async (req, res) => {
  try {
    const role = req.actor.role;
    if (role === authz.ROLES.INDUSTRY_USER || role === authz.ROLES.CITIZEN) {
      return res.status(403).json({ error: 'Copilot is disabled for this role' });
    }

    if (!req.body || !req.body.message) {
      return res.status(400).json({ error: 'Missing message' });
    }

    const { message, location_id } = req.body;
    
    // Dynamic Context Injection
    const liveContextContext = buildLiveContext(location_id || 1);

    const monitorTeamPolicy = role === authz.ROLES.MONITORING_TEAM
      ? '\n\nROLE POLICY: Provide advisory-only field guidance. Do not issue escalation orders or regulatory commands.'
      : '';

    const fullPrompt = `${liveContextContext}${monitorTeamPolicy}\n\nUSER QUERY: ${message}\n\nYOUR RESPONSE:`;

    const payload = {
      contents: [{ parts: [{ text: fullPrompt }] }],
      generationConfig: { temperature: 0.2 } // Keep it deterministic and factual
    };

    const url = geminiUrl(GEMINI_MODEL);
    const response = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload)
    });

    const json = await response.json();
    
    if (json.error) {
       console.error('[Copilot] API Error:', JSON.stringify(json.error));
       return res.status(502).json({ error: 'Upstream AI Error', details: json.error });
    }

    // Extract text from Gemini response safely
    let answerText = "Sorry, I could not generate a response. The AI model might be temporarily unavailable or out of quota.";
    try {
      if (json?.candidates?.[0]?.content?.parts?.[0]?.text) {
         answerText = json.candidates[0].content.parts[0].text;
      } else {
         console.warn('[Copilot] Unexpected Gemini Response Format:', JSON.stringify(json).substring(0, 200));
      }
    } catch(e) {
      console.error('[Copilot] Parse Error:', e);
    }

    res.json({ status: 'ok', text: answerText });

  } catch (err) {
    console.error('[Copilot] Route Error:', err);
    res.status(500).json({ error: err.message || 'Failed to process copilot query' });
  }
});

module.exports = router;
