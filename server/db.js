/* ==========================================
   PrithviNet — SQLite Database Layer
   ==========================================
   Tables:
     -- Entity / Master Management --
     regional_offices    — Regional Office management
     industries          — Industry / Water Source registry
     monitoring_locations— Geo-tagged monitoring stations
     monitoring_units    — dB, ppm, °C, µg/m³ etc.
     prescribed_limits   — Threshold per parameter per type
     monitoring_teams    — Team assignments
     users               — Role-based users

     -- Monitoring Data --
     monitoring_data     — Unified air/water/noise readings
     forecasts           — Station-level forecast rows

     -- Compliance --
     compliance_alerts   — Auto-generated limit breaches
     escalations         — Escalation workflow

     -- Citizen / Reports --
     reports             — Citizen-submitted incident reports
     report_votes        — Community verification votes

     -- Legacy compat (kept for transition) --
     stations            — Station metadata (kept for interpolation)
     ward_aqi            — Ward-level aggregated data
     ward_aqi_history    — Trend tracking
     civic_events        — Compliance events
   ========================================== */

'use strict';

const Database = require('better-sqlite3');
const fs       = require('fs');
const path     = require('path');

const DB_PATH = path.join(__dirname, 'prithvinet.db');
let db;

const INDUSTRY_TYPES = ['steel', 'mining', 'power', 'cement', 'chemical'];
const INDUSTRY_CATEGORY = {
  steel: 'red',
  mining: 'red',
  power: 'red',
  cement: 'red',
  chemical: 'red'
};

function inferIndustryType(name, props, idx) {
  const text = `${(name || '').toLowerCase()} ${JSON.stringify(props || {}).toLowerCase()}`;
  if (/steel|sponge\s*iron|blast\s*furnace|bhilai/.test(text)) return 'steel';
  if (/mine|mining|quarry|coal|ore|bauxite|limestone/.test(text)) return 'mining';
  if (/power|thermal|generation|energy|boiler|plant/.test(text)) return 'power';
  if (/cement|clinker/.test(text)) return 'cement';
  if (/chemical|fertilizer|refinery|petro|distillery|solvent/.test(text)) return 'chemical';
  return INDUSTRY_TYPES[idx % INDUSTRY_TYPES.length];
}

function isGenericIndustryName(name) {
  return /^industrial zone\s+\d+$/i.test(String(name || '').trim());
}

function extractActualIndustryName(props) {
  const p = props || {};
  const candidates = [
    p.name,
    p['name:en'],
    p['name:hi'],
    p.operator,
    p.alt_name,
    p.brand,
    p.company,
    p.owner,
    p.ref
  ];

  for (const c of candidates) {
    if (!c) continue;
    const v = String(c).trim();
    if (!v) continue;
    if (/^(industrial|industry|plant|factory)$/i.test(v)) continue;
    return v;
  }
  return null;
}

function deriveIndustryName(props, idx, type) {
  const p = props || {};
  const direct = p.name || p['name:en'] || p['name:hi'] || p.alt_name || p.operator || p.brand || p.company || p.owner || p.ref;
  if (direct && String(direct).trim()) {
    return String(direct).trim();
  }
  return `Industrial Zone ${idx + 1}`;
}

function getPointFromGeometry(geometry) {
  if (!geometry || !geometry.type || !geometry.coordinates) return null;

  if (geometry.type === 'Point' && Array.isArray(geometry.coordinates) && geometry.coordinates.length >= 2) {
    return { lng: Number(geometry.coordinates[0]), lat: Number(geometry.coordinates[1]) };
  }

  if (geometry.type === 'MultiPoint' && Array.isArray(geometry.coordinates) && geometry.coordinates.length > 0) {
    const first = geometry.coordinates[0];
    if (Array.isArray(first) && first.length >= 2) {
      return { lng: Number(first[0]), lat: Number(first[1]) };
    }
  }

  let points = [];
  const walk = (node) => {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === 'number' && typeof node[1] === 'number') {
      points.push(node);
      return;
    }
    node.forEach(walk);
  };
  walk(geometry.coordinates);

  if (points.length === 0) return null;
  let sumLng = 0;
  let sumLat = 0;
  for (const p of points) {
    sumLng += Number(p[0]);
    sumLat += Number(p[1]);
  }
  return { lng: sumLng / points.length, lat: sumLat / points.length };
}

function getIndustriesGeoJsonPath() {
  const candidates = [
    path.join(__dirname, '..', 'chhattisgarh_industries.geojson'),
    path.join(__dirname, '..', '..', 'chhattisgarh_industries.geojson')
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}

function syncIndustriesFromGeoJSON() {
  const geoPath = getIndustriesGeoJsonPath();
  if (!geoPath) {
    throw new Error('chhattisgarh_industries.geojson not found in expected locations');
  }

  const geoRaw = fs.readFileSync(geoPath, 'utf-8');
  const geo = JSON.parse(geoRaw);
  const features = Array.isArray(geo.features) ? geo.features : [];

  const existing = db.prepare('SELECT id, name, lat, lon FROM industries').all();
  const existingByCoord = new Map(existing.map(e => [`${Number(e.lat).toFixed(6)}|${Number(e.lon).toFixed(6)}`, e]));
  const existingKeys = new Set(existing.map(e => `${String(e.name).trim().toLowerCase()}|${Number(e.lat).toFixed(6)}|${Number(e.lon).toFixed(6)}`));

  const insertStmt = db.prepare('INSERT INTO industries (name, type, category, regional_office_id, lat, lon, consent_status) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const updateNameStmt = db.prepare('UPDATE industries SET name = ?, type = ?, category = ?, updated_at = datetime(\'now\') WHERE id = ?');
  let inserted = 0;
  let updated = 0;
  let skippedNoGeometry = 0;

  features.forEach((f, idx) => {
    const props = f.properties || {};
    const point = getPointFromGeometry(f.geometry);
    if (!point || Number.isNaN(point.lat) || Number.isNaN(point.lng)) {
      skippedNoGeometry++;
      return;
    }

    const actualName = extractActualIndustryName(props);
    const type = inferIndustryType(actualName || '', props, idx);
    const name = actualName || deriveIndustryName(props, idx, type);
    const category = INDUSTRY_CATEGORY[type] || 'red';
    const key = `${name.toLowerCase()}|${Number(point.lat).toFixed(6)}|${Number(point.lng).toFixed(6)}`;

    const coordKey = `${Number(point.lat).toFixed(6)}|${Number(point.lng).toFixed(6)}`;
    const existingAtCoord = existingByCoord.get(coordKey);
    if (existingAtCoord) {
      const existingName = String(existingAtCoord.name || '').trim();
      const shouldUpgradeName = isGenericIndustryName(existingName) && !isGenericIndustryName(name);
      const shouldAlignType = String(existingName).toLowerCase() === String(name).toLowerCase() || shouldUpgradeName;

      if (shouldUpgradeName || shouldAlignType) {
        updateNameStmt.run(shouldUpgradeName ? name : existingName, type, category, existingAtCoord.id);
        if (shouldUpgradeName) {
          existingAtCoord.name = name;
        }
        updated++;
      }
      existingKeys.add(key);
      return;
    }

    if (existingKeys.has(key)) return;

    insertStmt.run(name, type, category, 1, point.lat, point.lng, 'active');
    existingKeys.add(key);
    inserted++;
  });

  return { inserted, updated, skippedNoGeometry, totalFeatures: features.length, geoPath };
}

/* ---------- INIT ---------- */
function init() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    /* ==============================================
       ENTITY / MASTER MANAGEMENT TABLES
       ============================================== */

    CREATE TABLE IF NOT EXISTS regional_offices (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      code        TEXT UNIQUE NOT NULL,
      state       TEXT NOT NULL DEFAULT 'Delhi',
      district    TEXT,
      address     TEXT,
      head_name   TEXT,
      head_contact TEXT,
      lat         REAL,
      lon         REAL,
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS industries (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT NOT NULL,
      type            TEXT NOT NULL DEFAULT 'manufacturing',
      category        TEXT NOT NULL DEFAULT 'red',
      regional_office_id INTEGER,
      address         TEXT,
      lat             REAL,
      lon             REAL,
      contact_person  TEXT,
      contact_phone   TEXT,
      consent_status  TEXT DEFAULT 'pending',
      consent_expiry  TEXT,
      created_at      TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (regional_office_id) REFERENCES regional_offices(id)
    );

    CREATE TABLE IF NOT EXISTS monitoring_locations (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT NOT NULL,
      code            TEXT UNIQUE,
      type            TEXT NOT NULL DEFAULT 'air',
      region          TEXT,
      regional_office_id INTEGER,
      industry_id     INTEGER,
      lat             REAL NOT NULL,
      lon             REAL NOT NULL,
      description     TEXT,
      is_active       INTEGER DEFAULT 1,
      created_at      TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (regional_office_id) REFERENCES regional_offices(id),
      FOREIGN KEY (industry_id) REFERENCES industries(id)
    );

    CREATE TABLE IF NOT EXISTS monitoring_units (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      parameter   TEXT NOT NULL,
      unit        TEXT NOT NULL,
      type        TEXT NOT NULL DEFAULT 'air',
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS prescribed_limits (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      parameter   TEXT NOT NULL,
      type        TEXT NOT NULL DEFAULT 'air',
      limit_min   REAL,
      limit_max   REAL,
      unit        TEXT,
      category    TEXT DEFAULT 'general',
      source      TEXT DEFAULT 'CPCB',
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS monitoring_teams (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT NOT NULL,
      regional_office_id INTEGER,
      leader_name     TEXT,
      leader_contact  TEXT,
      specialization  TEXT DEFAULT 'air',
      is_active       INTEGER DEFAULT 1,
      created_at      TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (regional_office_id) REFERENCES regional_offices(id)
    );

    CREATE TABLE IF NOT EXISTS users (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      username    TEXT UNIQUE NOT NULL,
      name        TEXT NOT NULL,
      role        TEXT NOT NULL DEFAULT 'citizen',
      email       TEXT,
      phone       TEXT,
      regional_office_id INTEGER,
      industry_id INTEGER,
      team_id     INTEGER,
      is_active   INTEGER DEFAULT 1,
      created_at  TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (regional_office_id) REFERENCES regional_offices(id),
      FOREIGN KEY (industry_id) REFERENCES industries(id),
      FOREIGN KEY (team_id) REFERENCES monitoring_teams(id)
    );

    /* ==============================================
       MONITORING DATA TABLES
       ============================================== */

    CREATE TABLE IF NOT EXISTS monitoring_data (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id     INTEGER,
      industry_id     INTEGER,
      type            TEXT NOT NULL DEFAULT 'air',
      -- Air parameters
      aqi             REAL,
      pm25            REAL,
      pm10            REAL,
      no2             REAL,
      o3              REAL,
      so2             REAL,
      co              REAL,
      -- Water parameters
      ph              REAL,
      dissolved_oxygen REAL,
      bod             REAL,
      cod             REAL,
      turbidity       REAL,
      conductivity    REAL,
      -- Noise parameters
      noise_level_db  REAL,
      noise_min_db    REAL,
      noise_max_db    REAL,
      -- Common
      temperature     REAL,
      humidity        REAL,
      wind_speed      REAL,
      pressure        REAL,
      dominant        TEXT,
      submitted_by    INTEGER,
      source          TEXT DEFAULT 'sensor',
      recorded_at     TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (location_id) REFERENCES monitoring_locations(id),
      FOREIGN KEY (industry_id) REFERENCES industries(id),
      FOREIGN KEY (submitted_by) REFERENCES users(id)
    );

    /* ==============================================
       COMPLIANCE TABLES
       ============================================== */

    CREATE TABLE IF NOT EXISTS compliance_alerts (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id     INTEGER,
      industry_id     INTEGER,
      type            TEXT NOT NULL DEFAULT 'air',
      parameter       TEXT NOT NULL,
      recorded_value  REAL NOT NULL,
      prescribed_limit REAL NOT NULL,
      severity        TEXT NOT NULL DEFAULT 'warning',
      status          TEXT NOT NULL DEFAULT 'open',
      message         TEXT,
      acknowledged_by INTEGER,
      acknowledged_at TEXT,
      resolved_at     TEXT,
      created_at      TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (location_id) REFERENCES monitoring_locations(id),
      FOREIGN KEY (industry_id) REFERENCES industries(id),
      FOREIGN KEY (acknowledged_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS escalations (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_id        INTEGER NOT NULL,
      from_role       TEXT NOT NULL,
      to_role         TEXT NOT NULL,
      note            TEXT,
      status          TEXT DEFAULT 'pending',
      created_at      TEXT DEFAULT (datetime('now')),
      resolved_at     TEXT,
      FOREIGN KEY (alert_id) REFERENCES compliance_alerts(id)
    );

    CREATE TABLE IF NOT EXISTS alert_timeline (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_id        INTEGER NOT NULL,
      event_type      TEXT NOT NULL,
      title           TEXT NOT NULL,
      detail          TEXT,
      actor_role      TEXT,
      actor_id        TEXT,
      metadata_json   TEXT,
      created_at      TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (alert_id) REFERENCES compliance_alerts(id)
    );

    CREATE TABLE IF NOT EXISTS missing_report_schedules (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type         TEXT NOT NULL DEFAULT 'monitoring_location',
      entity_id           INTEGER NOT NULL,
      type                TEXT NOT NULL,
      frequency_minutes   INTEGER NOT NULL DEFAULT 60,
      grace_minutes       INTEGER NOT NULL DEFAULT 30,
      escalation_minutes  INTEGER NOT NULL DEFAULT 120,
      is_active           INTEGER NOT NULL DEFAULT 1,
      last_submission_at  TEXT,
      last_due_at         TEXT,
      last_checked_at     TEXT,
      created_at          TEXT DEFAULT (datetime('now')),
      updated_at          TEXT DEFAULT (datetime('now')),
      UNIQUE(entity_type, entity_id, type)
    );

    CREATE TABLE IF NOT EXISTS missing_report_events (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_id         INTEGER NOT NULL,
      entity_type         TEXT NOT NULL,
      entity_id           INTEGER NOT NULL,
      type                TEXT NOT NULL,
      status              TEXT NOT NULL DEFAULT 'new',
      severity            TEXT NOT NULL DEFAULT 'warning',
      reminder_level      TEXT NOT NULL DEFAULT 't_plus_0',
      message             TEXT,
      due_at              TEXT,
      escalation_due_at   TEXT,
      detected_at         TEXT DEFAULT (datetime('now')),
      acknowledged_at     TEXT,
      resolved_at         TEXT,
      metadata_json       TEXT,
      FOREIGN KEY (schedule_id) REFERENCES missing_report_schedules(id)
    );

    /* ==============================================
       LEGACY / COMPATIBLE TABLES (kept for transition)
       ============================================== */

    CREATE TABLE IF NOT EXISTS stations (
      uid       INTEGER PRIMARY KEY,
      name      TEXT NOT NULL,
      lat       REAL NOT NULL,
      lon       REAL NOT NULL,
      url       TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS readings (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      station_uid INTEGER NOT NULL,
      aqi         INTEGER,
      pm25        REAL,
      pm10        REAL,
      no2         REAL,
      o3          REAL,
      so2         REAL,
      co          REAL,
      temp        REAL,
      humidity    REAL,
      wind        REAL,
      pressure    REAL,
      dominant    TEXT,
      fetched_at  TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (station_uid) REFERENCES stations(uid)
    );

    CREATE TABLE IF NOT EXISTS forecasts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      station_uid INTEGER NOT NULL,
      day         TEXT NOT NULL,
      pollutant   TEXT NOT NULL,
      avg         REAL,
      min         REAL,
      max         REAL,
      fetched_at  TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (station_uid) REFERENCES stations(uid)
    );

    CREATE TABLE IF NOT EXISTS ward_aqi (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ward_name   TEXT NOT NULL,
      aqi         REAL,
      pm25        REAL,
      pm10        REAL,
      no2         REAL,
      o3          REAL,
      so2         REAL,
      co          REAL,
      dominant    TEXT,
      computed_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ward_aqi_history (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ward_name  TEXT NOT NULL,
      aqi        REAL,
      cycle_at   TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS civic_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ward_name  TEXT NOT NULL,
      event_type TEXT NOT NULL DEFAULT 'pollution_event',
      severity   TEXT NOT NULL DEFAULT 'warning',
      details    TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT
    );

    /* ==============================================
       CITIZEN REPORTS (kept from original)
       ============================================== */

    CREATE TABLE IF NOT EXISTS reports (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      lat         REAL NOT NULL,
      lng         REAL NOT NULL,
      category    TEXT NOT NULL,
      description TEXT,
      media       TEXT,
      created_at  TEXT DEFAULT (datetime('now')),
      voter_uid   TEXT
    );

    CREATE TABLE IF NOT EXISTS report_votes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id   INTEGER NOT NULL,
      vote        TEXT NOT NULL CHECK(vote IN ('confirmed','false','unsure')),
      voter_uid   TEXT NOT NULL,
      lat         REAL,
      lng         REAL,
      voted_at    TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (report_id) REFERENCES reports(id),
      UNIQUE(report_id, voter_uid)
    );

    CREATE TABLE IF NOT EXISTS report_workflow (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id       INTEGER NOT NULL UNIQUE,
      status          TEXT NOT NULL DEFAULT 'new',
      priority        TEXT NOT NULL DEFAULT 'normal',
      assigned_team_id INTEGER,
      note            TEXT,
      updated_by      TEXT,
      updated_by_role TEXT,
      updated_at      TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (report_id) REFERENCES reports(id)
    );

    /* ==============================================
       INDEXES
       ============================================== */
    CREATE INDEX IF NOT EXISTS idx_readings_station     ON readings(station_uid, fetched_at);
    CREATE INDEX IF NOT EXISTS idx_forecasts_station    ON forecasts(station_uid, fetched_at);
    CREATE INDEX IF NOT EXISTS idx_ward_aqi_time        ON ward_aqi(computed_at);
    CREATE INDEX IF NOT EXISTS idx_ward_aqi_name        ON ward_aqi(ward_name, computed_at);
    CREATE INDEX IF NOT EXISTS idx_aqi_hist_ward        ON ward_aqi_history(ward_name, cycle_at DESC);
    CREATE INDEX IF NOT EXISTS idx_civic_events_ward    ON civic_events(ward_name, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_reports_created      ON reports(created_at);
    CREATE INDEX IF NOT EXISTS idx_reports_category     ON reports(category);
    CREATE INDEX IF NOT EXISTS idx_report_votes_rid     ON report_votes(report_id);
    CREATE INDEX IF NOT EXISTS idx_report_workflow_report ON report_workflow(report_id);

    -- New PrithviNet indexes
    CREATE INDEX IF NOT EXISTS idx_monitoring_data_loc  ON monitoring_data(location_id, recorded_at);
    CREATE INDEX IF NOT EXISTS idx_monitoring_data_type ON monitoring_data(type, recorded_at);
    CREATE INDEX IF NOT EXISTS idx_monitoring_data_ind  ON monitoring_data(industry_id, recorded_at);
    CREATE INDEX IF NOT EXISTS idx_compliance_alerts_st ON compliance_alerts(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_compliance_alerts_loc ON compliance_alerts(location_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_industries_ro        ON industries(regional_office_id);
    CREATE INDEX IF NOT EXISTS idx_mon_loc_ro           ON monitoring_locations(regional_office_id);
    CREATE INDEX IF NOT EXISTS idx_mon_loc_type         ON monitoring_locations(type);
    CREATE INDEX IF NOT EXISTS idx_users_role           ON users(role);
    CREATE INDEX IF NOT EXISTS idx_alert_timeline_alert ON alert_timeline(alert_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_missing_schedule_key ON missing_report_schedules(entity_type, entity_id, type, is_active);
    CREATE INDEX IF NOT EXISTS idx_missing_events_state ON missing_report_events(status, detected_at DESC);
  `);

  ensureColumn('compliance_alerts', 'assigned_to', 'TEXT');
  ensureColumn('compliance_alerts', 'assigned_role', 'TEXT');
  ensureColumn('compliance_alerts', 'source', "TEXT DEFAULT 'limit_breach'");
  ensureColumn('compliance_alerts', 'first_triggered_at', 'TEXT');
  ensureColumn('compliance_alerts', 'last_triggered_at', 'TEXT');
  ensureColumn('compliance_alerts', 'cooldown_until', 'TEXT');
  ensureColumn('compliance_alerts', 'occurrence_count', 'INTEGER DEFAULT 1');
  ensureColumn('compliance_alerts', 'exceedance_ratio', 'REAL DEFAULT 1');
  ensureColumn('compliance_alerts', 'severity_score', 'REAL DEFAULT 0');
  ensureColumn('compliance_alerts', 'auto_close_at', 'TEXT');
  ensureColumn('compliance_alerts', 'closed_at', 'TEXT');

  return db;
}

function ensureColumn(tableName, columnName, definition) {
  const cols = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (!cols.some(c => c.name === columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

/* ==============================================
   ENTITY MANAGEMENT — CRUD FUNCTIONS
   ============================================== */

/* ---------- REGIONAL OFFICES ---------- */
function getAllRegionalOffices() {
  return db.prepare('SELECT * FROM regional_offices ORDER BY name').all();
}
function getRegionalOffice(id) {
  return db.prepare('SELECT * FROM regional_offices WHERE id = ?').get(id);
}
function createRegionalOffice(data) {
  const stmt = db.prepare(`INSERT INTO regional_offices (name, code, state, district, address, head_name, head_contact, lat, lon) VALUES (@name, @code, @state, @district, @address, @head_name, @head_contact, @lat, @lon)`);
  return stmt.run(data);
}
function updateRegionalOffice(id, data) {
  const stmt = db.prepare(`UPDATE regional_offices SET name=@name, code=@code, state=@state, district=@district, address=@address, head_name=@head_name, head_contact=@head_contact, lat=@lat, lon=@lon, updated_at=datetime('now') WHERE id=@id`);
  return stmt.run({ ...data, id });
}
function deleteRegionalOffice(id) {
  return db.prepare('DELETE FROM regional_offices WHERE id = ?').run(id);
}

/* ---------- INDUSTRIES ---------- */
function getAllIndustries() {
  return db.prepare(`SELECT i.*, ro.name as ro_name FROM industries i LEFT JOIN regional_offices ro ON ro.id = i.regional_office_id ORDER BY i.name`).all();
}
function getIndustry(id) {
  return db.prepare('SELECT * FROM industries WHERE id = ?').get(id);
}
function createIndustry(data) {
  const stmt = db.prepare(`INSERT INTO industries (name, type, category, regional_office_id, address, lat, lon, contact_person, contact_phone, consent_status, consent_expiry) VALUES (@name, @type, @category, @regional_office_id, @address, @lat, @lon, @contact_person, @contact_phone, @consent_status, @consent_expiry)`);
  return stmt.run(data);
}
function updateIndustry(id, data) {
  const stmt = db.prepare(`UPDATE industries SET name=@name, type=@type, category=@category, regional_office_id=@regional_office_id, address=@address, lat=@lat, lon=@lon, contact_person=@contact_person, contact_phone=@contact_phone, consent_status=@consent_status, consent_expiry=@consent_expiry, updated_at=datetime('now') WHERE id=@id`);
  return stmt.run({ ...data, id });
}
function deleteIndustry(id) {
  return db.prepare('DELETE FROM industries WHERE id = ?').run(id);
}

/* ---------- MONITORING LOCATIONS ---------- */
function getAllMonitoringLocations(type) {
  if (type) {
    return db.prepare(`SELECT ml.*, ro.name as ro_name, i.name as industry_name FROM monitoring_locations ml LEFT JOIN regional_offices ro ON ro.id = ml.regional_office_id LEFT JOIN industries i ON i.id = ml.industry_id WHERE ml.type = ? AND ml.is_active = 1 ORDER BY ml.name`).all(type);
  }
  return db.prepare(`SELECT ml.*, ro.name as ro_name, i.name as industry_name FROM monitoring_locations ml LEFT JOIN regional_offices ro ON ro.id = ml.regional_office_id LEFT JOIN industries i ON i.id = ml.industry_id WHERE ml.is_active = 1 ORDER BY ml.name`).all();
}
function getMonitoringLocation(id) {
  return db.prepare('SELECT * FROM monitoring_locations WHERE id = ?').get(id);
}
function createMonitoringLocation(data) {
  const stmt = db.prepare(`INSERT INTO monitoring_locations (name, code, type, region, regional_office_id, industry_id, lat, lon, description) VALUES (@name, @code, @type, @region, @regional_office_id, @industry_id, @lat, @lon, @description)`);
  return stmt.run(data);
}
function updateMonitoringLocation(id, data) {
  const stmt = db.prepare(`UPDATE monitoring_locations SET name=@name, code=@code, type=@type, region=@region, regional_office_id=@regional_office_id, industry_id=@industry_id, lat=@lat, lon=@lon, description=@description WHERE id=@id`);
  return stmt.run({ ...data, id });
}
function deleteMonitoringLocation(id) {
  return db.prepare('DELETE FROM monitoring_locations WHERE id = ?').run(id);
}

/* ---------- MONITORING UNITS ---------- */
function getAllMonitoringUnits() {
  return db.prepare('SELECT * FROM monitoring_units ORDER BY type, parameter').all();
}
function createMonitoringUnit(data) {
  const stmt = db.prepare(`INSERT INTO monitoring_units (parameter, unit, type, description) VALUES (@parameter, @unit, @type, @description)`);
  return stmt.run(data);
}

/* ---------- PRESCRIBED LIMITS ---------- */
function getAllPrescribedLimits(type) {
  if (type) {
    return db.prepare('SELECT * FROM prescribed_limits WHERE type = ? ORDER BY parameter').all(type);
  }
  return db.prepare('SELECT * FROM prescribed_limits ORDER BY type, parameter').all();
}
function createPrescribedLimit(data) {
  const stmt = db.prepare(`INSERT INTO prescribed_limits (parameter, type, limit_min, limit_max, unit, category, source) VALUES (@parameter, @type, @limit_min, @limit_max, @unit, @category, @source)`);
  return stmt.run(data);
}

/* ---------- MONITORING TEAMS ---------- */
function getAllMonitoringTeams() {
  return db.prepare(`SELECT mt.*, ro.name as ro_name FROM monitoring_teams mt LEFT JOIN regional_offices ro ON ro.id = mt.regional_office_id WHERE mt.is_active = 1 ORDER BY mt.name`).all();
}
function createMonitoringTeam(data) {
  const stmt = db.prepare(`INSERT INTO monitoring_teams (name, regional_office_id, leader_name, leader_contact, specialization) VALUES (@name, @regional_office_id, @leader_name, @leader_contact, @specialization)`);
  return stmt.run(data);
}

/* ---------- USERS ---------- */
function getAllUsers() {
  return db.prepare('SELECT id, username, name, role, email, phone, regional_office_id, industry_id, team_id, is_active, created_at FROM users ORDER BY role, name').all();
}
function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}
function createUser(data) {
  const stmt = db.prepare(`INSERT INTO users (username, name, role, email, phone, regional_office_id, industry_id, team_id) VALUES (@username, @name, @role, @email, @phone, @regional_office_id, @industry_id, @team_id)`);
  return stmt.run(data);
}

/* ==============================================
   MONITORING DATA — MULTI-PARAMETER
   ============================================== */

function saveMonitoringData(data) {
  const stmt = db.prepare(`
    INSERT INTO monitoring_data (location_id, industry_id, type, aqi, pm25, pm10, no2, o3, so2, co,
      ph, dissolved_oxygen, bod, cod, turbidity, conductivity,
      noise_level_db, noise_min_db, noise_max_db,
      temperature, humidity, wind_speed, pressure, dominant, submitted_by, source)
    VALUES (@location_id, @industry_id, @type, @aqi, @pm25, @pm10, @no2, @o3, @so2, @co,
      @ph, @dissolved_oxygen, @bod, @cod, @turbidity, @conductivity,
      @noise_level_db, @noise_min_db, @noise_max_db,
      @temperature, @humidity, @wind_speed, @pressure, @dominant, @submitted_by, @source)
  `);
  return stmt.run(data);
}

function saveMonitoringDataBatch(dataList) {
  const stmt = db.prepare(`
    INSERT INTO monitoring_data (location_id, industry_id, type, aqi, pm25, pm10, no2, o3, so2, co,
      ph, dissolved_oxygen, bod, cod, turbidity, conductivity,
      noise_level_db, noise_min_db, noise_max_db,
      temperature, humidity, wind_speed, pressure, dominant, submitted_by, source)
    VALUES (@location_id, @industry_id, @type, @aqi, @pm25, @pm10, @no2, @o3, @so2, @co,
      @ph, @dissolved_oxygen, @bod, @cod, @turbidity, @conductivity,
      @noise_level_db, @noise_min_db, @noise_max_db,
      @temperature, @humidity, @wind_speed, @pressure, @dominant, @submitted_by, @source)
  `);
  const tx = db.transaction((list) => { for (const d of list) stmt.run(d); });
  tx(dataList);
}

function getLatestMonitoringData(type, locationId) {
  if (locationId) {
    return db.prepare(`SELECT * FROM monitoring_data WHERE type = ? AND location_id = ? ORDER BY recorded_at DESC LIMIT 1`).get(type, locationId);
  }
  // Latest per location for a given type
  return db.prepare(`
    SELECT md.*, ml.name as location_name, ml.lat, ml.lon, ml.region
    FROM monitoring_data md
    JOIN monitoring_locations ml ON ml.id = md.location_id
    WHERE md.type = ? AND md.id IN (
      SELECT MAX(id) FROM monitoring_data WHERE type = ? GROUP BY location_id
    )
    ORDER BY ml.name
  `).all(type, type);
}

function getMonitoringHistory(locationId, type, days = 7) {
  return db.prepare(`
    SELECT * FROM monitoring_data
    WHERE location_id = ? AND type = ? AND recorded_at >= datetime('now', '-' || ? || ' days')
    ORDER BY recorded_at
  `).all(locationId, type, days);
}

/* ==============================================
   COMPLIANCE FUNCTIONS
   ============================================== */

function createComplianceAlert(data) {
  const stmt = db.prepare(`
    INSERT INTO compliance_alerts (
      location_id, industry_id, type, parameter,
      recorded_value, prescribed_limit, severity, status, message,
      source, first_triggered_at, last_triggered_at, cooldown_until,
      occurrence_count, exceedance_ratio, severity_score, auto_close_at
    )
    VALUES (
      @location_id, @industry_id, @type, @parameter,
      @recorded_value, @prescribed_limit, @severity, @status, @message,
      @source, @first_triggered_at, @last_triggered_at, @cooldown_until,
      @occurrence_count, @exceedance_ratio, @severity_score, @auto_close_at
    )
  `);
  const payload = {
    status: 'new',
    source: 'limit_breach',
    first_triggered_at: null,
    last_triggered_at: null,
    cooldown_until: null,
    occurrence_count: 1,
    exceedance_ratio: 1,
    severity_score: 0,
    auto_close_at: null,
    ...data
  };
  const info = stmt.run(payload);
  logAlertTimeline({
    alert_id: info.lastInsertRowid,
    event_type: 'created',
    title: 'Alert created',
    detail: payload.message || 'Compliance alert generated from monitoring data',
    actor_role: 'system',
    actor_id: 'compliance_engine',
    metadata: {
      severity: payload.severity,
      parameter: payload.parameter,
      ratio: payload.exceedance_ratio,
      source: payload.source
    }
  });
  return info;
}

function getLatestOpenAlertForKey(locationId, type, parameter) {
  return db.prepare(`
    SELECT * FROM compliance_alerts
    WHERE location_id = ?
      AND type = ?
      AND parameter = ?
      AND status IN ('open', 'new', 'acknowledged', 'in_action', 'escalated')
    ORDER BY id DESC
    LIMIT 1
  `).get(locationId, type, parameter);
}

function bumpAlertOccurrence(id, data) {
  return db.prepare(`
    UPDATE compliance_alerts
    SET recorded_value = @recorded_value,
        prescribed_limit = @prescribed_limit,
        severity = @severity,
        message = @message,
        last_triggered_at = @last_triggered_at,
        cooldown_until = @cooldown_until,
        occurrence_count = COALESCE(occurrence_count, 1) + 1,
        exceedance_ratio = @exceedance_ratio,
        severity_score = @severity_score,
        auto_close_at = @auto_close_at
    WHERE id = @id
  `).run({ id, ...data });
}

function getComplianceAlerts(status, type) {
  let sql = 'SELECT ca.*, ml.name as location_name, i.name as industry_name FROM compliance_alerts ca LEFT JOIN monitoring_locations ml ON ml.id = ca.location_id LEFT JOIN industries i ON i.id = ca.industry_id WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND ca.status = ?'; params.push(status); }
  if (type) { sql += ' AND ca.type = ?'; params.push(type); }
  sql += ' ORDER BY ca.created_at DESC';
  return db.prepare(sql).all(...params);
}

function updateAlertStatus(id, status, userId) {
  if (status === 'acknowledged') {
    const result = db.prepare(`UPDATE compliance_alerts SET status = ?, acknowledged_by = ?, acknowledged_at = datetime('now') WHERE id = ?`).run(status, userId, id);
    logAlertTimeline({
      alert_id: id,
      event_type: 'status_change',
      title: 'Alert acknowledged',
      detail: 'Alert was acknowledged for triage',
      actor_role: 'user',
      actor_id: String(userId || '')
    });
    return result;
  }
  if (status === 'resolved') {
    const result = db.prepare(`UPDATE compliance_alerts SET status = ?, resolved_at = datetime('now'), closed_at = datetime('now') WHERE id = ?`).run(status, id);
    logAlertTimeline({
      alert_id: id,
      event_type: 'status_change',
      title: 'Alert resolved',
      detail: 'Alert resolved and closed by operator',
      actor_role: 'user',
      actor_id: String(userId || '')
    });
    return result;
  }
  if (status === 'in_action') {
    const result = db.prepare(`UPDATE compliance_alerts SET status = ? WHERE id = ?`).run(status, id);
    logAlertTimeline({
      alert_id: id,
      event_type: 'status_change',
      title: 'Mitigation action started',
      detail: 'Alert moved to in-action state',
      actor_role: 'user',
      actor_id: String(userId || '')
    });
    return result;
  }
  if (status === 'auto_closed') {
    const result = db.prepare(`UPDATE compliance_alerts SET status = ?, closed_at = datetime('now') WHERE id = ?`).run(status, id);
    logAlertTimeline({
      alert_id: id,
      event_type: 'auto_close',
      title: 'Alert auto-closed',
      detail: 'No further breaches observed within monitoring window',
      actor_role: 'system',
      actor_id: 'compliance_engine'
    });
    return result;
  }

  const result = db.prepare(`UPDATE compliance_alerts SET status = ? WHERE id = ?`).run(status, id);
  logAlertTimeline({
    alert_id: id,
    event_type: 'status_change',
    title: `Status changed to ${status}`,
    detail: `Alert moved to ${status}`,
    actor_role: 'user',
    actor_id: String(userId || '')
  });
  return result;
}

function assignAlert(id, assignedTo, assignedRole, actorRole, actorId) {
  const result = db.prepare(`
    UPDATE compliance_alerts
    SET assigned_to = ?, assigned_role = ?, status = CASE WHEN status = 'new' THEN 'in_action' ELSE status END
    WHERE id = ?
  `).run(assignedTo || null, assignedRole || null, id);

  logAlertTimeline({
    alert_id: id,
    event_type: 'assignment',
    title: 'Alert assigned',
    detail: assignedTo ? `Assigned to ${assignedTo}${assignedRole ? ` (${assignedRole})` : ''}` : 'Assignment cleared',
    actor_role: actorRole || 'user',
    actor_id: String(actorId || '')
  });

  return result;
}

function createEscalation(data) {
  const stmt = db.prepare(`INSERT INTO escalations (alert_id, from_role, to_role, note) VALUES (@alert_id, @from_role, @to_role, @note)`);
  const info = stmt.run(data);
  logAlertTimeline({
    alert_id: data.alert_id,
    event_type: 'escalation',
    title: `Escalated to ${data.to_role}`,
    detail: data.note || 'Escalated as per SLA matrix',
    actor_role: data.from_role || 'system',
    actor_id: data.from_role || 'system',
    metadata: { escalation_id: info.lastInsertRowid }
  });
  return info;
}

function getEscalations(alertId) {
  return db.prepare('SELECT * FROM escalations WHERE alert_id = ? ORDER BY created_at DESC').all(alertId);
}

function logAlertTimeline({ alert_id, event_type, title, detail, actor_role, actor_id, metadata }) {
  return db.prepare(`
    INSERT INTO alert_timeline (alert_id, event_type, title, detail, actor_role, actor_id, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    alert_id,
    event_type,
    title,
    detail || null,
    actor_role || null,
    actor_id || null,
    metadata ? JSON.stringify(metadata) : null
  );
}

function getAlertTimeline(alertId) {
  return db.prepare('SELECT * FROM alert_timeline WHERE alert_id = ? ORDER BY created_at DESC, id DESC').all(alertId);
}

function upsertMissingReportSchedule(data) {
  return db.prepare(`
    INSERT INTO missing_report_schedules (entity_type, entity_id, type, frequency_minutes, grace_minutes, escalation_minutes, is_active, updated_at)
    VALUES (@entity_type, @entity_id, @type, @frequency_minutes, @grace_minutes, @escalation_minutes, @is_active, datetime('now'))
    ON CONFLICT(entity_type, entity_id, type) DO UPDATE SET
      frequency_minutes = excluded.frequency_minutes,
      grace_minutes = excluded.grace_minutes,
      escalation_minutes = excluded.escalation_minutes,
      is_active = excluded.is_active,
      updated_at = datetime('now')
  `).run({
    entity_type: 'monitoring_location',
    frequency_minutes: 60,
    grace_minutes: 30,
    escalation_minutes: 120,
    is_active: 1,
    ...data
  });
}

function listMissingReportSchedules() {
  return db.prepare(`
    SELECT mrs.*, ml.name as location_name, ml.region, ml.regional_office_id
    FROM missing_report_schedules mrs
    LEFT JOIN monitoring_locations ml
      ON mrs.entity_type = 'monitoring_location' AND ml.id = mrs.entity_id
    WHERE mrs.is_active = 1
    ORDER BY ml.name, mrs.type
  `).all();
}

function listMissingReportEvents(status) {
  let sql = `
    SELECT mre.*, mrs.frequency_minutes, mrs.grace_minutes, mrs.escalation_minutes,
           ml.name as location_name, ml.region, ml.regional_office_id, ml.industry_id
    FROM missing_report_events mre
    JOIN missing_report_schedules mrs ON mrs.id = mre.schedule_id
    LEFT JOIN monitoring_locations ml
      ON mre.entity_type = 'monitoring_location' AND ml.id = mre.entity_id
    WHERE 1 = 1
  `;
  const params = [];
  if (status) {
    sql += ' AND mre.status = ?';
    params.push(status);
  }
  sql += ' ORDER BY mre.detected_at DESC, mre.id DESC';
  return db.prepare(sql).all(...params);
}

function getOpenMissingEventBySchedule(scheduleId) {
  return db.prepare(`
    SELECT * FROM missing_report_events
    WHERE schedule_id = ? AND status IN ('new', 'escalation_candidate')
    ORDER BY id DESC
    LIMIT 1
  `).get(scheduleId);
}

function createMissingReportEvent(data) {
  return db.prepare(`
    INSERT INTO missing_report_events (
      schedule_id, entity_type, entity_id, type, status, severity,
      reminder_level, message, due_at, escalation_due_at, metadata_json
    ) VALUES (
      @schedule_id, @entity_type, @entity_id, @type, @status, @severity,
      @reminder_level, @message, @due_at, @escalation_due_at, @metadata_json
    )
  `).run({
    status: 'new',
    severity: 'warning',
    reminder_level: 't_plus_0',
    metadata_json: null,
    ...data
  });
}

function updateMissingReportEvent(id, patch) {
  return db.prepare(`
    UPDATE missing_report_events
    SET status = COALESCE(@status, status),
        severity = COALESCE(@severity, severity),
        reminder_level = COALESCE(@reminder_level, reminder_level),
        message = COALESCE(@message, message),
        acknowledged_at = CASE WHEN @status = 'acknowledged' THEN datetime('now') ELSE acknowledged_at END,
        resolved_at = CASE WHEN @status = 'resolved' THEN datetime('now') ELSE resolved_at END,
        metadata_json = COALESCE(@metadata_json, metadata_json)
    WHERE id = @id
  `).run({
    id,
    metadata_json: patch.metadata ? JSON.stringify(patch.metadata) : null,
    ...patch
  });
}

function touchScheduleHeartbeat(id, lastSubmissionAt, dueAt) {
  return db.prepare(`
    UPDATE missing_report_schedules
    SET last_submission_at = ?,
        last_due_at = ?,
        last_checked_at = datetime('now'),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(lastSubmissionAt || null, dueAt || null, id);
}

function bootstrapMissingReportSchedules() {
  const locations = db.prepare('SELECT id, type FROM monitoring_locations WHERE is_active = 1').all();
  const tx = db.transaction((rows) => {
    rows.forEach(loc => {
      upsertMissingReportSchedule({
        entity_type: 'monitoring_location',
        entity_id: loc.id,
        type: loc.type,
        frequency_minutes: 60,
        grace_minutes: 30,
        escalation_minutes: 120,
        is_active: 1
      });
    });
  });
  tx(locations);
}

/* ==============================================
   SEED DATA — Demo entities for hackathon
   ============================================== */

function seedDemoData() {
  const hasData = db.prepare('SELECT COUNT(*) as cnt FROM regional_offices').get();
  if (hasData.cnt > 0) {
    // Existing DB: keep seeded data but continuously sync new GeoJSON industries.
    try {
      const sync = syncIndustriesFromGeoJSON();
      if (sync.inserted > 0 || sync.renamed > 0 || sync.deletedSynthetic > 0) {
        console.log(`[DB] Synced industries from ${sync.geoPath}: +${sync.inserted} inserted, ${sync.renamed} renamed, ${sync.deletedSynthetic} synthetic removed, ${sync.skippedUnnamed} unnamed skipped`);
      }
    } catch (err) {
      console.warn('[DB] Industry sync skipped:', err.message);
    }
    bootstrapMissingReportSchedules();
    return;
  }

  console.log('[DB] Seeding demo data...');

  // Regional Offices
  const roStmt = db.prepare(`INSERT INTO regional_offices (name, code, state, district, lat, lon, head_name) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  roStmt.run('Bhilai RO', 'RO-CG-BHI', 'Chhattisgarh', 'Durg', 21.19, 81.38, 'Dr. Amit Sharma');
  roStmt.run('Delhi South Regional Office', 'RO-DL-S', 'Delhi', 'South Delhi', 28.5245, 77.2066, 'Ms. Priya Singh');
  roStmt.run('Noida Regional Office', 'RO-UP-NOI', 'Uttar Pradesh', 'Gautam Buddh Nagar', 28.5355, 77.3910, 'Mr. Rajesh Kumar');
  roStmt.run('Gurugram Regional Office', 'RO-HR-GGN', 'Haryana', 'Gurugram', 28.4595, 77.0266, 'Dr. Sunita Rao');
  roStmt.run('Faridabad Regional Office', 'RO-HR-FBD', 'Haryana', 'Faridabad', 28.4089, 77.3178, 'Mr. Vikram Patel');

  // Industries (GeoJSON-driven)
  const indStmt = db.prepare(`INSERT INTO industries (name, type, category, regional_office_id, lat, lon, consent_status) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const insertedIndustryIds = [];

  try {
    const sync = syncIndustriesFromGeoJSON();
    console.log(`[DB] Seeded industries from ${sync.geoPath}; inserted ${sync.inserted}, renamed ${sync.renamed}, removed ${sync.deletedSynthetic}, skipped unnamed ${sync.skippedUnnamed}, parsed ${sync.totalFeatures}`);

    const ids = db.prepare('SELECT id FROM industries ORDER BY id').all();
    ids.forEach(r => insertedIndustryIds.push(r.id));
  } catch (err) {
    console.warn('[DB] GeoJSON seed failed, using fallback industries:', err.message);
    const fallback = [
      ['Bhilai Steel Plant - Sector 6', 'steel', 'red', 1, 21.195, 81.387, 'active'],
      ['Korba Coal Mine Cluster', 'mining', 'red', 1, 22.359, 82.750, 'active'],
      ['Korba Thermal Power Unit', 'power', 'red', 1, 22.360, 82.690, 'active'],
      ['Baloda Cement Works', 'cement', 'red', 1, 21.750, 82.160, 'active'],
      ['Raipur Chemical Processing', 'chemical', 'red', 1, 21.260, 81.640, 'active']
    ];
    fallback.forEach(row => {
      const info = indStmt.run(...row);
      insertedIndustryIds.push(info.lastInsertRowid);
    });
  }

  const primaryIndustryId = insertedIndustryIds[0] || null;

  // Monitoring Locations — Air
  const mlStmt = db.prepare(`INSERT INTO monitoring_locations (name, code, type, region, regional_office_id, industry_id, lat, lon) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  mlStmt.run('Bhilai Steel Plant (Industrial Zone)', 'AIR-BSP-01', 'air', 'Industrial Zone', 1, primaryIndustryId, 21.195, 81.387);
  mlStmt.run('Bhilai Township (Residential)', 'AIR-BT-01', 'air', 'Residential Zone', 2, null, 21.210, 81.335);
  mlStmt.run(' दुर्ग City Center', 'AIR-DURG-01', 'air', 'Commercial Zone', 3, null, 21.185, 81.280);

  // Monitoring Locations — Water
  mlStmt.run('Maroda Reservoir (Water Body)', 'WAT-MR-01', 'water', 'Water Body', 1, null, 21.170, 81.345);
  mlStmt.run('Shivnath River (Durg)', 'WAT-SR-01', 'water', 'River', 2, null, 21.160, 81.270);

  // Monitoring Locations — Noise
  mlStmt.run('Bhilai Steel Plant Noise Monitor', 'NOI-BSP-01', 'noise', 'Industrial Zone', 1, primaryIndustryId, 21.192, 81.385);
  mlStmt.run('Bhilai Township Noise Monitor', 'NOI-BT-01', 'noise', 'Residential Zone', 2, null, 21.215, 81.332);

  // Monitoring Units
  const muStmt = db.prepare(`INSERT INTO monitoring_units (parameter, unit, type, description) VALUES (?, ?, ?, ?)`);
  muStmt.run('PM2.5', 'µg/m³', 'air', 'Fine particulate matter');
  muStmt.run('PM10', 'µg/m³', 'air', 'Coarse particulate matter');
  muStmt.run('NO2', 'ppb', 'air', 'Nitrogen dioxide');
  muStmt.run('SO2', 'ppb', 'air', 'Sulphur dioxide');
  muStmt.run('CO', 'mg/m³', 'air', 'Carbon monoxide');
  muStmt.run('O3', 'ppb', 'air', 'Ozone');
  muStmt.run('pH', '-', 'water', 'Hydrogen ion concentration');
  muStmt.run('DO', 'mg/L', 'water', 'Dissolved oxygen');
  muStmt.run('BOD', 'mg/L', 'water', 'Biochemical oxygen demand');
  muStmt.run('COD', 'mg/L', 'water', 'Chemical oxygen demand');
  muStmt.run('Turbidity', 'NTU', 'water', 'Water clarity');
  muStmt.run('Noise Level', 'dB(A)', 'noise', 'Equivalent continuous sound level');

  // Prescribed Limits (CPCB standards)
  const plStmt = db.prepare(`INSERT INTO prescribed_limits (parameter, type, limit_min, limit_max, unit, category, source) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  // Air — NAAQS
  plStmt.run('PM2.5', 'air', null, 60, 'µg/m³', 'residential', 'NAAQS');
  plStmt.run('PM10', 'air', null, 100, 'µg/m³', 'residential', 'NAAQS');
  plStmt.run('NO2', 'air', null, 80, 'ppb', 'residential', 'NAAQS');
  plStmt.run('SO2', 'air', null, 80, 'ppb', 'residential', 'NAAQS');
  plStmt.run('CO', 'air', null, 4, 'mg/m³', 'residential', 'NAAQS');
  plStmt.run('O3', 'air', null, 100, 'ppb', 'residential', 'NAAQS');
  plStmt.run('AQI', 'air', null, 200, '-', 'general', 'CPCB');
  // Water — IS:2296
  plStmt.run('pH', 'water', 6.5, 8.5, '-', 'general', 'CPCB');
  plStmt.run('DO', 'water', 5, null, 'mg/L', 'general', 'CPCB');
  plStmt.run('BOD', 'water', null, 3, 'mg/L', 'general', 'CPCB');
  plStmt.run('COD', 'water', null, 250, 'mg/L', 'general', 'CPCB');
  plStmt.run('Turbidity', 'water', null, 10, 'NTU', 'general', 'CPCB');
  // Noise — CPCB
  plStmt.run('Noise Level', 'noise', null, 75, 'dB(A)', 'industrial', 'CPCB');
  plStmt.run('Noise Level', 'noise', null, 65, 'dB(A)', 'commercial', 'CPCB');
  plStmt.run('Noise Level', 'noise', null, 55, 'dB(A)', 'residential', 'CPCB');

  // Monitoring Teams
  const mtStmt = db.prepare(`INSERT INTO monitoring_teams (name, regional_office_id, leader_name, leader_contact, specialization) VALUES (?, ?, ?, ?, ?)`);
  mtStmt.run('Alpha Air Team', 1, 'R. Verma', '+91-98765-43210', 'air');
  mtStmt.run('Beta Water Team', 2, 'S. Gupta', '+91-98765-43211', 'water');
  mtStmt.run('Gamma Noise Team', 1, 'P. Mehta', '+91-98765-43212', 'noise');
  mtStmt.run('Delta Industrial Team', 3, 'A. Khan', '+91-98765-43213', 'air');

  // Users (all roles for demo)
  const uStmt = db.prepare(`INSERT INTO users (username, name, role, email, regional_office_id, industry_id, team_id) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  uStmt.run('admin', 'State Admin', 'super_admin', 'admin@prithvinet.gov.in', null, null, null);
  uStmt.run('ro_north', 'Dr. Amit Sharma', 'regional_officer', 'amit@prithvinet.gov.in', 1, null, null);
  uStmt.run('ro_south', 'Ms. Priya Singh', 'regional_officer', 'priya@prithvinet.gov.in', 2, null, null);
  uStmt.run('team_alpha', 'R. Verma', 'monitoring_team', 'verma@prithvinet.gov.in', 1, null, 1);
  uStmt.run('tata_user', 'Tata Plant Manager', 'industry_user', 'plant@tatasteel.com', null, primaryIndustryId, null);
  uStmt.run('citizen1', 'Rahul Citizen', 'citizen', 'rahul@gmail.com', null, null, null);

  bootstrapMissingReportSchedules();

  console.log('[DB] Demo data seeded successfully');
}


/* ==============================================
   LEGACY FUNCTIONS (kept for backward compatibility)
   ============================================== */

/* ---------- STATION UPSERT ---------- */
const upsertStation = () => db.prepare(`
  INSERT INTO stations (uid, name, lat, lon, url, updated_at)
  VALUES (@uid, @name, @lat, @lon, @url, datetime('now'))
  ON CONFLICT(uid) DO UPDATE SET
    name=excluded.name, lat=excluded.lat, lon=excluded.lon,
    url=excluded.url, updated_at=datetime('now')
`);

function saveStations(stations) {
  const stmt = upsertStation();
  const tx = db.transaction((list) => {
    for (const s of list) stmt.run(s);
  });
  tx(stations);
}

function saveReading(r) {
  db.prepare(`
    INSERT INTO readings (station_uid, aqi, pm25, pm10, no2, o3, so2, co, temp, humidity, wind, pressure, dominant)
    VALUES (@station_uid, @aqi, @pm25, @pm10, @no2, @o3, @so2, @co, @temp, @humidity, @wind, @pressure, @dominant)
  `).run(r);
}

function saveReadingsBatch(readings) {
  const stmt = db.prepare(`
    INSERT INTO readings (station_uid, aqi, pm25, pm10, no2, o3, so2, co, temp, humidity, wind, pressure, dominant)
    VALUES (@station_uid, @aqi, @pm25, @pm10, @no2, @o3, @so2, @co, @temp, @humidity, @wind, @pressure, @dominant)
  `);
  const tx = db.transaction((list) => {
    for (const r of list) stmt.run(r);
  });
  tx(readings);
}

function saveForecasts(stationUid, forecasts) {
  db.prepare('DELETE FROM forecasts WHERE station_uid = ?').run(stationUid);
  const stmt = db.prepare(`
    INSERT INTO forecasts (station_uid, day, pollutant, avg, min, max)
    VALUES (@station_uid, @day, @pollutant, @avg, @min, @max)
  `);
  const tx = db.transaction((list) => {
    for (const f of list) stmt.run({ station_uid: stationUid, ...f });
  });
  tx(forecasts);
}

function saveWardAqi(wards) {
  const stmt = db.prepare(`
    INSERT INTO ward_aqi (ward_name, aqi, pm25, pm10, no2, o3, so2, co, dominant)
    VALUES (@ward_name, @aqi, @pm25, @pm10, @no2, @o3, @so2, @co, @dominant)
  `);
  const tx = db.transaction((list) => {
    for (const w of list) stmt.run(w);
  });
  tx(wards);
}

/* ---------- QUERIES (LEGACY) ---------- */

function getLatestReadings() {
  return db.prepare(`
    SELECT r.*, s.name AS station_name, s.lat, s.lon
    FROM readings r
    JOIN stations s ON s.uid = r.station_uid
    WHERE r.id IN (
      SELECT MAX(id) FROM readings GROUP BY station_uid
    )
    ORDER BY s.name
  `).all();
}

function getLatestWardAqi() {
  const latest = db.prepare(`SELECT MAX(computed_at) AS t FROM ward_aqi`).get();
  if (!latest || !latest.t) return [];
  return db.prepare(`SELECT * FROM ward_aqi WHERE computed_at = ?`).all(latest.t);
}

function getCityAverage() {
  const wards = getLatestWardAqi();
  if (wards.length === 0) return null;
  const avg = (field) => {
    const vals = wards.map(w => w[field]).filter(v => v != null && !isNaN(v));
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  };
  return {
    aqi: avg('aqi'), pm25: avg('pm25'), pm10: avg('pm10'),
    no2: avg('no2'), o3: avg('o3'), so2: avg('so2'), co: avg('co'),
    dominant: 'PM2.5', wardCount: wards.length
  };
}

function getForecast(stationUid) {
  return db.prepare(`
    SELECT day, pollutant, avg, min, max FROM forecasts
    WHERE station_uid = ? ORDER BY day
  `).all(stationUid);
}

function getWardHistory(wardName, days = 7) {
  return db.prepare(`
    SELECT ward_name, aqi, pm25, pm10, no2, o3, so2, co, dominant, computed_at
    FROM ward_aqi
    WHERE ward_name = ? AND computed_at >= datetime('now', '-' || ? || ' days')
    ORDER BY computed_at
  `).all(wardName, days);
}

function getAllStations() {
  return db.prepare('SELECT * FROM stations ORDER BY name').all();
}

function getStationDetail(uid) {
  const station = db.prepare('SELECT * FROM stations WHERE uid = ?').get(uid);
  const reading = db.prepare('SELECT * FROM readings WHERE station_uid = ? ORDER BY id DESC LIMIT 1').get(uid);
  const forecast = getForecast(uid);
  return { station, reading, forecast };
}

function getCityHistory(days = 7) {
  return db.prepare(`
    SELECT computed_at,
           ROUND(AVG(aqi))  AS aqi,
           ROUND(AVG(pm25)) AS pm25,
           ROUND(AVG(pm10)) AS pm10,
           ROUND(AVG(no2))  AS no2
    FROM ward_aqi
    WHERE computed_at >= datetime('now', '-' || ? || ' days')
    GROUP BY computed_at
    ORDER BY computed_at
  `).all(days);
}

function purgeOldData(days = 30) {
  db.prepare(`DELETE FROM readings WHERE fetched_at < datetime('now', '-' || ? || ' days')`).run(days);
  db.prepare(`DELETE FROM ward_aqi WHERE computed_at < datetime('now', '-' || ? || ' days')`).run(days);
  db.prepare(`DELETE FROM ward_aqi_history WHERE cycle_at < datetime('now', '-2 hours')`).run();
  db.prepare(`DELETE FROM civic_events WHERE expires_at < datetime('now')`).run();
  db.prepare(`DELETE FROM report_votes WHERE report_id IN (SELECT id FROM reports WHERE created_at < datetime('now', '-1 day'))`).run();
  db.prepare(`DELETE FROM reports WHERE created_at < datetime('now', '-1 day')`).run();
  // Purge old monitoring data
  db.prepare(`DELETE FROM monitoring_data WHERE recorded_at < datetime('now', '-' || ? || ' days')`).run(days);
}

/* ---------- WARD AQI HISTORY ---------- */
function saveWardAqiHistory(wards) {
  const stmt = db.prepare(`INSERT INTO ward_aqi_history (ward_name, aqi) VALUES (?, ?)`);
  const tx = db.transaction((list) => {
    for (const w of list) stmt.run(w.ward_name, w.aqi);
  });
  tx(wards);
  db.prepare(`DELETE FROM ward_aqi_history WHERE cycle_at < datetime('now', '-1 hour')`).run();
}

function getWardAqiHistory(wardName, limit = 3) {
  return db.prepare(`
    SELECT aqi, cycle_at FROM ward_aqi_history
    WHERE ward_name = ? ORDER BY cycle_at DESC LIMIT ?
  `).all(wardName, limit);
}

function getAllWardTrends() {
  const cycles = db.prepare(`
    SELECT DISTINCT cycle_at FROM ward_aqi_history ORDER BY cycle_at DESC LIMIT 3
  `).all().map(c => c.cycle_at);
  if (cycles.length === 0) return {};
  const rows = db.prepare(`
    SELECT ward_name, aqi, cycle_at FROM ward_aqi_history
    WHERE cycle_at IN (${cycles.map(() => '?').join(',')})
    ORDER BY ward_name, cycle_at DESC
  `).all(...cycles);
  const map = {};
  for (const r of rows) {
    if (!map[r.ward_name]) map[r.ward_name] = [];
    map[r.ward_name].push(r.aqi);
  }
  return map;
}

/* ---------- CIVIC EVENTS ---------- */
function saveCivicEvent(wardName, severity, details, expiresInHours = 1) {
  db.prepare(`
    INSERT INTO civic_events (ward_name, severity, details, expires_at)
    VALUES (?, ?, ?, datetime('now', '+' || ? || ' hours'))
  `).run(wardName, severity, details, expiresInHours);
}

function getActiveCivicEvents() {
  return db.prepare(`
    SELECT * FROM civic_events WHERE expires_at > datetime('now') ORDER BY created_at DESC
  `).all();
}

function getWardCivicEvents(wardName) {
  return db.prepare(`
    SELECT * FROM civic_events WHERE ward_name = ? AND expires_at > datetime('now') ORDER BY created_at DESC
  `).all(wardName);
}

/* ---------- REPORT EXPIRY DURATIONS (hours) ---------- */
const REPORT_EXPIRY = {
  burning:    2,
  vehicle:    2,
  industrial: 6,
  construction: 6,
  air_pollution: 4,
  water_contamination: 6,
  noise_violation: 3,
  industrial_emission: 6,
  other:      3
};

const POLL_WINDOW_MINUTES = 12;

/* ---------- REPORTS ---------- */
function saveReport(r) {
  const stmt = db.prepare(`
    INSERT INTO reports (lat, lng, category, description, media, voter_uid)
    VALUES (@lat, @lng, @category, @description, @media, @voter_uid)
  `);
  const info = stmt.run(r);
  return info.lastInsertRowid;
}

function getActiveReports() {
  const all = db.prepare(`SELECT * FROM reports ORDER BY created_at DESC`).all();
  const now = Date.now();
  return all.filter(r => {
    const expiryHours = REPORT_EXPIRY[r.category] || 3;
    const created = new Date(r.created_at + 'Z').getTime();
    return (now - created) < expiryHours * 3600000;
  });
}

function getReportById(id) {
  return db.prepare(`SELECT * FROM reports WHERE id = ?`).get(id);
}

/* ---------- VOTES ---------- */
function addVote(reportId, voterUid, vote, lat, lng) {
  const stmt = db.prepare(`
    INSERT INTO report_votes (report_id, vote, voter_uid, lat, lng)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(report_id, voter_uid) DO UPDATE SET vote=excluded.vote, voted_at=datetime('now')
  `);
  stmt.run(reportId, vote, voterUid, lat, lng);
}

function getVotesForReport(reportId) {
  return db.prepare(`SELECT vote, COUNT(*) as cnt FROM report_votes WHERE report_id = ? GROUP BY vote`).all(reportId);
}

function getReportConfidence(reportId) {
  const report = getReportById(reportId);
  if (!report) return { score: 0, label: 'Unknown', votes: {} };

  const voteRows = getVotesForReport(reportId);
  const votes = { confirmed: 0, false: 0, unsure: 0 };
  voteRows.forEach(v => { votes[v.vote] = v.cnt; });
  const totalVotes = votes.confirmed + votes.false + votes.unsure;

  const expiryHours = REPORT_EXPIRY[report.category] || 3;
  const nearby = db.prepare(`
    SELECT COUNT(*) as cnt FROM reports
    WHERE id != ? AND category = ?
      AND ABS(lat - ?) < 0.02 AND ABS(lng - ?) < 0.02
      AND created_at >= datetime('now', '-' || ? || ' hours')
  `).get(reportId, report.category, report.lat, report.lng, expiryHours);
  const nearbyCount = nearby ? nearby.cnt : 0;

  let score = 50;
  if (totalVotes > 0) {
    const voteSignal = ((votes.confirmed - votes.false) / totalVotes) * 35;
    score += voteSignal;
  }
  score += Math.min(nearbyCount * 5, 15);
  if (totalVotes > 0) {
    score -= (votes.unsure / totalVotes) * 5;
  }
  score = Math.max(0, Math.min(100, Math.round(score)));

  let label = 'Low';
  if (score >= 75) label = 'High';
  else if (score >= 50) label = 'Medium';

  return { score, label, votes, nearbyCount, totalVotes };
}

function isPollOpen(report) {
  const created = new Date(report.created_at + 'Z').getTime();
  return (Date.now() - created) < POLL_WINDOW_MINUTES * 60000;
}

function isReportActive(report) {
  const expiryHours = REPORT_EXPIRY[report.category] || 3;
  const created = new Date(report.created_at + 'Z').getTime();
  return (Date.now() - created) < expiryHours * 3600000;
}

function getReportWorkflow(reportId) {
  return db.prepare('SELECT * FROM report_workflow WHERE report_id = ?').get(reportId);
}

function upsertReportWorkflow(data) {
  const stmt = db.prepare(`
    INSERT INTO report_workflow (report_id, status, priority, assigned_team_id, note, updated_by, updated_by_role, updated_at)
    VALUES (@report_id, @status, @priority, @assigned_team_id, @note, @updated_by, @updated_by_role, datetime('now'))
    ON CONFLICT(report_id) DO UPDATE SET
      status=excluded.status,
      priority=excluded.priority,
      assigned_team_id=excluded.assigned_team_id,
      note=excluded.note,
      updated_by=excluded.updated_by,
      updated_by_role=excluded.updated_by_role,
      updated_at=datetime('now')
  `);
  return stmt.run(data);
}

function getAllReportWorkflow() {
  return db.prepare('SELECT * FROM report_workflow ORDER BY updated_at DESC').all();
}

/* ==============================================
   EXPORTS
   ============================================== */
module.exports = {
  init,
  seedDemoData,
  getDb: () => db,

  // Entity management
  getAllRegionalOffices, getRegionalOffice, createRegionalOffice, updateRegionalOffice, deleteRegionalOffice,
  getAllIndustries, getIndustry, createIndustry, updateIndustry, deleteIndustry,
  getAllMonitoringLocations, getMonitoringLocation, createMonitoringLocation, updateMonitoringLocation, deleteMonitoringLocation,
  getAllMonitoringUnits, createMonitoringUnit,
  getAllPrescribedLimits, createPrescribedLimit,
  getAllMonitoringTeams, createMonitoringTeam,
  getAllUsers, getUserByUsername, createUser,

  // Monitoring data
  saveMonitoringData, saveMonitoringDataBatch, getLatestMonitoringData, getMonitoringHistory,

  // Compliance
  createComplianceAlert, getComplianceAlerts, updateAlertStatus, createEscalation, getEscalations,
  getLatestOpenAlertForKey, bumpAlertOccurrence, assignAlert,
  logAlertTimeline, getAlertTimeline,
  upsertMissingReportSchedule, listMissingReportSchedules, listMissingReportEvents,
  getOpenMissingEventBySchedule, createMissingReportEvent, updateMissingReportEvent,
  touchScheduleHeartbeat, bootstrapMissingReportSchedules,

  // Legacy (backward compat)
  saveStations, saveReading, saveReadingsBatch, saveForecasts, saveWardAqi,
  getLatestReadings, getLatestWardAqi, getCityAverage, getForecast,
  getWardHistory, getAllStations, getStationDetail, getCityHistory,
  purgeOldData,

  // Reports
  saveReport, getActiveReports, getReportById,
  addVote, getVotesForReport, getReportConfidence,
  isPollOpen, isReportActive,
  getReportWorkflow, upsertReportWorkflow, getAllReportWorkflow,
  REPORT_EXPIRY, POLL_WINDOW_MINUTES,

  // Ward history / civic
  saveWardAqiHistory, getWardAqiHistory, getAllWardTrends,
  saveCivicEvent, getActiveCivicEvents, getWardCivicEvents
};
