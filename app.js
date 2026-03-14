/* ==========================================
   PRITHVINET DASHBOARD — VANILLA JS
   ========================================== */

(function () {
  'use strict';

  /* ==========================================
     CONSTANTS & STATE
     ========================================== */
  const AQI_LEVELS = {
    good: { max: 50, label: 'Good', color: '#00e676' },
    moderate: { max: 100, label: 'Moderate', color: '#fbbf24' },
    unhealthy_s: { max: 150, label: 'Unhealthy (Sens.)', color: '#ff9800' },
    unhealthy: { max: 200, label: 'Unhealthy', color: '#ff9800' },
    very_unhealthy: { max: 300, label: 'Very Unhealthy', color: '#f44336' },
    hazardous: { max: 999, label: 'Hazardous', color: '#9c27b0' },
  };

  function getAQIInfo(aqi) {
    if (aqi <= 50) return AQI_LEVELS.good;
    if (aqi <= 100) return AQI_LEVELS.moderate;
    if (aqi <= 150) return AQI_LEVELS.unhealthy_s;
    if (aqi <= 200) return AQI_LEVELS.unhealthy;
    if (aqi <= 300) return AQI_LEVELS.very_unhealthy;
    return AQI_LEVELS.hazardous;
  }

  const API_BASE = window.location.origin + '/api';

  let state = {
    map: null,
    heatmapLayer: null,
    industryLayer: null,
    industryMarkers: [],
    selectedIndustry: null,
    wardLayers: [],
    heatmapVisible: true,
    chart: null,
    detailChart: null,
    isExpanded: false,
    geojson: null,
    geoJsonLayer: null,
    sseConnected: false,
    activeType: 'air', // 'air', 'water', 'noise'
    dataCache: { air: [], water: [], noise: [] },
    selectedLocation: 'Bhilai Steel Plant (Industrial Zone)',
    monitoringHistory: { air: [], water: [], noise: [] }
  };

  function getMetricModel(data) {
    if (state.activeType === 'air') {
      return {
        label: 'AQI',
        unit: '',
        value: Number(data?.aqi || 0),
        limit: 300,
        comparePool: (state.dataCache.air || []).map(x => Number(x.aqi || 0)).filter(Number.isFinite)
      };
    }
    if (state.activeType === 'water') {
      const ph = Number(data?.ph || 7);
      const score = Math.max(0, Math.min(100, Math.round((Math.abs(ph - 7) * 18) + (Number(data?.turbidity || 0) * 1.7) + (Number(data?.bod || 0) * 0.9))));
      const pool = (state.dataCache.water || []).map(x => {
        const p = Number(x?.ph || 7);
        return Math.max(0, Math.min(100, Math.round((Math.abs(p - 7) * 18) + (Number(x?.turbidity || 0) * 1.7) + (Number(x?.bod || 0) * 0.9))));
      }).filter(Number.isFinite);
      return {
        label: 'WQI Risk',
        unit: '',
        value: score,
        limit: 100,
        comparePool: pool
      };
    }
    return {
      label: 'Noise',
      unit: ' dB',
      value: Number(data?.noise_level_db || 0),
      limit: 120,
      comparePool: (state.dataCache.noise || []).map(x => Number(x.noise_level_db || 0)).filter(Number.isFinite)
    };
  }

  function pushMonitoringSnapshot(data, metricModel, info) {
    const history = state.monitoringHistory[state.activeType] || [];
    const previous = history.length ? history[history.length - 1] : null;
    if (
      previous
      && previous.location === (data?.name || state.selectedLocation)
      && Math.abs(metricModel.value - previous.value) < 0.2
      && (Date.now() - previous.ts) < 60 * 1000
    ) {
      return;
    }
    const delta = previous ? metricModel.value - previous.value : 0;
    history.push({
      ts: Date.now(),
      location: data?.name || state.selectedLocation,
      label: metricModel.label,
      value: metricModel.value,
      delta,
      status: info?.label || 'Unknown'
    });
    if (history.length > 180) history.splice(0, history.length - 180);
    state.monitoringHistory[state.activeType] = history;
  }

  function formatMonitorDelta(v, unit) {
    if (!Number.isFinite(v) || v === 0) return 'stable';
    return (v > 0 ? '+' : '') + v.toFixed(1) + unit;
  }

  function classifyTrend(series) {
    if (!series || series.length < 4) return 'stable';
    const recent = series.slice(-4).map(x => Number(x.value || 0));
    const slope = (recent[3] - recent[0]) / 3;
    if (slope > 2) return 'rising';
    if (slope < -2) return 'falling';
    return 'stable';
  }

  function renderMonitoringPanel(data, metricModel, info) {
    const logsEl = document.getElementById('dp-log-list');
    const campEl = document.getElementById('dp-campaign-list');
    const periodicEl = document.getElementById('dp-periodic-grid');
    const compareEl = document.getElementById('dp-compare-bars');
    const trendEl = document.getElementById('dp-trend-insight');
    const subEl = document.getElementById('dp-monitor-sub');

    if (!logsEl || !campEl || !periodicEl || !compareEl || !trendEl || !subEl) return;

    const history = state.monitoringHistory[state.activeType] || [];
    const recent = history.slice(-5).reverse();
    logsEl.innerHTML = recent.length
      ? recent.map(item => {
          const t = new Date(item.ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
          return `<li><strong>${item.label} ${Math.round(item.value)}</strong> at ${item.location}<span class="dp-log-meta">${t} | ${item.status} | ${formatMonitorDelta(item.delta, metricModel.unit)}</span></li>`;
        }).join('')
      : '<li class="dp-log-empty">Waiting for live monitoring updates...</li>';

    const trend = classifyTrend(history);
    const activeTypeLabel = state.activeType === 'air' ? 'Air' : (state.activeType === 'water' ? 'Water' : 'Noise');
    const campaignRows = [
      {
        title: activeTypeLabel + ' Intensive Watch',
        meta: trend === 'rising' ? 'Escalated sampling every 30 minutes' : 'Routine sampling every 2 hours'
      },
      {
        title: 'Industrial Belt Sweep',
        meta: 'Targeting high-impact clusters near ' + (data?.name || state.selectedLocation)
      },
      {
        title: 'Night Compliance Audit',
        meta: state.activeType === 'noise' ? 'Enabled for shift-change sound peaks' : 'Enabled for off-hour emissions tracking'
      }
    ];
    campEl.innerHTML = campaignRows.map(row => `<li class="dp-campaign-item"><strong>${row.title}</strong><span class="dp-campaign-meta">${row.meta}</span></li>`).join('');

    const values = history.map(x => Number(x.value || 0)).filter(Number.isFinite);
    const avg = values.length ? values.reduce((s, n) => s + n, 0) / values.length : metricModel.value;
    const variance = values.length > 1
      ? Math.sqrt(values.reduce((s, n) => s + Math.pow(n - avg, 2), 0) / values.length)
      : 0;
    const monthlyAvg = Math.round(avg);
    const yearlyProjection = Math.round(avg + (trend === 'rising' ? variance : -variance * 0.4));
    const compliance = Math.max(0, Math.min(100, Math.round(100 - ((metricModel.value / Math.max(metricModel.limit, 1)) * 100))));

    periodicEl.innerHTML = `
      <div class="dp-periodic-pill"><span>Monthly</span><strong>${monthlyAvg}${metricModel.unit}</strong></div>
      <div class="dp-periodic-pill"><span>Yearly</span><strong>${yearlyProjection}${metricModel.unit}</strong></div>
      <div class="dp-periodic-pill"><span>Compliance</span><strong>${compliance}%</strong></div>
      <div class="dp-periodic-pill"><span>Variance</span><strong>${variance.toFixed(1)}</strong></div>
    `;

    const pool = metricModel.comparePool.length ? metricModel.comparePool : [metricModel.value];
    const poolAvg = pool.reduce((s, n) => s + n, 0) / pool.length;
    const baseline = Math.max(metricModel.limit, metricModel.value, poolAvg, 1);

    const rows = [
      { label: 'Selected Area', value: metricModel.value },
      { label: 'Area Average', value: poolAvg },
      { label: 'Reg Limit', value: metricModel.limit }
    ];
    compareEl.innerHTML = rows.map(r => {
      const pct = Math.max(2, Math.min(100, (r.value / baseline) * 100));
      return `<div class="dp-compare-row"><span>${r.label}</span><div class="dp-compare-track"><i style="width:${pct}%"></i></div><em>${Math.round(r.value)}</em></div>`;
    }).join('');

    subEl.textContent = `${activeTypeLabel} monitoring focused on ${data?.name || state.selectedLocation}`;
    trendEl.textContent = trend === 'rising'
      ? `${metricModel.label} is trending upward. Prioritize campaign sampling and field inspection.`
      : trend === 'falling'
        ? `${metricModel.label} is easing. Keep periodic surveillance active to sustain compliance.`
        : `${metricModel.label} is stable. Continue baseline monthly and yearly reporting cadence.`;
  }

  function getIndustryColor(type) {
    const t = (type || '').toLowerCase();
    if (t === 'steel') return '#ef4444';
    if (t === 'mining') return '#f97316';
    if (t === 'power') return '#eab308';
    if (t === 'cement') return '#f59e0b';
    if (t === 'chemical') return '#8b5cf6';
    return '#38bdf8';
  }

  function distanceKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
      + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
      * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function getIndustryJitter(industry) {
    const seed = String(industry?.id || industry?.name || '0');
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = ((h << 5) - h) + seed.charCodeAt(i);
    return ((Math.abs(h) % 1000) / 1000) - 0.5; // -0.5 .. +0.5
  }

  function findBestReadingForIndustry(industry) {
    const list = state.dataCache[state.activeType] || [];
    if (!list.length) return null;

    const exact = list.find(r => Number(r.industry_id) === Number(industry.id));
    if (exact) {
      return { ...exact, __exactIndustryMatch: true, __distanceKm: 0 };
    }

    const withCoords = list.filter(r => r.lat != null && r.lon != null && !isNaN(r.lat) && !isNaN(r.lon));
    if (!withCoords.length) return null;

    // Deduplicate repeated entries from the same monitoring location by averaging core metrics.
    const bucket = new Map();
    withCoords.forEach(r => {
      const key = r.location_id != null ? `loc_${r.location_id}` : `${Number(r.lat).toFixed(5)}|${Number(r.lon).toFixed(5)}`;
      if (!bucket.has(key)) {
        bucket.set(key, {
          ...r,
          __count: 0,
          __aqi: 0,
          __pm25: 0,
          __pm10: 0,
          __so2: 0,
          __ph: 0,
          __bod: 0,
          __cod: 0,
          __turbidity: 0,
          __noise: 0,
          __noiseMin: 0,
          __noiseMax: 0
        });
      }
      const b = bucket.get(key);
      b.__count += 1;
      b.__aqi += Number(r.aqi || 0);
      b.__pm25 += Number(r.pm25 || 0);
      b.__pm10 += Number(r.pm10 || 0);
      b.__so2 += Number(r.so2 || 0);
      b.__ph += Number(r.ph || 0);
      b.__bod += Number(r.bod || 0);
      b.__cod += Number(r.cod || 0);
      b.__turbidity += Number(r.turbidity || 0);
      b.__noise += Number(r.noise_level_db || 0);
      b.__noiseMin += Number(r.noise_min_db || 0);
      b.__noiseMax += Number(r.noise_max_db || 0);
    });

    const representatives = Array.from(bucket.values()).map(b => {
      const c = Math.max(1, b.__count);
      return {
        ...b,
        aqi: Math.round(b.__aqi / c),
        pm25: Math.round((b.__pm25 / c) * 10) / 10,
        pm10: Math.round((b.__pm10 / c) * 10) / 10,
        so2: Math.round((b.__so2 / c) * 10) / 10,
        ph: Math.round((b.__ph / c) * 100) / 100,
        bod: Math.round((b.__bod / c) * 10) / 10,
        cod: Math.round((b.__cod / c) * 10) / 10,
        turbidity: Math.round((b.__turbidity / c) * 10) / 10,
        noise_level_db: Math.round((b.__noise / c) * 10) / 10,
        noise_min_db: Math.round((b.__noiseMin / c) * 10) / 10,
        noise_max_db: Math.round((b.__noiseMax / c) * 10) / 10
      };
    });

    let best = representatives[0];
    let bestD = distanceKm(Number(industry.lat), Number(industry.lon), Number(best.lat), Number(best.lon));

    for (let i = 1; i < representatives.length; i++) {
      const cand = representatives[i];
      const d = distanceKm(Number(industry.lat), Number(industry.lon), Number(cand.lat), Number(cand.lon));
      if (d < bestD) {
        best = cand;
        bestD = d;
      }
    }

    const type = (industry.type || '').toLowerCase();
    const typeBoost = {
      mining: 16,
      steel: 14,
      power: 12,
      cement: 10,
      chemical: 9
    }[type] || 6;

    if (state.activeType === 'air') {
      const proximityBoost = Math.max(0, 20 - bestD * 2.4);
      const delta = Math.round(proximityBoost + typeBoost);
      const adjusted = { ...best };
      adjusted.aqi = Math.max(0, Math.min(500, Math.round((best.aqi || 0) + delta)));
      adjusted.pm25 = Math.max(0, Math.round(((best.pm25 || 0) + delta * 0.7) * 10) / 10);
      adjusted.pm10 = Math.max(0, Math.round(((best.pm10 || 0) + delta * 1.0) * 10) / 10);
      adjusted.so2 = Math.max(0, Math.round(((best.so2 || 0) + delta * 0.35) * 10) / 10);
      adjusted.__distanceKm = bestD;
      adjusted.__derived = true;
      return adjusted;
    }

    if (state.activeType === 'water') {
      const jitter = getIndustryJitter(industry);
      const proximityBoost = Math.max(0, 1.2 - bestD * 0.12); // small local effect
      const profile = {
        mining:   { ph: -0.10, bod: +3.0, cod: +10.0, turbidity: +16.0, dissolved_oxygen: -0.5 },
        steel:    { ph: -0.05, bod: +2.5, cod: +8.0,  turbidity: +10.0, dissolved_oxygen: -0.4 },
        power:    { ph: +0.15, bod: +1.8, cod: +6.0,  turbidity: +8.0,  dissolved_oxygen: -0.3 },
        cement:   { ph: +0.25, bod: +1.2, cod: +5.0,  turbidity: +14.0, dissolved_oxygen: -0.2 },
        chemical: { ph: -0.35, bod: +4.2, cod: +18.0, turbidity: +7.0,  dissolved_oxygen: -0.8 }
      }[type] || { ph: 0, bod: 0.8, cod: 3, turbidity: 4, dissolved_oxygen: -0.1 };

      const adjusted = { ...best };
      adjusted.ph = Math.max(0, Math.min(14, Math.round(((best.ph || 7) + profile.ph + jitter * 0.4 - proximityBoost * 0.1) * 100) / 100));
      adjusted.bod = Math.max(0, Math.round(((best.bod || 0) + profile.bod + jitter * 1.2 + proximityBoost * 1.4) * 10) / 10);
      adjusted.cod = Math.max(0, Math.round(((best.cod || 0) + profile.cod + jitter * 4 + proximityBoost * 3.2) * 10) / 10);
      adjusted.turbidity = Math.max(0, Math.round(((best.turbidity || 0) + profile.turbidity + jitter * 5 + proximityBoost * 2.5) * 10) / 10);
      adjusted.dissolved_oxygen = Math.max(0, Math.round(((best.dissolved_oxygen || 0) + profile.dissolved_oxygen - jitter * 0.2 - proximityBoost * 0.2) * 10) / 10);
      adjusted.__distanceKm = bestD;
      adjusted.__derived = true;
      return adjusted;
    }

    if (state.activeType === 'noise') {
      const jitter = getIndustryJitter(industry);
      const proximityBoost = Math.max(0, 8 - bestD * 0.8);
      const typeNoiseBoost = {
        mining: 12,
        steel: 10,
        power: 8,
        cement: 9,
        chemical: 7
      }[type] || 4;

      const delta = typeNoiseBoost + proximityBoost + jitter * 4;
      const adjusted = { ...best };
      const base = Number(best.noise_level_db || 0);
      adjusted.noise_level_db = Math.max(0, Math.round((base + delta) * 10) / 10);
      adjusted.noise_min_db = Math.max(0, Math.round((adjusted.noise_level_db - (4 + Math.abs(jitter) * 2)) * 10) / 10);
      adjusted.noise_max_db = Math.max(adjusted.noise_level_db, Math.round((adjusted.noise_level_db + (8 + Math.abs(jitter) * 3)) * 10) / 10);
      adjusted.__distanceKm = bestD;
      adjusted.__derived = true;
      return adjusted;
    }

    return { ...best, __distanceKm: bestD };
  }

  function buildIndustryPopupHtml(ind, reading) {
    const type = (ind.type || 'unknown').toUpperCase();
    const category = (ind.category || 'n/a').toUpperCase();
    const consent = (ind.consent_status || 'n/a').toUpperCase();

    let metrics = '<span style="color:#94a3b8">No live reading for selected tab yet.</span>';
    if (reading) {
      if (state.activeType === 'air') {
        metrics = `<span style="color:#94a3b8">AQI:</span> ${Math.round(reading.aqi || 0)}<br>
                   <span style="color:#94a3b8">PM2.5:</span> ${reading.pm25 || 0}<br>
                   <span style="color:#94a3b8">PM10:</span> ${reading.pm10 || 0}<br>
                   <span style="color:#94a3b8">SO2:</span> ${reading.so2 || 0}`;
        if (reading.__derived) {
          metrics += `<br><span style="color:#38bdf8">Derived from nearest live sensor (${reading.__distanceKm.toFixed(1)} km)</span>`;
        }
      } else if (state.activeType === 'water') {
        metrics = `<span style="color:#94a3b8">pH:</span> ${reading.ph || 0}<br>
                   <span style="color:#94a3b8">BOD:</span> ${reading.bod || 0}<br>
                   <span style="color:#94a3b8">COD:</span> ${reading.cod || 0}<br>
                   <span style="color:#94a3b8">Turbidity:</span> ${reading.turbidity || 0}`;
        if (reading.__derived) {
          metrics += `<br><span style="color:#38bdf8">Derived from nearest live sensor (${reading.__distanceKm.toFixed(1)} km)</span>`;
        }
      } else {
        metrics = `<span style="color:#94a3b8">Noise:</span> ${reading.noise_level_db || 0} dB<br>
                   <span style="color:#94a3b8">Min:</span> ${reading.noise_min_db || 0} dB<br>
                   <span style="color:#94a3b8">Max:</span> ${reading.noise_max_db || 0} dB`;
        if (reading.__derived) {
          metrics += `<br><span style="color:#38bdf8">Derived from nearest live sensor (${reading.__distanceKm.toFixed(1)} km)</span>`;
        }
      }
    }

    return `<div style="min-width:230px">
      <strong>${ind.name || 'Industrial Zone'}</strong><br>
      <span style="color:#94a3b8">Type:</span> ${type}<br>
      <span style="color:#94a3b8">Category:</span> ${category}<br>
      <span style="color:#94a3b8">Consent:</span> ${consent}<br>
      <hr style="border:0;border-top:1px solid #334155;margin:8px 0">
      <div><strong>${state.activeType.toUpperCase()} Snapshot</strong></div>
      <div>${metrics}</div>
      <div style="margin-top:8px;color:#38bdf8;font-size:11px">Click marker to load this industry on dashboard</div>
    </div>`;
  }

  function refreshIndustryPopups() {
    if (!state.industryMarkers || !state.industryMarkers.length) return;
    state.industryMarkers.forEach(item => {
      const reading = findBestReadingForIndustry(item.industry);
      item.marker.setPopupContent(buildIndustryPopupHtml(item.industry, reading));
    });
  }

  function focusIndustryOnDashboard(industry) {
    const reading = findBestReadingForIndustry(industry);
    if (!reading) return;

    state.selectedIndustry = industry;
    const displayData = { ...reading, name: industry.name || reading.name || 'Industrial Zone' };
    state.selectedLocation = displayData.name;
    updateSidebarCards(displayData);
    fetchWardForecast(reading.name || displayData.name);
  }

  async function loadIndustryLayer() {
    try {
      const resp = await fetch(API_BASE + '/entities/industries');
      const json = await resp.json();
      const list = (json && json.status === 'ok' && Array.isArray(json.data)) ? json.data : [];

      if (state.industryLayer) {
        state.industryLayer.remove();
      }

      state.industryLayer = L.layerGroup();
      state.industryMarkers = [];
      const boundsPoints = [];

      list.forEach((ind) => {
        if (ind.lat == null || ind.lon == null || isNaN(ind.lat) || isNaN(ind.lon)) return;

        const lat = Number(ind.lat);
        const lon = Number(ind.lon);
        const color = getIndustryColor(ind.type);
        const marker = L.circleMarker([lat, lon], {
          radius: 4,
          color,
          weight: 1,
          fillColor: color,
          fillOpacity: 0.8,
          opacity: 0.9
        });

        marker.bindTooltip(ind.name || 'Industrial Zone', {
          className: 'industrial-tooltip',
          direction: 'top',
          opacity: 0.9
        });

        marker.bindPopup(buildIndustryPopupHtml(ind, findBestReadingForIndustry(ind)));

        marker.on('click', () => {
          focusIndustryOnDashboard(ind);
          marker.setPopupContent(buildIndustryPopupHtml(ind, findBestReadingForIndustry(ind)));
          marker.openPopup();
        });

        marker.addTo(state.industryLayer);
        state.industryMarkers.push({ marker, industry: ind });
        boundsPoints.push([lat, lon]);
      });

      state.industryLayer.addTo(state.map);

      if (boundsPoints.length > 0 && !state.industrialLayer) {
        const b = L.latLngBounds(boundsPoints);
        if (b.isValid()) {
          state.map.fitBounds(b, { padding: [30, 30], maxZoom: 9 });
        }
      }

      console.log('[PrithviNet] Industry markers loaded:', list.length);
    } catch (err) {
      console.warn('[PrithviNet] Failed to load industries layer:', err.message);
    }
  }

  // Bind tab switchers
  document.querySelectorAll('.param-tab').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.param-tab').forEach(b => b.classList.remove('active'));
      e.currentTarget.classList.add('active');
      state.activeType = e.currentTarget.dataset.type;
      if (state.dataCache[state.activeType]) {
        applyData(state.dataCache[state.activeType]);
      }
      refreshIndustryPopups();
    });
  });

  /* ==========================================
     EXPAND / COLLAPSE DETAIL PANEL
     ========================================== */
  function toggleExpanded() {
    state.isExpanded = !state.isExpanded;
    const main = document.querySelector('.main-content');
    const btn = document.getElementById('expand-btn');
    const mapCol = document.querySelector('.map-col');

    if (state.isExpanded) {
      main.classList.add('expanded');
      btn.classList.add('active');
      // Lazy-init detail chart on first open
      if (!state.detailChart) {
        initDetailChart();
      }
      updateDetailTimeLabel();
      fetchWardForecast7Day(state.selectedWard);
    } else {
      main.classList.remove('expanded');
      btn.classList.remove('active');
    }

    // Trigger Leaflet map resize after CSS transition ends
    mapCol.addEventListener('transitionend', function handler() {
      if (state.map) state.map.invalidateSize();
      mapCol.removeEventListener('transitionend', handler);
    });
  }

  /* ==========================================
     DETAIL PANEL — TIME LABEL
     ========================================== */
  function updateDetailTimeLabel() {
    const el = document.getElementById('dp-time-label');
    if (!el) return;
    const now = new Date();
    const opts = { hour: '2-digit', minute: '2-digit', weekday: 'short', month: 'short', day: 'numeric' };
    const parts = now.toLocaleString('en-US', opts).toUpperCase();
    el.textContent = '7-DAY FORECAST \u2014 ' + state.selectedWard + ' \u2014 ' + parts;
  }

  /* ==========================================
     DETAIL CHART (7-Day Ward Forecast)
     ========================================== */
  function initDetailChart() {
    const ctx = document.getElementById('detailChart');
    if (!ctx) return;

    state.detailChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: [],
        datasets: [{
          data: [],
          backgroundColor: [],
          borderRadius: 3,
          barPercentage: 0.7
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 800, easing: 'easeOutQuart' },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            enabled: true,
            backgroundColor: 'rgba(15, 23, 42, 0.92)',
            titleColor: '#94a3b8',
            bodyColor: '#f1f5f9',
            titleFont: { size: 11, family: 'Inter' },
            bodyFont: { size: 13, weight: 'bold', family: 'Inter' },
            padding: 10,
            cornerRadius: 8,
            displayColors: false,
            callbacks: {
              title: function (items) { return items[0] ? items[0].label : ''; },
              label: function (item) { return 'AQI: ' + item.raw; }
            }
          }
        },
        scales: {
          x: {
            display: true,
            ticks: {
              color: '#94a3b8',
              font: { size: 9, family: 'Inter' },
              maxRotation: 0,
              autoSkip: true,
              maxTicksLimit: 7
            },
            grid: { display: false }
          },
          y: { display: false, min: 0, max: 350 }
        }
      }
    });
  }

  /* ==========================================
     CHART.JS FORECAST INIT (1-Day Ward Forecast)
     ========================================== */
  function initChart() {
    const ctx = document.getElementById('forecastChart');
    if (!ctx) return;

    state.chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          {
            label: 'Upper Bound',
            data: [],
            borderColor: 'transparent',
            backgroundColor: 'rgba(156, 39, 176, 0.15)',
            fill: '+1',
            pointRadius: 0,
            tension: 0.3
          },
          {
            label: 'Lower Bound',
            data: [],
            borderColor: 'transparent',
            fill: false,
            pointRadius: 0,
            tension: 0.3
          },
          {
            label: 'Forecast',
            data: [],
            borderColor: '#9c27b0',
            borderWidth: 2,
            borderDash: [5, 5],
            pointBackgroundColor: '#9c27b0',
            pointRadius: 4,
            fill: false,
            tension: 0.3
          },
          {
            label: 'Historical',
            data: [],
            borderColor: '#4ade80',
            borderWidth: 2,
            pointBackgroundColor: '#4ade80',
            pointRadius: 3,
            fill: false,
            tension: 0.3
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            enabled: true,
            backgroundColor: 'rgba(15, 23, 42, 0.92)',
            titleColor: '#94a3b8',
            bodyColor: '#f1f5f9',
            titleFont: { size: 11, family: 'Inter' },
            bodyFont: { size: 13, weight: 'bold', family: 'Inter' },
            callbacks: {
              label: function (item) { 
                if (item.dataset.label.includes('Bound')) return null; // Hide bounds in tooltip
                return item.dataset.label + ': ' + Math.round(item.raw); 
              }
            }
          }
        },
        scales: {
          x: {
            display: true,
            ticks: {
              color: '#64748b',
              font: { size: 9, family: 'Inter' },
              maxRotation: 0,
              autoSkip: true,
              maxTicksLimit: 6
            },
            grid: { display: false }
          },
          y: { display: false, min: 0 }
        }
      }
    });
  }

  /* ==========================================
     DOM UPDATES (Left Column Cards)
     ========================================== */
  function updateSidebarCards(data) {
    if (!data) return;

    // Use AQI or calculate a pseudo-index for styles
    let indexVal = 0;
    let mainLabel = '';
    
    if (state.activeType === 'air') {
      indexVal = data.aqi || 0;
      mainLabel = 'AQI';
    } else if (state.activeType === 'water') {
      // pH diff + turbidity/10 as hacky index 0-100
      indexVal = Math.min(100, (Math.abs((data.ph||7)-7)*15) + (data.turbidity||0)*2);
      mainLabel = 'WQI';
    } else if (state.activeType === 'noise') {
      indexVal = data.noise_level_db || 0;
      mainLabel = 'dB';
    }

    const info = getAQIInfo(indexVal * (state.activeType === 'noise' ? 2 : (state.activeType === 'water' ? 2 : 1)));

    // Update Forecast Card Header
    document.getElementById('fc-location-name').innerHTML = `${data.name || state.selectedLocation} <svg viewBox="0 0 24 24" class="icon-sm" fill="none"><path d="M12 2L2 22l10-4 10 4L12 2z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`;
    document.getElementById('fc-status').textContent = info.label;
    
    // Animate Top Circular Progress
    const pct = Math.min(indexVal / (state.activeType === 'noise' ? 140 : 300), 1);
    const offset = 175.9 * (1 - pct);
    const ring = document.getElementById('fc-ring-progress');
    const dot = document.getElementById('fc-ring-dot');
    if (ring && dot) {
      ring.style.strokeDashoffset = offset;
      ring.setAttribute('stroke', info.color);
      dot.style.transform = `rotate(${pct * 360}deg)`;
      dot.setAttribute('fill', info.color);
    }
    
    document.getElementById('fc-aqi-val').textContent = Math.round(indexVal);
    document.querySelector('.circle-lbl').textContent = mainLabel;

    // ------ Sync Detail Panel ------
    const setEl = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
    const locEl = document.getElementById('dp-location');
    if (locEl) locEl.innerHTML = `${data.name || state.selectedLocation} <svg class="icon-sm" viewBox="0 0 24 24" fill="none"><path d="M12 2L2 22l10-4 10 4L12 2z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`;
    setEl('dp-condition', info.label);
    setEl('dp-aqi-num', Math.round(indexVal));
    
    const badgeLbl = document.querySelector('.dp-aqi-lbl');
    if (badgeLbl) badgeLbl.textContent = mainLabel;

    // Update Pollutants dynamically based on activeType
    const pollContainer = document.querySelector('.dp-pollutants');
    if (pollContainer) {
      let html = '';
      if (state.activeType === 'air') {
        html = `
          <div class="dp-poll-item"><span class="dp-p-val">${data.pm25 || 0}</span><span class="dp-p-lbl">PM2.5</span></div>
          <div class="dp-poll-sep"></div>
          <div class="dp-poll-item"><span class="dp-p-val">${data.pm10 || 0}</span><span class="dp-p-lbl">PM10</span></div>
          <div class="dp-poll-sep"></div>
          <div class="dp-poll-item"><span class="dp-p-val">${data.no2 || 0}</span><span class="dp-p-lbl">NO₂</span></div>
          <div class="dp-poll-sep"></div>
          <div class="dp-poll-item"><span class="dp-p-val">${data.o3 || 0}</span><span class="dp-p-lbl">O₃</span></div>
          <div class="dp-poll-sep"></div>
          <div class="dp-poll-item"><span class="dp-p-val">${data.so2 || 0}</span><span class="dp-p-lbl">SO₂</span></div>
        `;
      } else if (state.activeType === 'water') {
        html = `
          <div class="dp-poll-item"><span class="dp-p-val">${data.ph || 0}</span><span class="dp-p-lbl">pH</span></div>
          <div class="dp-poll-sep"></div>
          <div class="dp-poll-item"><span class="dp-p-val">${data.dissolved_oxygen || 0}</span><span class="dp-p-lbl">DO</span></div>
          <div class="dp-poll-sep"></div>
          <div class="dp-poll-item"><span class="dp-p-val">${data.bod || 0}</span><span class="dp-p-lbl">BOD</span></div>
          <div class="dp-poll-sep"></div>
          <div class="dp-poll-item"><span class="dp-p-val">${data.cod || 0}</span><span class="dp-p-lbl">COD</span></div>
          <div class="dp-poll-sep"></div>
          <div class="dp-poll-item"><span class="dp-p-val">${data.turbidity || 0}</span><span class="dp-p-lbl">Turbidity</span></div>
        `;
      } else if (state.activeType === 'noise') {
        html = `
          <div class="dp-poll-item"><span class="dp-p-val">${data.noise_level_db || 0}</span><span class="dp-p-lbl">Avg dB</span></div>
          <div class="dp-poll-sep"></div>
          <div class="dp-poll-item"><span class="dp-p-val">${data.noise_min_db || 0}</span><span class="dp-p-lbl">Min dB</span></div>
          <div class="dp-poll-sep"></div>
          <div class="dp-poll-item"><span class="dp-p-val">${data.noise_max_db || 0}</span><span class="dp-p-lbl">Max dB</span></div>
        `;
      }
      pollContainer.innerHTML = html;
    }

    const badge = document.querySelector('.dp-aqi-badge');
    if (badge) {
      badge.style.borderColor = info.color + '80';
      badge.style.boxShadow   = `0 0 24px ${info.color}40, inset 0 0 16px ${info.color}15`;
      badge.style.background  = info.color + '18';
    }
    const numEl = document.getElementById('dp-aqi-num');
    if (numEl) numEl.style.color = info.color;

    // Update forecast card time
    const timeEl = document.getElementById('fc-time');
    if (timeEl) {
      const now = new Date();
      timeEl.textContent = now.toLocaleString('en-IN', {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
      }) + ', local time';
    }

    const metricModel = getMetricModel(data);
    pushMonitoringSnapshot(data, metricModel, info);
    renderMonitoringPanel(data, metricModel, info);
  }

  /* ==========================================
     MAP — LEAFLET + HEATMAP
     ========================================== */
  function getPolygonCentroid(coords) {
    let ring = coords;
    while (Array.isArray(ring[0]) && Array.isArray(ring[0][0])) { ring = ring[0]; }
    let sumLat = 0, sumLng = 0, count = 0;
    for (const point of ring) { sumLng += point[0]; sumLat += point[1]; count++; }
    return [sumLat / count, sumLng / count];
  }

  async function initMap() {
    state.map = L.map('map', { center: [21.19, 81.35], zoom: 12, zoomControl: false, attributionControl: false, zoomSnap: 0.5 });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { subdomains: 'abcd', maxZoom: 19 }).addTo(state.map);

    try {
      // === Layer 1: Chhattisgarh Industrial Zones (subtle background) ===
      try {
        const indResp = await fetch('chhattisgarh_industries.geojson');
        if (indResp.ok) {
          const indGeo = await indResp.json();
          state.industrialLayer = L.geoJSON(indGeo, {
            style: function (feature) {
              const cat = feature.properties.category;
              const borderColor = cat === 'red' ? '#ef4444' : '#f59e0b';
              return {
                color: borderColor,
                weight: 1,
                opacity: 0.6,
                fillColor: borderColor,
                fillOpacity: 0.08,
                dashArray: '4 3'
              };
            },
            onEachFeature: function (feature, layer) {
              const name = feature.properties.name || 'Industrial Zone';
              const op = feature.properties.operator || '';
              layer.bindTooltip(`<strong>${name}</strong><br><span style="color:#94a3b8">${op}</span>`, {
                className: 'industrial-tooltip',
                direction: 'top',
                opacity: 0.9
              });
            }
          }).addTo(state.map);

          // Fit map to the industrial layer bounds
          const indBounds = state.industrialLayer.getBounds();
          if (indBounds.isValid()) {
            state.map.fitBounds(indBounds, { padding: [30, 30], maxZoom: 10 });
          }
          console.log('[PrithviNet] Chhattisgarh industrial overlay loaded');
        }
      } catch (indErr) {
        console.warn('[PrithviNet] Industrial GeoJSON not available:', indErr.message);
      }

      // Draw all industries from DB/API as marker layer
      await loadIndustryLayer();

      // === Layer 2: Demo Region Zones (interactive) ===
      const response = await fetch('demo_region.geojson');
      state.geojson = await response.json();

      // Create GeoJSON layer
      state.geoJsonLayer = L.geoJSON(state.geojson, {
        style: function (feature) {
          return { color: feature.properties.stroke, weight: 2, opacity: 0.8, fillColor: feature.properties.fill, fillOpacity: 0.2 };
        },
        onEachFeature: function (feature, layer) {
          const name = feature.properties.name || 'Unknown Zone';

          layer.on({
            click: function (e) {
              L.DomEvent.stopPropagation(e);
              state.selectedIndustry = null;
              state.selectedLocation = name;
              
              if (state.geoJsonLayer) state.geoJsonLayer.resetStyle();
              e.target.setStyle({ fillOpacity: 0.45, weight: 3 });

              if (state.dataCache[state.activeType]) {
                const match = state.dataCache[state.activeType].find(d => d.name === name || d.region === name);
                if (match) {
                  updateSidebarCards(match);
                }
              }
              // Fetch immediate forecast for newly selected location
              fetchWardForecast(name);
            },
            mouseover: function (e) {
              e.target.setStyle({ fillOpacity: 0.4, weight: 2.5 });
              e.target.bringToFront();
            },
            mouseout: function (e) {
              state.geoJsonLayer.resetStyle(e.target);
              if (name === state.selectedLocation) {
                e.target.setStyle({ fillOpacity: 0.45, weight: 3 });
              }
            }
          });
          state.wardLayers.push(layer);
        }
      }).addTo(state.map);

      // Connect SSE for real-time updates
      connectSSE();

    } catch (error) {
      console.error("GeoJSON/API load error:", error);
    }
  }

  /* ==========================================
     LIVE DATA FETCH FROM BACKEND
     ========================================== */
  async function fetchLiveData() {
    try {
      const resp = await fetch(API_BASE + '/wards');
      const json = await resp.json();
      if (json.status === 'ok' && json.wards && json.wards.length > 0) {
        applyWardData(json.wards, json.city);
        console.log('[PrithviNet] Live data loaded:', json.wards.length, 'wards');
        updateLiveIndicator(true);
      } else {
        console.warn('[PrithviNet] No live data yet — backend may be fetching');
        updateLiveIndicator(false);
      }
    } catch (err) {
      console.warn('[PrithviNet] Backend not available:', err.message);
      updateLiveIndicator(false);
    }
  }

  /* ==========================================
     APPLY WARD DATA TO MAP + CARDS
     ========================================== */
  function applyData(dataList) {
    if (!dataList || dataList.length === 0) return;

    refreshIndustryPopups();

    const heatPoints = [];

    // Pull points based on locations
    dataList.forEach(d => {
      if (d.lat && d.lon) {
        let intensity = 0;
        if (state.activeType === 'air') intensity = Math.min((d.aqi || 0) / 300, 1.0);
        else if (state.activeType === 'water') intensity = Math.min(((d.ph||7-7)*10 + (d.turbidity||0)*2) / 100, 1.0);
        else if (state.activeType === 'noise') intensity = Math.min((d.noise_level_db || 0) / 120, 1.0);

        if (intensity > 0) {
          heatPoints.push([d.lat, d.lon, Math.max(0.1, intensity)]);
          // Add spread
          for (let i = 0; i < 4; i++) {
            heatPoints.push([
              d.lat + (Math.random() - 0.5) * 0.05,
              d.lon + (Math.random() - 0.5) * 0.05,
              intensity * (0.4 + Math.random() * 0.4)
            ]);
          }
        }
      }
    });

    // Update heatmap
    if (state.heatmapLayer) {
      state.heatmapLayer.remove();
    }
    if (L.heatLayer && heatPoints.length > 0) {
      let gradientOpts = {};
      if (state.activeType === 'air') {
        gradientOpts = { 0: '#00e676', 0.3: '#fbbf24', 0.5: '#ff9800', 0.75: '#f44336', 1: '#9c27b0' };
      } else if (state.activeType === 'water') {
        gradientOpts = { 0: '#00d4ff', 0.5: '#3b82f6', 1: '#1e3a8a' };
      } else if (state.activeType === 'noise') {
        gradientOpts = { 0: '#a78bfa', 0.5: '#8b5cf6', 1: '#4c1d95' };
      }

      state.heatmapLayer = L.heatLayer(heatPoints, {
        radius: 35, blur: 25, maxZoom: 14, minOpacity: 0.4,
        gradient: gradientOpts
      });
      if (state.heatmapVisible) state.heatmapLayer.addTo(state.map);
    }

    // Keep selected industry in control of the cards when one is active.
    let selectedData = null;
    if (state.selectedIndustry) {
      const indReading = findBestReadingForIndustry(state.selectedIndustry);
      if (indReading) {
        selectedData = { ...indReading, name: state.selectedIndustry.name || indReading.name || state.selectedLocation };
      }
    }

    if (!selectedData) {
      selectedData = dataList[0];
      if (state.selectedLocation) {
          const match = dataList.find(d => d.name === state.selectedLocation || d.region === state.selectedLocation);
          if (match) selectedData = match;
      }
    }
    
    if (selectedData) {
      updateSidebarCards(selectedData);
      fetchWardForecast(selectedData.name || state.selectedLocation);
    }
  }

  /* ==========================================
     WARD FORECAST — 1-DAY & 7-DAY
     ========================================== */
  async function fetchWardForecast(wardName) {
    if (state.chart) {
      await fetchWardForecast1Day(wardName);
    }
    if (state.detailChart) {
      // Stub for backward compatibility
      // fetchWardForecast7Day(wardName); 
    }
  }

  async function fetchWardForecast1Day(wardName) {
    try {
      const resp = await fetch(API_BASE + '/forecast?location_name=' + encodeURIComponent(wardName) + '&type=' + state.activeType);
      if (!resp.ok) return; // Don't crash on 404/500
      const json = await resp.json();
      if (json.status === 'ok') {
        updateForecastChart(json);
      }
    } catch (_) { /* keep existing chart on network errors */ }
  }

  function updateForecastChart(forecastData) {
    if (!state.chart) return;
    
    const hist = forecastData.historical || [];
    const fc = forecastData.forecast || [];

    // Safety: if both are empty, don't touch the chart
    if (hist.length === 0 && fc.length === 0) return;
    
    // Labels
    const labels = [];
    hist.forEach((_, i) => labels.push(`T-${hist.length - i}`));
    labels.push('+24H', '+48H', '+72H');

    // Build data arrays padded with nulls so they align on the x-axis
    const upperData = Array(hist.length).fill(null);
    const lowerData = Array(hist.length).fill(null);
    const fcData = Array(hist.length).fill(null);
    const histData = [...hist, null, null, null]; // Pad end

    // Connect the historical line to the forecast origin
    if (hist.length > 0) {
      const lastHist = hist[hist.length - 1];
      fcData[hist.length - 1] = lastHist;
      upperData[hist.length - 1] = lastHist;
      lowerData[hist.length - 1] = lastHist;
    }

    fc.forEach(f => {
      upperData.push(f.upper);
      lowerData.push(f.lower);
      fcData.push(f.point);
    });

    state.chart.data.labels = labels;
    state.chart.data.datasets[0].data = upperData;
    state.chart.data.datasets[1].data = lowerData;
    state.chart.data.datasets[2].data = fcData;
    state.chart.data.datasets[3].data = histData;

    // Adjust Y max
    const allVals = [...hist, ...fc.map(f=>f.upper)];
    const maxVal = Math.max(...allVals, 100);
    state.chart.options.scales.y.max = maxVal * 1.2;
    state.chart.update('none');
  }

  /* ==========================================
     SSE (Server-Sent Events) — REAL-TIME
     ========================================== */
  function connectSSE() {
    try {
      const es = new EventSource(API_BASE + '/events');

      es.addEventListener('connected', () => {
        state.sseConnected = true;
        console.log('[PrithviNet] SSE connected');
        updateLiveIndicator(true);
      });

      es.addEventListener('update', (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.dataType && data.payload) {
            state.dataCache[data.dataType] = data.payload;
            if (state.activeType === data.dataType) {
              applyData(data.payload);
              console.log(`[PrithviNet] Real-time update applied for ${data.dataType}:`, data.payload.length, 'locations');
            }
          }
        } catch (err) {
          console.error('[PrithviNet] SSE parse error:', err);
        }
      });

      es.addEventListener('ping', () => { /* heartbeat */ });

      es.onerror = () => {
        state.sseConnected = false;
        updateLiveIndicator(false);
        // EventSource auto-reconnects
      };
    } catch (_) {
      console.warn('[PrithviNet] SSE not available');
    }
  }

  function updateLiveIndicator(live) {
    const dot = document.querySelector('.sidebar-status .status-dot');
    const label = document.querySelector('.sidebar-status span');
    if (dot) {
      dot.classList.toggle('online', live);
      dot.classList.toggle('offline', !live);
    }
    if (label) label.textContent = live ? 'Live' : 'Offline';
  }

  window.mapZoomIn = () => state.map?.zoomIn();
  window.mapZoomOut = () => state.map?.zoomOut();
  window.toggleExpanded = toggleExpanded;
  window.getWardAlertData = () => state.wardAlertData;
  window.toggleHeatmap = () => {
    if (!state.heatmapLayer) return;
    state.heatmapVisible = !state.heatmapVisible;
    const lbl = document.getElementById('heatmap-toggle-lbl');

    if (state.heatmapVisible) {
      state.heatmapLayer.addTo(state.map);
      if (lbl) lbl.textContent = '🗺️ Ward View';
    } else {
      state.heatmapLayer.remove();
      if (lbl) lbl.textContent = '🌡️ Heatmap';
    }
  };

  /* ==========================================
     GEMINI RECOMMENDATIONS
     ========================================== */
    const DEFAULT_WARD = 'Bhilai Steel Plant (Industrial Zone)';
    const DEFAULT_RECO_REGION = { lat: 21.1938, lng: 81.3509, radiusKm: 25 };

  async function fetchRecommendations() {
    const wardName = DEFAULT_WARD;

    const card = document.getElementById('reco-card');
    if (!card) return;

    try {
      const resp = await fetch(
        API_BASE + '/recommendations?ward=' + encodeURIComponent(wardName)
        + '&lat=' + encodeURIComponent(DEFAULT_RECO_REGION.lat)
        + '&lng=' + encodeURIComponent(DEFAULT_RECO_REGION.lng)
        + '&radius_km=' + encodeURIComponent(DEFAULT_RECO_REGION.radiusKm)
      );
      const json = await resp.json();
      if (json.status !== 'ok') throw new Error(json.message);
      renderRecommendations(json);
    } catch (err) {
      console.error('[PrithviNet] Recommendations error:', err);
      // Show fallback content
      const headline = document.getElementById('reco-headline');
      if (headline) headline.textContent = 'Unable to load — retrying soon';
    }
  }

  function renderRecommendations(data) {
    const info = getAQIInfo(data.aqi || 0);
    function clean(s) { return (s || '').replace(/\*+/g, ''); }

    // Headline + summary
    const hl = document.getElementById('reco-headline');
    if (hl) hl.textContent = clean(data.headline) || `AQI ${data.aqi} ${info.label}`;

    const summary = document.getElementById('reco-summary');
    if (summary) summary.textContent = clean(data.summary) || '';

    // Confidence
    const confBadge = document.getElementById('reco-conf-badge');
    const confVal = document.getElementById('reco-conf-val');
    if (confVal) confVal.textContent = data.confidence || '—';

    // AQI pill
    const pill = document.getElementById('reco-aqi-pill');
    if (pill) pill.style.borderColor = info.color + '60';
    const aqiVal = document.getElementById('aqi-card-val');
    if (aqiVal) { aqiVal.textContent = data.aqi || '—'; aqiVal.style.color = info.color; }

    // Location
    const loc = document.getElementById('aqi-card-location');
    if (loc) loc.textContent = '📍 WARD: ' + DEFAULT_WARD;

    // Alerts (time-sensitive, from reports)
    const alertsEl = document.getElementById('reco-alerts');
    if (alertsEl) {
      if (data.alerts && data.alerts.length > 0) {
        alertsEl.innerHTML = data.alerts.map(a =>
          `<div class="reco-alert-item">
            <span class="reco-alert-icon">⚠</span>
            <span class="reco-alert-text">${clean(a.text)}</span>
            ${a.timeLeft ? `<span class="reco-alert-time">${a.timeLeft}</span>` : ''}
          </div>`
        ).join('');
      } else {
        alertsEl.innerHTML = '';
      }
    }

    // Outdoor guidelines
    const outdoorEl = document.getElementById('reco-outdoor');
    if (outdoorEl && data.outdoor) {
      outdoorEl.innerHTML = data.outdoor.map(g =>
        `<li><strong>${clean(g.title)}:</strong> ${clean(g.detail)}</li>`
      ).join('');
    }

    // Indoor guidelines
    const indoorEl = document.getElementById('reco-indoor');
    if (indoorEl && data.indoor) {
      indoorEl.innerHTML = data.indoor.map(g =>
        `<li><strong>${clean(g.title)}:</strong> ${clean(g.detail)}</li>`
      ).join('');
    }

    // Footer meta
    const meta = document.getElementById('reco-meta');
    if (meta) {
      const reportNote = data.reportCount > 0 ? ` · ${data.reportCount} active report${data.reportCount > 1 ? 's' : ''}` : '';
      meta.textContent = `Based on local data & map pins${reportNote}`;
    }

    // Pulse ring color
    const ring = document.getElementById('aqi-pulse-ring');
    if (ring) ring.style.borderColor = info.color;
  }

  window.refreshRecommendations = function () {
    const btn = document.querySelector('.reco-refresh-btn');
    if (btn) { btn.classList.add('spinning'); setTimeout(() => btn.classList.remove('spinning'), 1500); }
    fetchRecommendations();
  };

  /* ==========================================
     BOOTSTRAP
     ========================================== */
  document.addEventListener('DOMContentLoaded', () => {
    initChart();
    initMap().then(() => {
      if (window.initReports) window.initReports(state.map);
      // Fetch recommendations for Bhilai default region
      setTimeout(() => fetchRecommendations(), 3000);
      // Auto-refresh every 5 min
      setInterval(() => fetchRecommendations(), 5 * 60 * 1000);
    });
  });

})();
