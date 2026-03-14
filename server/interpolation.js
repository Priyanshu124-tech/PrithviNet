/* ==========================================
   PrithviNet — IDW Spatial Interpolation
   ==========================================
   Inverse Distance Weighting (IDW) to map
   monitoring station readings → region-level values
   ========================================== */

'use strict';

const fs   = require('fs');
const path = require('path');

/* ---------- HAVERSINE DISTANCE (km) ---------- */
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
          * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* ---------- POLYGON CENTROID ---------- */
function getPolygonCentroid(coords) {
  let ring = coords;
  // Drill down to the deepest ring
  while (Array.isArray(ring[0]) && Array.isArray(ring[0][0])) {
    ring = ring[0];
  }
  let sumLat = 0, sumLng = 0, count = 0;
  for (const point of ring) {
    sumLng += point[0];
    sumLat += point[1];
    count++;
  }
  return { lat: sumLat / count, lng: sumLng / count };
}

/* ---------- LOAD WARD CENTROIDS ---------- */
let wardCentroids = null;

function loadWardCentroids() {
  if (wardCentroids) return wardCentroids;

  const geoFile = path.join(__dirname, '..', 'Delhi_Boundary.geojson');
  const geojson = JSON.parse(fs.readFileSync(geoFile, 'utf-8'));

  wardCentroids = geojson.features.map(f => ({
    name: f.properties.Ward_Name || 'Unknown Ward',
    wardNo: f.properties.Ward_No || '',
    centroid: getPolygonCentroid(f.geometry.coordinates)
  }));

  console.log(`[IDW] Loaded ${wardCentroids.length} ward centroids`);
  return wardCentroids;
}

/* ---------- IDW INTERPOLATION ---------- */
/**
 * Compute ward-level AQI using IDW from station readings.
 *
 * @param {Array} stations - [{uid, lat, lon, aqi, pm25, pm10, no2, o3, so2, co, dominant}]
 * @param {Object} options - { k: 3, power: 2 }
 * @returns {Array} - [{ward_name, aqi, pm25, pm10, no2, o3, so2, co, dominant}]
 */
function interpolateWards(stations, options = {}) {
  const { k = 3, power = 2 } = options;
  const wards = loadWardCentroids();

  // Filter out invalid stations
  const validStations = stations.filter(s =>
    s.aqi != null && !isNaN(s.aqi) && s.aqi > 0 &&
    s.lat != null && s.lon != null
  );

  if (validStations.length === 0) {
    console.warn('[IDW] No valid stations to interpolate from');
    return [];
  }

  const POLLUTANTS = ['aqi', 'pm25', 'pm10', 'no2', 'o3', 'so2', 'co'];

  return wards.map(ward => {
    const { lat, lng } = ward.centroid;

    // Compute distances to all valid stations
    const withDist = validStations.map(s => ({
      ...s,
      dist: haversine(lat, lng, s.lat, s.lon)
    }));

    // Sort by distance and pick k nearest
    withDist.sort((a, b) => a.dist - b.dist);
    const nearest = withDist.slice(0, k);

    // Check if a station is essentially at the centroid (< 0.5 km)
    if (nearest[0].dist < 0.5) {
      const s = nearest[0];
      return {
        ward_name: ward.name,
        aqi:  Math.round(s.aqi || 0),
        pm25: round2(s.pm25),
        pm10: round2(s.pm10),
        no2:  round2(s.no2),
        o3:   round2(s.o3),
        so2:  round2(s.so2),
        co:   round2(s.co),
        dominant: s.dominant || determineDominant(s)
      };
    }

    // IDW: weighted average for each pollutant
    const result = { ward_name: ward.name };

    for (const p of POLLUTANTS) {
      let weightedSum = 0;
      let weightSum = 0;

      for (const s of nearest) {
        const val = s[p];
        if (val == null || isNaN(val)) continue;
        const w = 1 / (s.dist ** power);
        weightedSum += val * w;
        weightSum += w;
      }

      result[p] = weightSum > 0 ? Math.round(weightedSum / weightSum) : null;
    }

    result.dominant = determineDominant(result);
    return result;
  });
}

/* ---------- DETERMINE DOMINANT POLLUTANT ---------- */
function determineDominant(data) {
  const pollutants = [
    { name: 'PM2.5', value: data.pm25 || 0 },
    { name: 'PM10',  value: data.pm10 || 0 },
    { name: 'NO2',   value: data.no2  || 0 },
    { name: 'O3',    value: data.o3   || 0 },
    { name: 'SO2',   value: data.so2  || 0 },
    { name: 'CO',    value: data.co   || 0 }
  ];
  pollutants.sort((a, b) => b.value - a.value);
  return pollutants[0].name;
}

function round2(v) {
  return v != null && !isNaN(v) ? Math.round(v * 10) / 10 : null;
}

/* ---------- EXPORT ---------- */
module.exports = {
  interpolateWards,
  loadWardCentroids,
  haversine
};
