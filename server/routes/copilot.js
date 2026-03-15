const express = require('express');
const router = express.Router();
const db = require('../db');
const fetch = require('node-fetch');
const authz = require('../authz');

router.use(authz.attachActor);

const GEMINI_KEY = 'AIzaSyB1HmGRqtyMI7tcmvCxkE8tCUz025NVt9w';
const GEMINI_MODEL = 'gemini-3-flash-preview';

function geminiUrl(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
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
    
    // 1. Fetch live database context
    const rawDb = db.getDb();
    
    let monitoringData = [];
    try {
      monitoringData = rawDb.prepare(`
        SELECT md.*, ml.name as location_name 
        FROM monitoring_data md
        LEFT JOIN monitoring_locations ml ON ml.id = md.location_id
        ORDER BY md.recorded_at DESC LIMIT 15
      `).all();
    } catch (e) {
      console.error('[Copilot] Failed to fetch monitoring data:', e.message);
    }

    let complianceAlerts = [];
    try {
      complianceAlerts = rawDb.prepare(`
        SELECT ca.*, ml.name as location_name
        FROM compliance_alerts ca
        LEFT JOIN monitoring_locations ml ON ml.id = ca.location_id
        WHERE ca.status IN ('open', 'new', 'escalated', 'acknowledged', 'in_action')
      `).all();
    } catch (e) {
      console.error('[Copilot] Failed to fetch compliance alerts:', e.message);
    }

    // 2. Build system instruction
    const dbContext = JSON.stringify({ 
      monitoring_data: monitoringData, 
      compliance_alerts: complianceAlerts 
    }, null, 2);

    const systemInstruction = `You are the PrithviNet Predictive Causal Engine, an advanced AI surrogate model for environmental compliance. You have access to live IoT telemetry and active compliance alerts:
${dbContext}

When the user asks a 'What-If' intervention query (e.g., emissions reductions, temporary shutdowns), you must act as a structural model and calculate the projected outcomes. Analyze the current baseline data from the injected JSON and generate a highly analytical response covering:
1. Baseline vs. Intervention: State the current pollution load based on the data, and mathematically estimate the reduction (e.g., 'A 30% reduction in SO2 from X equates to a drop from Y µg/m³ to Z µg/m³').
2. Regional Risk Projection: Predict how this intervention changes the risk profile for surrounding residential/civic wards over the requested timeline.
3. Causal Cascades: Identify secondary benefits (e.g., reduced PM2.5 formation, lower water turbidity).
4. Policy Recommendations: Suggest how the Regional Officer should monitor or enforce this intervention.

Format your response in professional Markdown, using bullet points and bold text for readability. Sound highly analytical, scientific, and data-driven.`;

    // 3. Construct prompt
    const fullPrompt = `${systemInstruction}\n\nUSER QUERY: ${message}\n\nYOUR RESPONSE:`;

    const payload = {
      contents: [{ parts: [{ text: fullPrompt }] }],
      generationConfig: { temperature: 0.1 } // Extremely low temperature for strict formatting compliance
    };

    // 4. API Call
    const url = geminiUrl(GEMINI_MODEL);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const json = await response.json();

    if (json.error) {
      console.error('[Copilot] Gemini API Error:', json.error);
      return res.status(502).json({ error: 'Upstream AI Error', details: json.error });
    }

    let answerText = "Sorry, I could not generate a response. The AI model might be temporarily unavailable.";
    try {
      if (json?.candidates?.[0]?.content?.parts?.[0]?.text) {
        answerText = json.candidates[0].content.parts[0].text;
      } else {
        console.warn('[Copilot] Unexpected response format:', JSON.stringify(json).substring(0, 200));
      }
    } catch (e) {
      console.error('[Copilot] Parse Error:', e);
    }

    res.json({ status: 'ok', text: answerText });

  } catch (err) {
    console.error('[Copilot] Route Error:', err);
    res.status(500).json({ error: err.message || 'Failed to process copilot query' });
  }
});

// POST /api/copilot/summarize-msg
router.post('/summarize-msg', async (req, res) => {
  try {
    const role = req.actor.role;
    if (role === authz.ROLES.INDUSTRY_USER || role === authz.ROLES.CITIZEN) {
      return res.status(403).json({ error: 'Copilot is disabled for this role' });
    }

    if (!req.body || !req.body.text) {
      return res.status(400).json({ error: 'Missing text to summarize' });
    }

    const { text } = req.body;
    
    const prompt = `Summarize the following environmental analysis into a crisp, 2-sentence executive TL;DR. Do not use markdown headers: \n\n${text}`;
    
    const payload = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2 }
    };

    const url = geminiUrl(GEMINI_MODEL);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const json = await response.json();

    if (json.error) {
      console.error('[Copilot] Gemini API Error (Summarize):', json.error);
      return res.status(502).json({ error: 'Upstream AI Error', details: json.error });
    }

    let summaryText = "Failed to generate summary.";
    if (json?.candidates?.[0]?.content?.parts?.[0]?.text) {
      summaryText = json.candidates[0].content.parts[0].text;
    }

    res.json({ status: 'ok', summary: summaryText });
  } catch (err) {
    console.error('[Copilot] Summarize Route Error:', err);
    res.status(500).json({ error: err.message || 'Failed to process summarize query' });
  }
});

module.exports = router;
