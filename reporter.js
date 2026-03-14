/* ==========================================
   PrithviNet — CITIZEN REPORTER MODULE
   ========================================== */

(function () {
  'use strict';

  const CATEGORIES = {
    burning: { label: 'Illegal Burning', icon: '🔥', color: '#ef4444' },
    vehicle: { label: 'Vehicle Smoke', icon: '🚗', color: '#f97316' },
    industrial: { label: 'Industrial', icon: '🏭', color: '#8b5cf6' },
    other: { label: 'Other Hazard', icon: '⚠️', color: '#fbbf24' }
  };

  /* Report expiry hours — must match server REPORT_EXPIRY */
  const REPORT_EXPIRY = { burning: 2, vehicle: 2, industrial: 6, construction: 6, other: 3 };
  const POLL_WINDOW_MIN = 12;
  const PROXIMITY_KM = 10.0;
  const MONITORING_STORAGE_KEY = 'prithvinet_monitoring_submissions';
  const MONITORING_THRESHOLDS = {
    air: { aqiWarning: 200, aqiCritical: 300, pm25Warning: 150, pm10Warning: 250 },
    water: { phMin: 6.5, phMax: 8.5, bodWarning: 30, codWarning: 250 },
    noise: { avgWarning: 75, avgCritical: 90 }
  };
  const MONITORING_LOCAL_EXPIRY_MS = 2 * 60 * 60 * 1000; // 2 hours
  const MONITORING_COPY = {
    air: {
      helper: 'Capture only air-impact readings for this submission.',
      required: 'MINIMUM REQUIRED AIR READINGS',
      advanced: 'ADDITIONAL AIR PARAMETERS <span class="rp-optional">optional</span>'
    },
    water: {
      helper: 'Capture only water-quality readings for this submission.',
      required: 'MINIMUM REQUIRED WATER READINGS',
      advanced: 'ADDITIONAL WATER PARAMETERS <span class="rp-optional">optional</span>'
    },
    noise: {
      helper: 'Capture only noise-impact readings for this submission.',
      required: 'MINIMUM REQUIRED NOISE READINGS',
      advanced: 'ADDITIONAL NOISE PARAMETERS <span class="rp-optional">optional</span>'
    }
  };

  let monitoringMemoryFallback = [];

  const API_BASE = window.location.origin + '/api';

  /* Anonymous voter ID (persisted per browser) */
  function getVoterUid() {
    let uid = localStorage.getItem('prithvinet_voter_uid');
    if (!uid) { uid = 'v_' + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('prithvinet_voter_uid', uid); }
    return uid;
  }

  function getCurrentRole() {
    return (window.PrithviNet && typeof window.PrithviNet.role === 'function')
      ? window.PrithviNet.role()
      : 'citizen';
  }

  function canUseMonitoringMode() {
    return ['super_admin', 'regional_officer', 'monitoring_team', 'industry_user'].includes(getCurrentRole());
  }

  function getMonitoringSubmissions() {
    try {
      const raw = localStorage.getItem(MONITORING_STORAGE_KEY) || '[]';
      const list = JSON.parse(raw);
      const safeList = Array.isArray(list) ? list : [];
      return pruneMonitoringSubmissions(safeList, true);
    } catch (_) {
      return pruneMonitoringSubmissions(monitoringMemoryFallback.slice(), false);
    }
  }

  function saveMonitoringSubmission(entry) {
    const list = pruneMonitoringSubmissions(getMonitoringSubmissions(), false);
    list.unshift(entry);
    const trimmed = pruneMonitoringSubmissions(list.slice(0, 100), false);
    monitoringMemoryFallback = trimmed.slice();
    try {
      localStorage.setItem(MONITORING_STORAGE_KEY, JSON.stringify(trimmed));
    } catch (_) {
      // localStorage may be unavailable or full; keep the submission in memory for this session.
    }
    rs._monitoringCache = trimmed;
  }

  function pruneMonitoringSubmissions(list, persistToStorage) {
    const now = Date.now();
    const pruned = (Array.isArray(list) ? list : []).filter(item => {
      if (!item || typeof item !== 'object') return false;
      const t = item.created_at ? new Date(item.created_at).getTime() : NaN;
      if (!Number.isFinite(t)) return false;
      return (now - t) <= MONITORING_LOCAL_EXPIRY_MS;
    });

    monitoringMemoryFallback = pruned.slice();

    if (persistToStorage) {
      try {
        localStorage.setItem(MONITORING_STORAGE_KEY, JSON.stringify(pruned));
      } catch (_) {
        // Ignore storage write failures; memory fallback still applies.
      }
    }

    return pruned;
  }

  /* Default region: Bhilai center */
  let rs = {
    mainMap: null,
    miniMap: null,
    miniPin: null,
    lat: 21.1938,
    lng: 81.3509,
    reportMode: 'incident',
    monitoringType: 'air',
    category: null,
    media: null,
    markers: []
  };

  let opsState = {
    activeTab: 'activeAlerts',
    inbox: null,
    selectedItem: null,
    selectedKind: null,
    trendWindow: '7d',
    trendGroup: 'industry',
    map: null,
    mapLayer: null,
    locationFilter: null
  };

  const DEFAULT_DRAWER_ACTIONS_HTML = `
    <button type="button" onclick="quickAlertAction('acknowledged')">Acknowledge</button>
    <button type="button" onclick="quickAssignAlert()">Assign</button>
    <button type="button" onclick="quickAlertAction('in_action')">In Action</button>
    <button type="button" onclick="quickAlertAction('escalated')">Escalate</button>
    <button type="button" onclick="quickAlertAction('resolved')">Resolve</button>
  `;

  /* ==========================================
     PAGE SWITCHING
     ========================================== */
  const PAGES = ['page-dashboard', 'page-alerts', 'page-report'];

  function activateNav(pageId) {
    document.querySelectorAll('.nav-item').forEach(n => {
      n.classList.remove('active');
      const ind = n.querySelector('.nav-indicator');
      if (ind) ind.remove();
    });
    const navEl = document.querySelector(`[data-page="${pageId}"]`);
    if (navEl) {
      navEl.classList.add('active');
      const ind = document.createElement('div');
      ind.className = 'nav-indicator';
      navEl.prepend(ind);
    }
  }

  window.switchPage = function (pageId) {
    const perms = (window.PrithviNet && window.PrithviNet.getPermissions)
      ? window.PrithviNet.getPermissions()
      : { alerts: true, reports: true, dashboard: true };

    if (pageId === 'alerts' && !perms.alerts) pageId = 'dashboard';
    if (pageId === 'report' && !perms.reports) pageId = 'dashboard';

    PAGES.forEach(pid => {
      const el = document.getElementById(pid);
      if (el) el.style.display = 'none';
    });

    if (pageId === 'report') {
      document.getElementById('page-report').style.display = 'flex';
      activateNav('report');
      applyReportModeUI();
      if (!rs.miniMap) setTimeout(initMiniMap, 80);
    } else if (pageId === 'alerts') {
      document.getElementById('page-alerts').style.display = 'flex';
      activateNav('alerts');
      renderAlerts();
    } else {
      document.getElementById('page-dashboard').style.display = 'flex';
      activateNav('dashboard');
    }
  };

  /* ==========================================
     MINI MAP (Report Page)
     ========================================== */
  function initMiniMap() {
    rs.miniMap = L.map('report-map', {
      center: [rs.lat, rs.lng],
      zoom: 11,
      zoomControl: false,
      attributionControl: false
    });

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd', maxZoom: 19
    }).addTo(rs.miniMap);

    rs.miniPin = L.marker([rs.lat, rs.lng], {
      draggable: true,
      icon: L.divIcon({
        className: '',
        html: '<div class="mini-pin"></div>',
        iconSize: [22, 22],
        iconAnchor: [11, 11]
      })
    }).addTo(rs.miniMap);

    updateCoords(rs.lat, rs.lng);

    rs.miniPin.on('dragend', function (e) {
      const p = e.target.getLatLng();
      rs.lat = p.lat; rs.lng = p.lng;
      updateCoords(p.lat, p.lng);
    });

    rs.miniMap.on('click', function (e) {
      rs.miniPin.setLatLng(e.latlng);
      rs.lat = e.latlng.lat; rs.lng = e.latlng.lng;
      updateCoords(rs.lat, rs.lng);
    });
  }

  function updateCoords(lat, lng) {
    const el = document.getElementById('rp-coords');
    if (el) el.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  }

  /* ==========================================
     GEOLOCATION
     ========================================== */
  window.detectLocation = function () {
    const btn = document.getElementById('rp-detect-btn');
    if (btn) { btn.textContent = 'Detecting…'; btn.disabled = true; }

    navigator.geolocation.getCurrentPosition(
      function (pos) {
        rs.lat = pos.coords.latitude;
        rs.lng = pos.coords.longitude;
        updateCoords(rs.lat, rs.lng);
        if (rs.miniMap && rs.miniPin) {
          rs.miniMap.setView([rs.lat, rs.lng], 14);
          rs.miniPin.setLatLng([rs.lat, rs.lng]);
        }
        if (btn) { btn.innerHTML = '✓ Located'; btn.disabled = false; btn.style.color = '#00e676'; }
      },
      function () {
        if (btn) { btn.textContent = '📍 Detect Location'; btn.disabled = false; }
        showToast('Location access denied. Drag the pin manually.', 'error');
      },
      { timeout: 8000 }
    );
  };

  /* ==========================================
     CATEGORY SELECTION
     ========================================== */
  window.selectCategory = function (cat) {
    rs.category = cat;
    document.querySelectorAll('.rp-cat-btn').forEach(b => b.classList.remove('active'));
    const btn = document.querySelector(`.rp-cat-btn[data-cat="${cat}"]`);
    if (btn) btn.classList.add('active');
  };

  /* ==========================================
     MEDIA UPLOAD
     ========================================== */
  window.handleMediaUpload = function (input) {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function (e) {
      rs.media = e.target.result;
      const preview = document.getElementById('rp-media-preview');
      if (!preview) return;
      preview.style.display = 'block';
      if (file.type.startsWith('image/')) {
        preview.innerHTML = `<img src="${e.target.result}" alt="Preview">`;
      } else {
        preview.innerHTML = `<div class="rp-video-placeholder">🎥 Video ready · ${(file.size / 1048576).toFixed(1)} MB</div>`;
      }
    };
    reader.readAsDataURL(file);
  };

  window.setReportMode = function (mode) {
    if (mode === 'monitoring' && !canUseMonitoringMode()) {
      rs.reportMode = 'incident';
    } else {
      rs.reportMode = mode;
    }
    applyReportModeUI();
  };

  window.setMonitoringType = function (type) {
    rs.monitoringType = type;
    applyReportModeUI();
  };

  function applyReportModeUI() {
    const incidentPanel = document.getElementById('rp-incident-panel');
    const monitoringPanel = document.getElementById('rp-monitoring-panel');
    const roleNote = document.getElementById('rp-role-note');
    const monitoringHelper = document.getElementById('rp-monitoring-helper');
    const requiredLabel = document.getElementById('rp-required-label');
    const advancedLabel = document.getElementById('rp-advanced-label');
    const submitLabel = document.getElementById('rp-submit-label');
    const formSub = document.getElementById('rp-form-sub');
    const monitoringModeAllowed = canUseMonitoringMode();
    const copy = MONITORING_COPY[rs.monitoringType] || MONITORING_COPY.air;

    document.querySelectorAll('.rp-mode-btn').forEach(btn => {
      const active = btn.dataset.mode === rs.reportMode;
      btn.classList.toggle('active', active);
      if (btn.dataset.mode === 'monitoring') {
        btn.disabled = !monitoringModeAllowed;
        btn.style.opacity = monitoringModeAllowed ? '1' : '0.45';
        btn.style.cursor = monitoringModeAllowed ? 'pointer' : 'default';
      }
    });

    if (rs.reportMode === 'monitoring' && !monitoringModeAllowed) {
      rs.reportMode = 'incident';
    }

    const monitoringActive = rs.reportMode === 'monitoring';
    if (incidentPanel) {
      incidentPanel.hidden = monitoringActive;
      incidentPanel.style.display = monitoringActive ? 'none' : '';
    }
    if (monitoringPanel) {
      monitoringPanel.hidden = !monitoringActive;
      monitoringPanel.style.display = monitoringActive ? '' : 'none';
    }
    if (submitLabel) submitLabel.textContent = monitoringActive ? 'Submit Reading' : 'Submit Report';
    if (formSub) formSub.textContent = monitoringActive
      ? 'Log air, water, or noise readings without using a backend submission API'
      : 'Submit a simple citizen incident report with category, description, and location';
    if (roleNote) {
      roleNote.textContent = monitoringModeAllowed
        ? 'Citizen flow stays simple. Monitoring submissions are saved locally on this device for field demos.'
        : 'Your role can submit incident reports here. Monitoring submission is available to field and operations roles.';
    }
    if (monitoringHelper) monitoringHelper.textContent = copy.helper;
    if (requiredLabel) requiredLabel.textContent = copy.required;
    if (advancedLabel) advancedLabel.innerHTML = copy.advanced;

    document.querySelectorAll('.rp-sensor-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.monitoringType === rs.monitoringType);
    });

    ['air', 'water', 'noise'].forEach(type => {
      const isActive = type === rs.monitoringType;
      const fields = document.getElementById('rp-fields-' + type);
      const advanced = document.getElementById('rp-advanced-' + type);
      if (fields) {
        fields.hidden = !isActive;
        fields.style.display = isActive ? 'grid' : 'none';
      }
      if (advanced) {
        advanced.hidden = !isActive;
        advanced.style.display = isActive ? 'grid' : 'none';
      }
    });
  }

  function parseFieldNumber(id) {
    const input = document.getElementById(id);
    if (!input) return null;
    const value = String(input.value || '').trim();
    if (value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  }

  function validateMonitoringSubmission() {
    const type = rs.monitoringType;
    const values = {};
    let requiredIds = [];

    if (type === 'air') {
      requiredIds = ['mon-air-aqi', 'mon-air-pm25', 'mon-air-pm10'];
      values.aqi = parseFieldNumber('mon-air-aqi');
      values.pm25 = parseFieldNumber('mon-air-pm25');
      values.pm10 = parseFieldNumber('mon-air-pm10');
      values.no2 = parseFieldNumber('mon-air-no2');
      values.so2 = parseFieldNumber('mon-air-so2');
      values.o3 = parseFieldNumber('mon-air-o3');
      values.co = parseFieldNumber('mon-air-co');
    } else if (type === 'water') {
      requiredIds = ['mon-water-ph', 'mon-water-bod', 'mon-water-cod'];
      values.ph = parseFieldNumber('mon-water-ph');
      values.bod = parseFieldNumber('mon-water-bod');
      values.cod = parseFieldNumber('mon-water-cod');
      values.dissolved_oxygen = parseFieldNumber('mon-water-do');
      values.turbidity = parseFieldNumber('mon-water-turbidity');
      values.conductivity = parseFieldNumber('mon-water-conductivity');
    } else {
      requiredIds = ['mon-noise-avg'];
      values.noise_level_db = parseFieldNumber('mon-noise-avg');
      values.noise_min_db = parseFieldNumber('mon-noise-min');
      values.noise_max_db = parseFieldNumber('mon-noise-max');
    }

    for (const id of requiredIds) {
      const val = parseFieldNumber(id);
      if (val === null || Number.isNaN(val)) {
        return { ok: false, message: 'Please fill all minimum required readings.' };
      }
    }

    if (type === 'water' && values.ph !== null && (values.ph < 0 || values.ph > 14)) {
      return { ok: false, message: 'pH must be between 0 and 14.' };
    }

    if (type === 'noise') {
      if (values.noise_min_db != null && values.noise_level_db != null && values.noise_min_db > values.noise_level_db) {
        return { ok: false, message: 'Min dB cannot exceed average dB.' };
      }
      if (values.noise_max_db != null && values.noise_level_db != null && values.noise_max_db < values.noise_level_db) {
        return { ok: false, message: 'Max dB cannot be lower than average dB.' };
      }
    }

    return { ok: true, values };
  }

  function buildMonitoringSummary(type, values) {
    if (type === 'air') {
      return `AQI ${values.aqi}, PM2.5 ${values.pm25}, PM10 ${values.pm10}`;
    }
    if (type === 'water') {
      return `pH ${values.ph}, BOD ${values.bod}, COD ${values.cod}`;
    }
    return `Avg ${values.noise_level_db} dB`;
  }

  function getMonitoringAlert(submission) {
    if (!submission || typeof submission !== 'object') return null;
    const values = (submission.values && typeof submission.values === 'object') ? submission.values : {};
    const type = submission.monitoringType;
    const lat = Number(submission.lat);
    const lng = Number(submission.lng);
    const roleLabel = String(submission.submitted_by_role || 'field_user').replace('_', ' ');
    const createdAt = submission.created_at ? new Date(submission.created_at) : new Date();
    const timeLabel = Number.isNaN(createdAt.getTime()) ? 'just now' : getTimeAgo(createdAt);

    if (type === 'air') {
      if ((values.aqi || 0) >= MONITORING_THRESHOLDS.air.aqiCritical) {
        const locLabel = Number.isFinite(lat) && Number.isFinite(lng)
          ? `${lat.toFixed(3)}, ${lng.toFixed(3)}`
          : 'submitted location';
        return {
          type: 'monitoring',
          level: 'critical',
          color: '#ef4444',
          title: 'Critical air reading submitted',
          detail: `AQI ${values.aqi} at ${locLabel} from ${roleLabel}.`,
          time: timeLabel,
          pills: [`AQI ${values.aqi}`, `PM2.5 ${values.pm25}`, `PM10 ${values.pm10}`]
        };
      }
      if ((values.aqi || 0) >= MONITORING_THRESHOLDS.air.aqiWarning || (values.pm25 || 0) >= MONITORING_THRESHOLDS.air.pm25Warning || (values.pm10 || 0) >= MONITORING_THRESHOLDS.air.pm10Warning) {
        return {
          type: 'monitoring',
          level: 'warning',
          color: '#f97316',
          title: 'Air reading flagged for review',
          detail: `Local monitoring submission crossed configured air thresholds.`,
          time: timeLabel,
          pills: [`AQI ${values.aqi}`, `PM2.5 ${values.pm25}`, `PM10 ${values.pm10}`]
        };
      }
    }

    if (type === 'water') {
      if ((values.ph || 7) < MONITORING_THRESHOLDS.water.phMin || (values.ph || 7) > MONITORING_THRESHOLDS.water.phMax || (values.bod || 0) >= MONITORING_THRESHOLDS.water.bodWarning || (values.cod || 0) >= MONITORING_THRESHOLDS.water.codWarning) {
        return {
          type: 'monitoring',
          level: 'warning',
          color: '#3b82f6',
          title: 'Water sample outside nominal range',
          detail: `Local monitoring submission indicates possible water-quality deviation.`,
          time: timeLabel,
          pills: [`pH ${values.ph}`, `BOD ${values.bod}`, `COD ${values.cod}`]
        };
      }
    }

    if (type === 'noise') {
      if ((values.noise_level_db || 0) >= MONITORING_THRESHOLDS.noise.avgCritical) {
        return {
          type: 'monitoring',
          level: 'critical',
          color: '#7c3aed',
          title: 'Critical noise reading submitted',
          detail: `Average noise reached ${values.noise_level_db} dB in a local field submission.`,
          time: timeLabel,
          pills: [`Avg ${values.noise_level_db} dB`, `Min ${values.noise_min_db ?? '-'}`, `Max ${values.noise_max_db ?? '-'}`]
        };
      }
      if ((values.noise_level_db || 0) >= MONITORING_THRESHOLDS.noise.avgWarning) {
        return {
          type: 'monitoring',
          level: 'warning',
          color: '#8b5cf6',
          title: 'Noise reading flagged for review',
          detail: `Average noise reached ${values.noise_level_db} dB in a local field submission.`,
          time: timeLabel,
          pills: [`Avg ${values.noise_level_db} dB`, `Min ${values.noise_min_db ?? '-'}`, `Max ${values.noise_max_db ?? '-'}`]
        };
      }
    }

    return null;
  }

  /* ==========================================
     SUBMIT REPORT
     ========================================== */
  window.submitReport = async function () {
    if (rs.reportMode === 'monitoring') {
      try {
        if (!canUseMonitoringMode()) {
          showToast('Your current role cannot submit monitoring readings.', 'error');
          return;
        }

        const result = validateMonitoringSubmission();
        if (!result.ok) {
          showToast(result.message, 'error');
          return;
        }

        const note = document.getElementById('rp-monitoring-note');
        const submission = {
          id: 'mon_' + Date.now().toString(36),
          submission_kind: 'monitoring',
          monitoringType: rs.monitoringType,
          lat: rs.lat,
          lng: rs.lng,
          values: result.values,
          note: note ? note.value.trim() : '',
          summary: buildMonitoringSummary(rs.monitoringType, result.values),
          submitted_by_role: getCurrentRole(),
          created_at: new Date().toISOString()
        };

        saveMonitoringSubmission(submission);
        if (rs.mainMap) {
          await loadExistingReports();
        }
        try {
          renderAlerts();
        } catch (renderErr) {
          console.warn('[Monitoring Submission] Saved, but alert render failed:', renderErr);
        }
          showToast('Monitoring reading saved locally.', 'success');
        resetForm();
        setTimeout(() => switchPage('dashboard'), 900);
        return;
      } catch (err) {
        console.error('[Monitoring Submission] Failed:', err);
          showToast('Monitoring submission failed before local save.', 'error');
        return;
      }
    }

    if (!rs.category) {
      showToast('Please select an incident category.', 'error'); return;
    }
    const desc = document.getElementById('rp-description').value.trim();
    if (!desc) {
      showToast('Please add a description of the incident.', 'error'); return;
    }

    const report = {
      lat: rs.lat,
      lng: rs.lng,
      category: rs.category,
      description: desc,
      media: rs.media,
      voter_uid: getVoterUid()
    };

    try {
      const resp = await fetch(API_BASE + '/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(report)
      });
      const json = await resp.json();
      if (json.status !== 'ok') throw new Error(json.message);

      // Reload markers from server
      await loadExistingReports();

      showToast('✓ Report submitted successfully!', 'success');
      resetForm();
      setTimeout(() => switchPage('dashboard'), 1400);
    } catch (err) {
      showToast('Failed to submit: ' + err.message, 'error');
    }
  };

  window.cancelReport = function () {
    resetForm();
    switchPage('dashboard');
  };

  function resetForm() {
    rs.category = null;
    rs.media = null;
    rs.reportMode = canUseMonitoringMode() ? rs.reportMode : 'incident';
    rs.monitoringType = 'air';
    document.querySelectorAll('.rp-cat-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('#page-report input').forEach(input => {
      if (input.type !== 'file') input.value = '';
    });
    const desc = document.getElementById('rp-description');
    if (desc) desc.value = '';
    const monNote = document.getElementById('rp-monitoring-note');
    if (monNote) monNote.value = '';
    const preview = document.getElementById('rp-media-preview');
    if (preview) { preview.style.display = 'none'; preview.innerHTML = ''; }
    const fileInput = document.getElementById('rp-file-input');
    if (fileInput) fileInput.value = '';
    const btn = document.getElementById('rp-detect-btn');
    if (btn) { btn.textContent = '📍 Detect Location'; btn.style.color = ''; }
    applyReportModeUI();
  }

  /* ==========================================
     REPORT MARKER ON MAIN MAP — with Poll + Confidence
     ========================================== */
  function addReportMarker(report) {
    const cat = CATEGORIES[report.category] || CATEGORIES.other;
    // Ensure UTC parsing — SQLite datetime('now') returns UTC without Z suffix
    const createdStr = report.created_at && !report.created_at.endsWith('Z') ? report.created_at + 'Z' : report.created_at;
    const timeAgo = getTimeAgo(new Date(createdStr));
    const thumb = report.media && report.media.startsWith('data:image')
      ? `<img src="${report.media}" class="rp-pop-thumb">`
      : '';

    const conf = report.confidence || { score: 50, label: 'Medium', votes: { confirmed: 0, false: 0, unsure: 0 }, totalVotes: 0, nearbyCount: 0 };
    const confColor = conf.score >= 75 ? '#00e676' : conf.score >= 50 ? '#fbbf24' : '#ef4444';

    // Expiry timer
    const expiryHours = REPORT_EXPIRY[report.category] || 3;
    const created = new Date(createdStr).getTime();
    const expiresAt = created + expiryHours * 3600000;
    const minsLeft = Math.max(0, Math.round((expiresAt - Date.now()) / 60000));
    const expiryLabel = minsLeft > 60 ? `${Math.floor(minsLeft / 60)}h ${minsLeft % 60}m left` : `${minsLeft}m left`;

    // Poll open?
    const pollOpen = report.pollOpen !== undefined ? report.pollOpen : ((Date.now() - created) < POLL_WINDOW_MIN * 60000);
    const pollClosesAt = created + POLL_WINDOW_MIN * 60000;
    const pollMinsLeft = Math.max(0, Math.round((pollClosesAt - Date.now()) / 60000));

    const icon = L.divIcon({
      className: '',
      html: `<div class="report-marker" style="--mc:${cat.color}">
               <span class="rm-icon">${cat.icon}</span>
             </div>`,
      iconSize: [38, 38],
      iconAnchor: [19, 19]
    });

    // Build poll HTML
    const pollHtml = pollOpen
      ? `<div class="rp-poll" data-rid="${report.id}">
           <div class="rp-poll-header">
             <span class="rp-poll-title">Is this accurate?</span>
             <span class="rp-poll-timer">${pollMinsLeft}m left</span>
           </div>
           <div class="rp-poll-btns">
             <button class="rp-vote-btn rp-vote-confirm" data-vote="confirmed" onclick="voteReport(${report.id},'confirmed',this)">
               ✓ Confirm <span class="rp-vc">${conf.votes.confirmed || 0}</span>
             </button>
             <button class="rp-vote-btn rp-vote-false" data-vote="false" onclick="voteReport(${report.id},'false',this)">
               ✗ False <span class="rp-vc">${conf.votes.false || 0}</span>
             </button>
             <button class="rp-vote-btn rp-vote-unsure" data-vote="unsure" onclick="voteReport(${report.id},'unsure',this)">
               ? Unsure <span class="rp-vc">${conf.votes.unsure || 0}</span>
             </button>
           </div>
         </div>`
      : `<div class="rp-poll-closed">Poll closed</div>`;

    const popupContent =
      `<div class="report-popup">
        ${thumb}
        <div class="rp-pop-cat" style="color:${cat.color}">${cat.icon} ${cat.label}</div>
        <div class="rp-pop-desc">${report.description}</div>
        <div class="rp-pop-conf">
          <div class="rp-conf-bar-wrap">
            <div class="rp-conf-bar" style="width:${conf.score}%;background:${confColor}"></div>
          </div>
          <span class="rp-conf-label" style="color:${confColor}">${conf.score}% ${conf.label}</span>
          ${conf.nearbyCount > 0 ? `<span class="rp-nearby-badge">${conf.nearbyCount} nearby</span>` : ''}
        </div>
        ${pollHtml}
        <div class="rp-pop-meta">
          <span>${timeAgo}</span>
          <span class="rp-expiry-badge">⏱ ${expiryLabel}</span>
        </div>
      </div>`;

    const marker = L.marker([report.lat, report.lng], { icon })
      .bindPopup(popupContent, { maxWidth: 260, className: 'report-popup-wrap' })
      .addTo(rs.mainMap);

    rs.markers.push({ id: report.id, marker });
  }

  function getMonitoringMarkerMeta(type) {
    if (type === 'water') return { icon: '💧', label: 'Water Submission', color: '#3b82f6' };
    if (type === 'noise') return { icon: '🔊', label: 'Noise Submission', color: '#8b5cf6' };
    return { icon: '☁️', label: 'Air Submission', color: '#f97316' };
  }

  function addMonitoringMarker(entry) {
    if (!rs.mainMap || !entry) return;

    const lat = Number(entry.lat);
    const lng = Number(entry.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

    const type = entry.monitoringType || 'air';
    const values = (entry.values && typeof entry.values === 'object') ? entry.values : {};
    const meta = getMonitoringMarkerMeta(type);

    const ts = entry.created_at ? new Date(entry.created_at) : new Date();
    const timeText = Number.isNaN(ts.getTime()) ? 'just now' : getTimeAgo(ts);

    let detailsHtml = '';
    if (type === 'air') {
      detailsHtml = `AQI: ${values.aqi ?? '-'}<br>PM2.5: ${values.pm25 ?? '-'}<br>PM10: ${values.pm10 ?? '-'}`;
    } else if (type === 'water') {
      detailsHtml = `pH: ${values.ph ?? '-'}<br>BOD: ${values.bod ?? '-'}<br>COD: ${values.cod ?? '-'}`;
    } else {
      detailsHtml = `Avg dB: ${values.noise_level_db ?? '-'}<br>Min dB: ${values.noise_min_db ?? '-'}<br>Max dB: ${values.noise_max_db ?? '-'}`;
    }

    const icon = L.divIcon({
      className: '',
      html: `<div class="report-marker" style="--mc:${meta.color}"><span class="rm-icon">${meta.icon}</span></div>`,
      iconSize: [38, 38],
      iconAnchor: [19, 19]
    });

    const popupContent = `
      <div class="report-popup">
        <div class="rp-pop-cat" style="color:${meta.color}">${meta.icon} ${meta.label}</div>
        <div class="rp-pop-desc">Role: ${String(entry.submitted_by_role || 'field_user').replace('_', ' ')}</div>
        <div class="rp-pop-desc">${detailsHtml}</div>
        <div class="rp-pop-meta">
          <span>${timeText}</span>
          <span class="rp-expiry-badge">Local entry</span>
        </div>
      </div>`;

    const marker = L.marker([lat, lng], { icon })
      .bindPopup(popupContent, { maxWidth: 260, className: 'report-popup-wrap' })
      .addTo(rs.mainMap);

    rs.markers.push({ id: entry.id || ('mon_' + Date.now()), marker });
  }

  /* ==========================================
     VOTE ON A REPORT
     ========================================== */
  window.voteReport = async function (reportId, vote, btn) {
    // Use Bhilai default location for proximity unless browser geolocation is used
    let userLat = rs.lat, userLng = rs.lng;

    // Client-side proximity check
    const report = rs._reportsCache ? rs._reportsCache.find(r => r.id === reportId) : null;
    if (report) {
      const dist = haversineJS(userLat, userLng, report.lat, report.lng);
      if (dist > PROXIMITY_KM) {
        showToast('You must be near this location to vote.', 'error');
        return;
      }
    }

    try {
      const resp = await fetch(API_BASE + '/reports/' + reportId + '/vote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vote, voter_uid: getVoterUid(), lat: userLat, lng: userLng })
      });
      const json = await resp.json();
      if (json.status !== 'ok') {
        showToast(json.message || 'Vote failed', 'error');
        return;
      }
      // Highlight selected button
      const pollDiv = btn.closest('.rp-poll');
      if (pollDiv) {
        pollDiv.querySelectorAll('.rp-vote-btn').forEach(b => b.classList.remove('voted'));
        btn.classList.add('voted');
        // Update vote counts in the popup
        const conf = json.confidence;
        if (conf && conf.votes) {
          pollDiv.querySelectorAll('.rp-vote-btn').forEach(b => {
            const v = b.getAttribute('data-vote');
            const span = b.querySelector('.rp-vc');
            if (span && conf.votes[v] !== undefined) span.textContent = conf.votes[v];
          });
        }
        // Update confidence bar in popup
        const popup = btn.closest('.report-popup');
        if (popup && conf) {
          const bar = popup.querySelector('.rp-conf-bar');
          const label = popup.querySelector('.rp-conf-label');
          const confColor = conf.score >= 75 ? '#00e676' : conf.score >= 50 ? '#fbbf24' : '#ef4444';
          if (bar) { bar.style.width = conf.score + '%'; bar.style.background = confColor; }
          if (label) { label.textContent = conf.score + '% ' + conf.label; label.style.color = confColor; }
        }
      }
      showToast('Vote recorded!', 'success');
    } catch (err) {
      showToast('Network error', 'error');
    }
  };

  /** Haversine distance in km (client-side) */
  function haversineJS(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /* ==========================================
     ALERTS RENDERER
     ========================================== */
  async function renderAlerts() {
    const list = document.getElementById('al-alerts-list');
    const tsEl = document.getElementById('al-timestamp');
    const badgeEl = document.getElementById('alert-badge');
    if (!list) return;

    try {
      const resp = await fetch(API_BASE + '/compliance/inbox');
      const inbox = await resp.json();
      if (!resp.ok) throw new Error(inbox.error || 'Unable to load inbox');
      opsState.inbox = inbox;

      renderOpsTabs(inbox);
      renderOpsKpis(inbox.kpis || {});
      renderMissingWidgets(inbox.counts || {});
      renderOffenders(inbox.kpis?.repeatOffenders || []);
      renderOpsList();
      renderOpsMap((inbox.tabs && inbox.tabs.activeAlerts) || []);
      renderTrendData();

      const openCritical = Number(inbox.kpis?.openBySeverity?.critical || 0);
      const openWarning = Number(inbox.kpis?.openBySeverity?.warning || 0);
      const total = openCritical + openWarning;

      if (badgeEl) {
        badgeEl.textContent = total > 0 ? total : '0';
        badgeEl.style.background = openCritical > 0 ? '#ef4444' : total > 0 ? '#f97316' : '#475569';
      }

      if (tsEl) {
        const now = new Date();
        tsEl.textContent = `Updated ${now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })} · ${total} active compliance alert${total === 1 ? '' : 's'}`;
      }
    } catch (err) {
      list.innerHTML = `<div class="al-empty"><div style="font-size:14px;color:#e2e8f0;font-weight:700">Operations inbox unavailable</div><div style="font-size:12px;color:#64748b;margin-top:8px">${err.message}</div></div>`;
      renderOffenders([]);
      if (tsEl) tsEl.textContent = 'Unable to refresh operations inbox right now';
    }
  }

  function renderOpsTabs(inbox) {
    const counts = inbox.counts || {};
    const setText = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = String(val || 0);
    };

    setText('al-tab-count-alerts', counts.activeAlerts || 0);
    setText('al-tab-count-missing', counts.missingReports || 0);
    setText('al-tab-count-escalations', counts.escalations || 0);

    document.querySelectorAll('.al-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === opsState.activeTab);
    });
  }

  function renderOpsKpis(kpis) {
    const setText = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = String(val);
    };
    setText('al-stat-critical', kpis.openBySeverity?.critical || 0);
    setText('al-stat-warning', kpis.openBySeverity?.warning || 0);
    setText('al-stat-sla', kpis.slaBreaches || 0);
    setText('al-stat-mtta', `${kpis.meanTimeToAcknowledgeMinutes || 0}m`);
  }

  function renderMissingWidgets(counts) {
    const setText = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = String(val || 0);
    };
    setText('al-stat-overdue', counts.overdueNow || 0);
    setText('al-stat-due-soon', counts.dueSoon || 0);
  }

  function renderOffenders(items) {
    const box = document.getElementById('al-offender-list');
    if (!box) return;

    if (!Array.isArray(items) || items.length === 0) {
      box.innerHTML = `<div class="al-empty" style="padding: 20px 8px"><div style="font-size:12px;color:#64748b">No repeat offenders in current scope.</div></div>`;
      return;
    }

    box.innerHTML = items.slice(0, 5).map((item, idx) => `
      <div class="al-offender-row">
        <span class="al-offender-rank">#${idx + 1}</span>
        <span class="al-offender-name">${item.name || 'Unknown'}</span>
        <span class="al-offender-count">${item.count}</span>
      </div>
    `).join('');
  }

  function getOpsItems() {
    if (!opsState.inbox || !opsState.inbox.tabs) return [];
    return opsState.inbox.tabs[opsState.activeTab] || [];
  }

  function renderOpsList() {
    const list = document.getElementById('al-alerts-list');
    if (!list) return;
    const items = getOpsItems();

    if (!items.length) {
      list.innerHTML = `<div class="al-empty"><div style="font-size:15px;font-weight:800;color:#e2e8f0">No items in this tab</div><div style="font-size:12px;color:#64748b;margin-top:6px">Switch tab or wait for the next data cycle.</div></div>`;
      return;
    }

    list.innerHTML = items
      .filter(item => {
        if (!opsState.locationFilter) return true;
        if (opsState.activeTab === 'activeAlerts') return String(item.location_id) === String(opsState.locationFilter);
        if (opsState.activeTab === 'missingReports') return String(item.entity_id) === String(opsState.locationFilter);
        if (opsState.activeTab === 'escalations') return String(item.location_id) === String(opsState.locationFilter);
        return true;
      })
      .map((item, i) => {
      const kind = opsState.activeTab;
      const id = item.id || item.alert_id;
      const isCritical = item.severity === 'critical' || item.status === 'escalation_candidate';
      const color = isCritical ? '#ef4444' : '#f59e0b';
      const title = kind === 'activeAlerts'
        ? `${item.parameter || 'Parameter'} · ${item.location_name || item.industry_name || 'Location'}`
        : kind === 'missingReports'
          ? `No ${item.type || 'monitoring'} report · ${item.location_name || 'Location'}`
          : `Escalation · Alert #${item.alert_id}`;
      const detail = kind === 'activeAlerts'
        ? (item.live_copy || item.message || 'Compliance threshold breach')
        : kind === 'missingReports'
          ? (item.message || 'Expected report not received within grace window')
          : (item.note || 'Escalated as per policy');
      const time = getTimeAgo(new Date(utcStr(item.created_at || item.detected_at || item.updated_at || new Date().toISOString())));
      const tag = kind === 'activeAlerts' ? (isCritical ? 'CRITICAL' : 'WARNING') : (kind === 'missingReports' ? 'MISSING' : 'ESCALATED');

      return `
        <div class="al-card al-card-btn" style="--ac:${color};animation-delay:${i * 0.03}s" onclick="openOpsItem('${kind}', '${id}')">
          <div class="al-card-strip" style="background:${color}"></div>
          <div class="al-card-body">
            <div class="al-card-top">
              <span class="al-card-tag" style="color:${color};border-color:${color}40;background:${color}15">${tag}</span>
              <span class="al-card-time">${time}</span>
            </div>
            <div class="al-card-title">${title}</div>
            <div class="al-card-detail">${detail}</div>
            <div class="al-card-pills">
              ${kind === 'activeAlerts' ? `<span class="al-pill">${item.type || '-'}</span><span class="al-pill">SLA ${Math.max(0, Number(item.pending_sla_minutes || 0))}m</span>` : ''}
              ${kind === 'missingReports' ? `<span class="al-pill">${item.reminder_level || 't_plus_0'}</span><span class="al-pill">${item.status || 'new'}</span><span class="al-pill" onclick="event.stopPropagation(); quickMissingNotify('${item.id}')">Notify</span>` : ''}
              ${kind === 'escalations' ? `<span class="al-pill">to ${item.to_role || '-'}</span><span class="al-pill">${item.status || 'pending'}</span>` : ''}
            </div>
          </div>
        </div>`;
    }).join('');

    const label = document.getElementById('al-map-filter-label');
    if (label) {
      label.textContent = opsState.locationFilter
        ? `Filtered by location #${opsState.locationFilter}. Click a different map marker to switch.`
        : 'Map and list are synchronized for active alerts.';
    }
  }

  window.setOpsTab = function (tab) {
    opsState.activeTab = tab;
    if (tab !== 'activeAlerts') opsState.locationFilter = null;
    renderOpsTabs(opsState.inbox || { counts: {} });
    renderOpsList();
    closeAlertDrawer();
  };

  function ensureOpsMap() {
    const mapEl = document.getElementById('al-ops-map');
    if (!mapEl || opsState.map) return;
    opsState.map = L.map('al-ops-map', {
      center: [21.2, 81.4],
      zoom: 7,
      zoomControl: true,
      attributionControl: false
    });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd',
      maxZoom: 19
    }).addTo(opsState.map);
    opsState.mapLayer = L.layerGroup().addTo(opsState.map);
  }

  function renderOpsMap(activeAlerts) {
    ensureOpsMap();
    if (!opsState.map || !opsState.mapLayer) return;
    opsState.mapLayer.clearLayers();

    const grouped = new Map();
    (activeAlerts || []).forEach(a => {
      const key = `${a.location_id}|${a.location_lat}|${a.location_lon}`;
      if (!grouped.has(key)) grouped.set(key, { ...a, count: 0, critical: 0 });
      const g = grouped.get(key);
      g.count += 1;
      if (a.severity === 'critical') g.critical += 1;
    });

    const points = [];
    grouped.forEach(g => {
      const lat = Number(g.location_lat);
      const lon = Number(g.location_lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      points.push([lat, lon]);
      const color = g.critical > 0 ? '#ef4444' : '#f59e0b';
      const marker = L.circleMarker([lat, lon], {
        radius: Math.max(6, Math.min(14, 5 + g.count)),
        color,
        fillColor: color,
        fillOpacity: 0.7,
        weight: 1.2
      }).addTo(opsState.mapLayer);
      marker.bindTooltip(`${g.location_name || 'Location'} · ${g.count} active`);
      marker.on('click', () => {
        opsState.locationFilter = g.location_id;
        if (opsState.activeTab !== 'activeAlerts') opsState.activeTab = 'activeAlerts';
        renderOpsTabs(opsState.inbox || { counts: {} });
        renderOpsList();
      });
    });

    if (points.length > 0) {
      const bounds = L.latLngBounds(points);
      if (bounds.isValid()) opsState.map.fitBounds(bounds, { padding: [18, 18], maxZoom: 10 });
    }
  }

  window.openOpsItem = async function (kind, id) {
    const source = (opsState.inbox && opsState.inbox.tabs && opsState.inbox.tabs[kind]) || [];
    const item = source.find(x => String(x.id || x.alert_id) === String(id));
    if (!item) return;

    opsState.selectedKind = kind;
    opsState.selectedItem = item;

    const drawer = document.getElementById('al-alert-drawer');
    const title = document.getElementById('al-drawer-title');
    const sub = document.getElementById('al-drawer-sub');
    const copy = document.getElementById('al-drawer-copy');
    const timeline = document.getElementById('al-drawer-timeline');
    const actions = document.getElementById('al-drawer-actions');

    if (!drawer || !title || !copy || !timeline || !actions) return;

    drawer.hidden = false;
    title.textContent = kind === 'activeAlerts' ? `Alert #${item.id}` : kind === 'missingReports' ? `Missing Report #${item.id}` : `Escalation #${item.id}`;
    sub.textContent = item.location_name || item.industry_name || 'Compliance event';

    if (kind === 'activeAlerts') {
      copy.textContent = `${item.live_copy || item.message || 'Compliance threshold breach'}. Recorded ${item.recorded_value || '-'} vs legal limit ${item.prescribed_limit || '-'}.`;
      actions.style.display = 'grid';
      actions.innerHTML = DEFAULT_DRAWER_ACTIONS_HTML;
      timeline.innerHTML = '<div class="al-loading">Loading audit timeline...</div>';
      try {
        const resp = await fetch(`${API_BASE}/compliance/alerts/${item.id}/timeline`);
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Unable to load timeline');
        timeline.innerHTML = (data.timeline || []).map(ev => `
          <div class="al-timeline-row">
            <div class="al-timeline-dot"></div>
            <div>
              <div class="al-timeline-title">${ev.title}</div>
              <div class="al-timeline-detail">${ev.detail || ''}</div>
              <div class="al-timeline-time">${getTimeAgo(new Date(utcStr(ev.created_at)))}</div>
            </div>
          </div>
        `).join('') || '<div class="al-empty" style="padding:12px">No timeline events yet.</div>';
        if (Array.isArray(data.escalations) && data.escalations.length) {
          timeline.innerHTML += data.escalations.map(es => `
            <div class="al-timeline-row">
              <div class="al-timeline-dot"></div>
              <div>
                <div class="al-timeline-title">Escalated to ${es.to_role}</div>
                <div class="al-timeline-detail">${es.note || ''}</div>
                <div class="al-timeline-time">${getTimeAgo(new Date(utcStr(es.created_at)))}</div>
              </div>
            </div>
          `).join('');
        }
      } catch (err) {
        timeline.innerHTML = `<div class="al-empty" style="padding:12px">${err.message}</div>`;
      }
      if (item.location_lat && item.location_lon && opsState.map) {
        opsState.map.setView([Number(item.location_lat), Number(item.location_lon)], 11);
      }
    } else if (kind === 'missingReports') {
      actions.style.display = 'grid';
      actions.innerHTML = `
        <button type="button" onclick="quickMissingNotify('${item.id}')">Notify</button>
        <button type="button" onclick="quickMissingStatus('${item.id}','acknowledged')">Acknowledge</button>
        <button type="button" onclick="quickMissingStatus('${item.id}','resolved')">Mark Resolved</button>
      `;
      copy.textContent = item.message || 'No report received within expected frequency and grace period.';
      timeline.innerHTML = `<div class="al-timeline-row"><div class="al-timeline-dot"></div><div><div class="al-timeline-title">Reminder level: ${item.reminder_level || 't_plus_0'}</div><div class="al-timeline-detail">Status: ${item.status || 'new'}</div></div></div>`;
    } else {
      actions.style.display = 'none';
      copy.textContent = item.note || 'Escalation record generated for authority handover.';
      timeline.innerHTML = `<div class="al-timeline-row"><div class="al-timeline-dot"></div><div><div class="al-timeline-title">From ${item.from_role || '-'} to ${item.to_role || '-'}</div><div class="al-timeline-detail">${item.note || ''}</div></div></div>`;
    }
  };

  window.closeAlertDrawer = function () {
    const drawer = document.getElementById('al-alert-drawer');
    if (drawer) drawer.hidden = true;
    opsState.selectedItem = null;
    opsState.selectedKind = null;
  };

  window.quickAlertAction = async function (status) {
    if (!opsState.selectedItem || opsState.selectedKind !== 'activeAlerts') return;
    try {
      const resp = await fetch(`${API_BASE}/compliance/alerts/${opsState.selectedItem.id}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || 'Action failed');
      showToast(`Alert moved to ${status}.`, 'success');
      await renderAlerts();
      closeAlertDrawer();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  window.quickAssignAlert = async function () {
    if (!opsState.selectedItem || opsState.selectedKind !== 'activeAlerts') return;
    const assignedTo = window.prompt('Assign to (user/team name):', 'regional_officer_team_1');
    if (!assignedTo) return;
    try {
      const resp = await fetch(`${API_BASE}/compliance/alerts/${opsState.selectedItem.id}/assign`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assigned_to: assignedTo, assigned_role: 'regional_officer' })
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || 'Assign failed');
      showToast('Alert assigned successfully.', 'success');
      await renderAlerts();
      closeAlertDrawer();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  window.quickMissingNotify = async function (id) {
    try {
      const resp = await fetch(`${API_BASE}/compliance/missing-reports/${id}/notify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'dashboard' })
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || 'Notify failed');
      showToast('Reminder notification sent.', 'success');
      await renderAlerts();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  window.quickMissingStatus = async function (id, status) {
    try {
      const resp = await fetch(`${API_BASE}/compliance/missing-reports/${id}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || 'Update failed');
      showToast(`Missing report set to ${status}.`, 'success');
      await renderAlerts();
      closeAlertDrawer();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  async function renderTrendData() {
    const list = document.getElementById('al-trend-list');
    if (!list) return;
    try {
      const resp = await fetch(`${API_BASE}/compliance/trends?window=${encodeURIComponent(opsState.trendWindow)}&groupBy=${encodeURIComponent(opsState.trendGroup)}`);
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || 'Unable to load trends');

      const series = Array.isArray(json.series) ? json.series : [];
      if (!series.length) {
        list.innerHTML = '<div class="al-empty" style="padding:14px"><div style="font-size:12px;color:#64748b">No trend data in current scope.</div></div>';
      } else {
        list.innerHTML = series.map(row => `
          <div class="al-offender-row">
            <span class="al-offender-rank">${row.total}</span>
            <span class="al-offender-name">${row.key}</span>
            <span class="al-offender-count">C:${row.critical}</span>
          </div>
        `).join('');
      }
    } catch (err) {
      list.innerHTML = `<div class="al-empty" style="padding:14px"><div style="font-size:12px;color:#64748b">${err.message}</div></div>`;
    }
  }

  window.setTrendWindow = function (w) {
    opsState.trendWindow = w === '30d' ? '30d' : '7d';
    const a = document.getElementById('al-window-7d');
    const b = document.getElementById('al-window-30d');
    if (a) a.classList.toggle('active', opsState.trendWindow === '7d');
    if (b) b.classList.toggle('active', opsState.trendWindow === '30d');
    renderTrendData();
  };

  window.setTrendGroup = function (g) {
    opsState.trendGroup = ['industry', 'parameter', 'region'].includes(g) ? g : 'industry';
    const ids = ['industry', 'parameter', 'region'];
    ids.forEach(id => {
      const el = document.getElementById(`al-group-${id}`);
      if (el) el.classList.toggle('active', id === opsState.trendGroup);
    });
    renderTrendData();
  };

  /* ==========================================
     LOAD REPORTS FROM SERVER
     ========================================== */
  async function loadExistingReports() {
    // Clear existing markers
    rs.markers.forEach(m => { if (rs.mainMap) rs.mainMap.removeLayer(m.marker); });
    rs.markers = [];

    try {
      const resp = await fetch(API_BASE + '/reports');
      const json = await resp.json();
      if (json.status === 'ok' && json.reports) {
        rs._reportsCache = json.reports;
        json.reports.forEach(r => addReportMarker(r));
      }
    } catch (err) {
      // Fallback: load from localStorage for offline
      const reports = JSON.parse(localStorage.getItem('prithvinet_reports') || '[]');
      reports.forEach(r => {
        r.created_at = r.created_at || r.timestamp;
        addReportMarker(r);
      });
    }

    const monitoring = pruneMonitoringSubmissions(rs._monitoringCache || getMonitoringSubmissions(), true);
    rs._monitoringCache = monitoring;
    monitoring.forEach(m => addMonitoringMarker(m));
  }

  /* ==========================================
     PUBLIC INIT — called from app.js
     ========================================== */
  window.initReports = function (map) {
    rs.mainMap = map;
    rs._monitoringCache = pruneMonitoringSubmissions(getMonitoringSubmissions(), true);
    monitoringMemoryFallback = rs._monitoringCache.slice();
    loadExistingReports();
    applyReportModeUI();
    // Refresh report markers every 2 min (handles expiry + new reports)
    setInterval(loadExistingReports, 120000);
    // Refresh alert badge on load (ward data available by now)
    setTimeout(renderAlerts, 100);
  };

  window.renderAlerts = renderAlerts;

  /* ==========================================
     TOAST
     ========================================== */
  function showToast(msg, type) {
    let toast = document.getElementById('aira-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'aira-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.className = `aira-toast ${type}`;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { toast.className = 'aira-toast'; }, 3200);
  }

  /* ==========================================
     HELPERS
     ========================================== */
  /** Ensure a datetime string from SQLite (UTC without Z) is treated as UTC */
  function utcStr(s) {
    if (!s) return s;
    return s.endsWith('Z') ? s : s + 'Z';
  }

  function getTimeAgo(date) {
    const mins = Math.floor((Date.now() - date) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }

  window.addEventListener('prithvinet-role-change', () => {
    if (!canUseMonitoringMode() && rs.reportMode === 'monitoring') {
      rs.reportMode = 'incident';
    }
    applyReportModeUI();
    renderAlerts();
  });

  if (canUseMonitoringMode() && getCurrentRole() === 'industry_user') {
    rs.reportMode = 'monitoring';
  }

  applyReportModeUI();

})();
