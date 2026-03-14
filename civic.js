'use strict';

const API = window.location.origin + '/api';

/* ========== STATE ========== */
let activeViolations = [];
let allIndustries = [];

/* ========== INIT ========== */
document.addEventListener('DOMContentLoaded', async () => {
  await fetchIndustries();
  await loadTracker();
  await loadIndustrialLogs();
  
  // Refresh every 30s
  setInterval(() => {
    loadTracker();
    loadIndustrialLogs();
  }, 30000);
});

/* ========== FETCHERS ========== */

async function fetchIndustries() {
  try {
    const res = await fetch(`${API}/entities/industries`);
    const json = await res.json();
    if (json.status === 'ok') {
      allIndustries = json.data;
      const select = document.getElementById('industry-filter');
      allIndustries.forEach(ind => {
        const op = document.createElement('option');
        op.value = ind.id;
        op.textContent = ind.name;
        select.appendChild(op);
      });
    }
  } catch (err) {
    console.error('Failed to fetch industries', err);
  }
}

async function loadTracker() {
  try {
    const res = await fetch(`${API}/compliance/alerts`);
    const json = await res.json();
    activeViolations = json || [];
    renderTracker();
  } catch(err) {
    console.error('Failed to fetch alerts', err);
    document.getElementById('tracker-body').innerHTML = `<tr><td colspan="7">Error loading compliance data.</td></tr>`;
  }
}

async function loadIndustrialLogs() {
  try {
    const industryId = document.getElementById('industry-filter').value;
    // We will dynamically query monitoring_data endpoint (we need to add this to the backend or use alerts as logs for now)
    // For now, let's fetch the alerts for this specific industry to populate the logs as a fallback
    // In a real scenario, this would query a /logs endpoint.
    let url = `${API}/compliance/alerts`;
    const res = await fetch(url);
    let alerts = await res.json();
    
    if (industryId !== 'all') {
      alerts = alerts.filter(a => a.industry_id == industryId);
    }
    
    renderLogs(alerts);
  } catch (err) {
    console.error('Failed to fetch logs', err);
    document.getElementById('logs-list').innerHTML = `<div style="color:#ef4444; padding:20px;">Failed to load logs.</div>`;
  }
}

/* ========== HELPERS ========== */

// Risk Scoring Logic based on Deviation
function calculateMultiParamRisk(current, limit) {
  // Deviation percentage
  const dev = ((current - limit) / limit) * 100;
  
  let score = 0;
  let color = '#94a3b8'; // default
  
  if (dev < 0) { score = 10; color = '#34d399'; } // Compliant
  else if (dev <= 10) { score = 40; color = '#fbbf24'; } // Warning
  else if (dev <= 50) { score = 75; color = '#f87171'; } // Violation
  else { score = 95; color = '#ef4444'; } // Critical Deviation
  
  return { score, color, deviation: dev };
}

function getStatusBadge(status) {
  const map = {
    'open': '<span class="status-badge status-violation">Violation</span>',
    'warning': '<span class="status-badge status-warning">Warning</span>',
    'escalated': '<span class="status-badge status-escalated">Escalated</span>',
    'closed': '<span class="status-badge status-compliant">Compliant</span>'
  };
  return map[status] || `<span class="status-badge">${status}</span>`;
}

function formatTime(ts) {
  if(!ts) return '';
  // Support both YYYY-MM-DD HH:MM:SS format and ISO
  return new Date(ts + (ts.includes('Z') ? '' : 'Z')).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
}

/* ========== RENDERERS ========== */

function renderTracker() {
  const tbody = document.getElementById('tracker-body');
  if (!activeViolations || activeViolations.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:#94a3b8">No active violations. Operations are compliant.</td></tr>`;
    return;
  }
  
  tbody.innerHTML = activeViolations.map(alert => {
    const risk = calculateMultiParamRisk(alert.recorded_value, alert.prescribed_limit);
    
    return `
      <tr>
        <td>
          <div class="risk-score-box" style="background:${risk.color}22; color:${risk.color}; border: 1px solid ${risk.color}">
            ${Math.round(risk.score)}
          </div>
        </td>
        <td>
          <div style="font-weight:600">${alert.location_name || 'Unknown Location'}</div>
          <div style="font-size:12px; color:#94a3b8">${alert.industry_name || 'N/A'}</div>
        </td>
        <td><strong style="color:#00d4ff">${alert.parameter.toUpperCase()}</strong></td>
        <td style="color:#ef4444; font-weight:bold">${Number(alert.recorded_value).toFixed(2)}</td>
        <td style="color:#94a3b8">${Number(alert.prescribed_limit).toFixed(2)}</td>
        <td>${getStatusBadge(alert.status)}</td>
        <td>
          ${alert.status === 'open' ? `<button onclick="escalateAlert(${alert.id})" style="background:#ef4444;color:#fff;border:none;padding:6px 10px;border-radius:4px;cursor:pointer;font-weight:600;font-size:12px">Escalate</button>` : `<span style="color:#94a3b8;font-size:12px">Actioned</span>`}
        </td>
      </tr>
    `;
  }).join('');
}

function renderLogs(logs) {
  const list = document.getElementById('logs-list');
  if (!logs || logs.length === 0) {
    list.innerHTML = `<div style="text-align:center; padding:20px; color:#94a3b8">No recent logs found for this filter.</div>`;
    return;
  }
  
  list.innerHTML = logs.map(log => {
    const isEscalated = log.status === 'escalated';
    let cardClass = isEscalated ? 'danger' : 'warn';
    
    return `
      <div class="log-card ${cardClass}">
        <div class="log-card-header">
          <span class="log-industry">${log.industry_name || log.location_name}</span>
          <span class="log-time">${formatTime(log.created_at)}</span>
        </div>
        <div class="log-body">
          Detected <strong>${log.parameter.toUpperCase()}</strong> at ${Number(log.recorded_value).toFixed(2)} 
          (Limit: ${log.prescribed_limit}). 
          Status: <em>${log.status.toUpperCase()}</em>.
        </div>
      </div>
    `;
  }).join('');
}

/* ========== ACTIONS ========== */

window.escalateAlert = async function(id) {
  try {
    const res = await fetch(`${API}/compliance/alerts/${id}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'escalated', note: 'System Escalation via Dashboard' })
    });
    if (res.ok) {
      loadTracker(); // reload UI
    }
  } catch(e) {
    console.error('Escalation failed', e);
  }
}
