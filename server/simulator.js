/* ==========================================
   PrithviNet — IoT Simulator (Water & Noise ONLY)
   ==========================================
   Air quality data now comes from the live WAQI API.
   This module only generates simulated readings for
   Water and Noise monitoring locations.
   
   Also provides a generateAirFallback() function
   used by the fetcher if the WAQI API is unavailable.
   ========================================== */

const db = require('./db');

const INDUSTRY_PROFILES = {
  steel: {
    air: { pm25: 130, pm10: 240, no2: 55, so2: 60, co: 2.5, o3: 30 },
    water: { ph: 7.0, dissolved_oxygen: 5.6, bod: 25, cod: 85, turbidity: 30, conductivity: 850 },
    noise: { level: 80 }
  },
  mining: {
    air: { pm25: 150, pm10: 300, no2: 45, so2: 35, co: 1.8, o3: 25 },
    water: { ph: 7.4, dissolved_oxygen: 5.2, bod: 20, cod: 70, turbidity: 65, conductivity: 700 },
    noise: { level: 83 }
  },
  power: {
    air: { pm25: 110, pm10: 210, no2: 60, so2: 95, co: 3.1, o3: 35 },
    water: { ph: 8.1, dissolved_oxygen: 5.0, bod: 18, cod: 75, turbidity: 28, conductivity: 780 },
    noise: { level: 76 }
  },
  cement: {
    air: { pm25: 120, pm10: 280, no2: 40, so2: 30, co: 1.6, o3: 28 },
    water: { ph: 8.4, dissolved_oxygen: 5.4, bod: 16, cod: 65, turbidity: 45, conductivity: 820 },
    noise: { level: 79 }
  },
  chemical: {
    air: { pm25: 100, pm10: 190, no2: 65, so2: 55, co: 2.7, o3: 40 },
    water: { ph: 5.9, dissolved_oxygen: 4.8, bod: 36, cod: 140, turbidity: 22, conductivity: 1200 },
    noise: { level: 74 }
  },
  default: {
    air: { pm25: 85, pm10: 160, no2: 40, so2: 20, co: 1.5, o3: 30 },
    water: { ph: 7.2, dissolved_oxygen: 6.5, bod: 15, cod: 40, turbidity: 10, conductivity: 500 },
    noise: { level: 58 }
  }
};

function getIndustryTypeMap() {
  const map = {};
  const industries = db.getAllIndustries();
  industries.forEach(i => {
    map[i.id] = (i.type || '').toLowerCase();
  });
  return map;
}

function getProfileForType(industryType) {
  if (!industryType) return INDUSTRY_PROFILES.default;
  return INDUSTRY_PROFILES[industryType] || INDUSTRY_PROFILES.default;
}

// Simple AQI calculation based on PM2.5 and PM10 (fallback logic)
function calcAQI(pm25, pm10) {
  const aq25 = pm25 ? pm25 * 1.5 : 0;
  const aq10 = pm10 ? pm10 * 0.8 : 0;
  return Math.round(Math.max(aq25, aq10));
}

function getDominant(pm25, pm10) {
  return (pm25 * 1.5) > (pm10 * 0.8) ? 'PM2.5' : 'PM10';
}

// Helper for random number in range
function rand(min, max, decimals = 1) {
  const num = Math.random() * (max - min) + min;
  return parseFloat(num.toFixed(decimals));
}

// Generate slight variation from previous value, or baseline if no prev
function vary(prev, baseline, variance, min = 0, max = Infinity) {
  let val = prev !== undefined && prev !== null ? prev : baseline;
  val += rand(-variance, variance);
  return parseFloat(Math.max(min, Math.min(max, val)).toFixed(1));
}

// Keep a small in-memory history to make data look continuous
const history = {};

/**
 * Build a full DB-compatible reading object with all columns.
 */
function buildFullReading(reading) {
  return {
    location_id: reading.location_id,
    industry_id: reading.industry_id,
    type: reading.type,
    aqi: reading.aqi || null,
    pm25: reading.pm25 || null,
    pm10: reading.pm10 || null,
    no2: reading.no2 || null,
    o3: reading.o3 || null,
    so2: reading.so2 || null,
    co: reading.co || null,
    ph: reading.ph || null,
    dissolved_oxygen: reading.dissolved_oxygen || null,
    bod: reading.bod || null,
    cod: reading.cod || null,
    turbidity: reading.turbidity || null,
    conductivity: reading.conductivity || null,
    noise_level_db: reading.noise_level_db || null,
    noise_min_db: reading.noise_min_db || null,
    noise_max_db: reading.noise_max_db || null,
    temperature: reading.temperature,
    humidity: reading.humidity,
    wind_speed: reading.wind_speed,
    pressure: reading.pressure,
    dominant: reading.dominant || null,
    submitted_by: reading.submitted_by,
    source: reading.source
  };
}

/**
 * Generate simulated Water and Noise data ONLY.
 * Air is handled by the live WAQI API in fetcher.js.
 */
function generateData() {
  const locations = db.getAllMonitoringLocations();
  const industryTypeMap = getIndustryTypeMap();
  const newData = [];

  locations.forEach(loc => {
    // SKIP air locations — handled by WAQI API
    if (loc.type === 'air') return;

    const prev = history[loc.id] || {};
    const industryType = loc.industry_id ? industryTypeMap[loc.industry_id] : null;
    const profile = getProfileForType(industryType);

    let reading = {
      location_id: loc.id,
      industry_id: loc.industry_id || null,
      type: loc.type,
      source: 'iot_simulator',
      submitted_by: null,
      temperature: vary(prev.temperature, 30, 1.5, -10, 50),
      humidity: vary(prev.humidity, 60, 3, 0, 100),
      wind_speed: vary(prev.wind_speed, 5, 1, 0, 50),
      pressure: vary(prev.pressure, 1010, 2, 900, 1100)
    };

    if (loc.type === 'water') {
      reading.ph = vary(prev.ph, profile.water.ph, 0.35, 0, 14, 2);
      reading.dissolved_oxygen = vary(prev.dissolved_oxygen, profile.water.dissolved_oxygen, 0.6, 0, 20);
      reading.bod = vary(prev.bod, profile.water.bod, 4, 0, 100);
      reading.cod = vary(prev.cod, profile.water.cod, 12, 0, 500);
      reading.turbidity = vary(prev.turbidity, profile.water.turbidity, 4, 0, 1000);
      reading.conductivity = vary(prev.conductivity, profile.water.conductivity, 70, 0, 5000);
    } 
    else if (loc.type === 'noise') {
      const regionBased = loc.region && loc.region.toLowerCase().includes('industry') ? 72 : 55;
      const baseNoise = industryType ? profile.noise.level : regionBased;
      reading.noise_level_db = vary(prev.noise_level_db, baseNoise, 5, 30, 140);
      reading.noise_min_db = parseFloat((reading.noise_level_db - rand(2, 8)).toFixed(1));
      reading.noise_max_db = parseFloat((reading.noise_level_db + rand(5, 15)).toFixed(1));
    }

    // Save to history for next cycle
    history[loc.id] = reading;
    newData.push(buildFullReading(reading));
  });

  return newData;
}

/**
 * Fallback: Generate simulated AIR data if WAQI API is unavailable.
 * Called by fetcher.js only when the API returns no results.
 */
function generateAirFallback() {
  const locations = db.getAllMonitoringLocations().filter(l => l.type === 'air');
  const industryTypeMap = getIndustryTypeMap();
  const newData = [];

  locations.forEach(loc => {
    const prev = history[loc.id] || {};
    const industryType = loc.industry_id ? industryTypeMap[loc.industry_id] : null;
    const profile = getProfileForType(industryType);

    let reading = {
      location_id: loc.id,
      industry_id: loc.industry_id || null,
      type: 'air',
      source: 'simulator_fallback',
      submitted_by: null,
      temperature: vary(prev.temperature, 30, 1.5, -10, 50),
      humidity: vary(prev.humidity, 60, 3, 0, 100),
      wind_speed: vary(prev.wind_speed, 5, 1, 0, 50),
      pressure: vary(prev.pressure, 1010, 2, 900, 1100)
    };

    reading.pm25 = vary(prev.pm25, profile.air.pm25, 16, 0, 999);
    reading.pm10 = vary(prev.pm10, profile.air.pm10, 28, 0, 999);
    reading.no2 = vary(prev.no2, profile.air.no2, 9, 0, 500);
    reading.so2 = vary(prev.so2, profile.air.so2, 8, 0, 500);
    reading.co = vary(prev.co, profile.air.co, 0.5, 0, 50);
    reading.o3 = vary(prev.o3, profile.air.o3, 10, 0, 500);
    reading.aqi = calcAQI(reading.pm25, reading.pm10);
    reading.dominant = getDominant(reading.pm25, reading.pm10);

    history[loc.id] = reading;
    newData.push(buildFullReading(reading));
  });

  return newData;
}

module.exports = {
  generateData,
  generateAirFallback
};
