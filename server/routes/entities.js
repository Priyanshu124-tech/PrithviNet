/* ==========================================
   PrithviNet — Entity Management APIs
   ==========================================
   CRUD operations for Master Entities:
   - Regional Offices
   - Industries
   - Monitoring Locations
   ========================================== */

'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db');
const authz = require('../authz');

// Add basic error handling wrapper
const asyncHandler = fn => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

router.use(authz.attachActor);

function canReadEntities(req) {
  return authz.hasRole(
    req,
    authz.ROLES.SUPER_ADMIN,
    authz.ROLES.REGIONAL_OFFICER,
    authz.ROLES.MONITORING_TEAM,
    authz.ROLES.INDUSTRY_USER
  );
}

function requireEntityRead(req, res, next) {
  if (!canReadEntities(req)) {
    return res.status(403).json({ status: 'error', message: 'Entity access denied for this role' });
  }
  next();
}

function requireEntityWrite(req, res, next) {
  if (!authz.hasRole(req, authz.ROLES.SUPER_ADMIN, authz.ROLES.REGIONAL_OFFICER)) {
    return res.status(403).json({ status: 'error', message: 'Only Super Admin or Regional Officer can modify entities' });
  }
  next();
}

/* ==============================================
   REGIONAL OFFICES
   ============================================== */

router.get('/regional-offices', requireEntityRead, asyncHandler((req, res) => {
  const data = db.getAllRegionalOffices();
  if (req.actor.role === authz.ROLES.REGIONAL_OFFICER || req.actor.role === authz.ROLES.MONITORING_TEAM) {
    const scoped = req.actor.regionalOfficeId ? data.filter(r => Number(r.id) === Number(req.actor.regionalOfficeId)) : [];
    return res.json({ status: 'ok', data: scoped });
  }
  if (req.actor.role === authz.ROLES.INDUSTRY_USER) {
    return res.json({ status: 'ok', data: [] });
  }
  res.json({ status: 'ok', data });
}));

router.get('/regional-offices/:id', requireEntityRead, asyncHandler((req, res) => {
  const data = db.getRegionalOffice(req.params.id);
  if (!data) return res.status(404).json({ status: 'error', message: 'Not found' });
  if (!authz.canAccessRegionalOffice(req, data.id) && !authz.hasRole(req, authz.ROLES.SUPER_ADMIN)) {
    return res.status(403).json({ status: 'error', message: 'Regional scope violation' });
  }
  res.json({ status: 'ok', data });
}));

router.post('/regional-offices', requireEntityWrite, asyncHandler((req, res) => {
  if (req.actor.role === authz.ROLES.REGIONAL_OFFICER) {
    return res.status(403).json({ status: 'error', message: 'Regional Officer cannot create new regional offices' });
  }
  const info = db.createRegionalOffice(req.body);
  res.json({ status: 'ok', id: info.lastInsertRowid });
}));

router.put('/regional-offices/:id', requireEntityWrite, asyncHandler((req, res) => {
  if (req.actor.role === authz.ROLES.REGIONAL_OFFICER && Number(req.params.id) !== Number(req.actor.regionalOfficeId)) {
    return res.status(403).json({ status: 'error', message: 'Regional Officer can update only own office' });
  }
  db.updateRegionalOffice(req.params.id, req.body);
  res.json({ status: 'ok' });
}));

router.delete('/regional-offices/:id', requireEntityWrite, asyncHandler((req, res) => {
  if (req.actor.role !== authz.ROLES.SUPER_ADMIN) {
    return res.status(403).json({ status: 'error', message: 'Only Super Admin can delete regional offices' });
  }
  db.deleteRegionalOffice(req.params.id);
  res.json({ status: 'ok' });
}));

/* ==============================================
   INDUSTRIES
   ============================================== */

router.get('/industries', requireEntityRead, asyncHandler((req, res) => {
  const data = db.getAllIndustries();
  if (req.actor.role === authz.ROLES.REGIONAL_OFFICER || req.actor.role === authz.ROLES.MONITORING_TEAM) {
    const scoped = req.actor.regionalOfficeId ? data.filter(i => Number(i.regional_office_id) === Number(req.actor.regionalOfficeId)) : [];
    return res.json({ status: 'ok', data: scoped });
  }
  if (req.actor.role === authz.ROLES.INDUSTRY_USER) {
    const scoped = req.actor.industryId ? data.filter(i => Number(i.id) === Number(req.actor.industryId)) : [];
    return res.json({ status: 'ok', data: scoped });
  }
  res.json({ status: 'ok', data });
}));

router.get('/industries/:id', requireEntityRead, asyncHandler((req, res) => {
  const data = db.getIndustry(req.params.id);
  if (!data) return res.status(404).json({ status: 'error', message: 'Not found' });
  if (req.actor.role === authz.ROLES.INDUSTRY_USER && !authz.canAccessIndustry(req, data.id)) {
    return res.status(403).json({ status: 'error', message: 'Industry scope violation' });
  }
  if ((req.actor.role === authz.ROLES.REGIONAL_OFFICER || req.actor.role === authz.ROLES.MONITORING_TEAM) &&
      !authz.canAccessRegionalOffice(req, data.regional_office_id)) {
    return res.status(403).json({ status: 'error', message: 'Regional scope violation' });
  }
  res.json({ status: 'ok', data });
}));

router.post('/industries', requireEntityWrite, asyncHandler((req, res) => {
  if (req.actor.role === authz.ROLES.REGIONAL_OFFICER) {
    const targetRo = Number(req.body?.regional_office_id);
    if (!targetRo || !authz.canAccessRegionalOffice(req, targetRo)) {
      return res.status(403).json({ status: 'error', message: 'Regional Officer can create only in own region' });
    }
  }
  const info = db.createIndustry(req.body);
  res.json({ status: 'ok', id: info.lastInsertRowid });
}));

router.put('/industries/:id', requireEntityWrite, asyncHandler((req, res) => {
  const cur = db.getIndustry(req.params.id);
  if (!cur) return res.status(404).json({ status: 'error', message: 'Not found' });
  if (req.actor.role === authz.ROLES.REGIONAL_OFFICER && !authz.canAccessRegionalOffice(req, cur.regional_office_id)) {
    return res.status(403).json({ status: 'error', message: 'Regional scope violation' });
  }
  db.updateIndustry(req.params.id, { ...cur, ...req.body });
  res.json({ status: 'ok' });
}));

router.delete('/industries/:id', requireEntityWrite, asyncHandler((req, res) => {
  const cur = db.getIndustry(req.params.id);
  if (!cur) return res.status(404).json({ status: 'error', message: 'Not found' });
  if (req.actor.role === authz.ROLES.REGIONAL_OFFICER && !authz.canAccessRegionalOffice(req, cur.regional_office_id)) {
    return res.status(403).json({ status: 'error', message: 'Regional scope violation' });
  }
  db.deleteIndustry(req.params.id);
  res.json({ status: 'ok' });
}));

/* ==============================================
   MONITORING LOCATIONS
   ============================================== */

router.get('/monitoring-locations', requireEntityRead, asyncHandler((req, res) => {
  const type = req.query.type; // optional filter
  const data = db.getAllMonitoringLocations(type);
  if (req.actor.role === authz.ROLES.REGIONAL_OFFICER || req.actor.role === authz.ROLES.MONITORING_TEAM) {
    const scoped = req.actor.regionalOfficeId ? data.filter(m => Number(m.regional_office_id) === Number(req.actor.regionalOfficeId)) : [];
    return res.json({ status: 'ok', data: scoped });
  }
  if (req.actor.role === authz.ROLES.INDUSTRY_USER) {
    const scoped = req.actor.industryId ? data.filter(m => Number(m.industry_id) === Number(req.actor.industryId)) : [];
    return res.json({ status: 'ok', data: scoped });
  }
  res.json({ status: 'ok', data });
}));

router.get('/monitoring-locations/:id', requireEntityRead, asyncHandler((req, res) => {
  const data = db.getMonitoringLocation(req.params.id);
  if (!data) return res.status(404).json({ status: 'error', message: 'Not found' });
  if ((req.actor.role === authz.ROLES.REGIONAL_OFFICER || req.actor.role === authz.ROLES.MONITORING_TEAM) &&
      !authz.canAccessRegionalOffice(req, data.regional_office_id)) {
    return res.status(403).json({ status: 'error', message: 'Regional scope violation' });
  }
  if (req.actor.role === authz.ROLES.INDUSTRY_USER && !authz.canAccessIndustry(req, data.industry_id)) {
    return res.status(403).json({ status: 'error', message: 'Industry scope violation' });
  }
  res.json({ status: 'ok', data });
}));

router.post('/monitoring-locations', requireEntityWrite, asyncHandler((req, res) => {
  if (req.actor.role === authz.ROLES.REGIONAL_OFFICER) {
    const targetRo = Number(req.body?.regional_office_id);
    if (!targetRo || !authz.canAccessRegionalOffice(req, targetRo)) {
      return res.status(403).json({ status: 'error', message: 'Regional Officer can create only in own region' });
    }
  }
  const info = db.createMonitoringLocation(req.body);
  res.json({ status: 'ok', id: info.lastInsertRowid });
}));

router.put('/monitoring-locations/:id', requireEntityWrite, asyncHandler((req, res) => {
  const cur = db.getMonitoringLocation(req.params.id);
  if (!cur) return res.status(404).json({ status: 'error', message: 'Not found' });
  if (req.actor.role === authz.ROLES.REGIONAL_OFFICER && !authz.canAccessRegionalOffice(req, cur.regional_office_id)) {
    return res.status(403).json({ status: 'error', message: 'Regional scope violation' });
  }
  db.updateMonitoringLocation(req.params.id, { ...cur, ...req.body });
  res.json({ status: 'ok' });
}));

router.delete('/monitoring-locations/:id', requireEntityWrite, asyncHandler((req, res) => {
  const cur = db.getMonitoringLocation(req.params.id);
  if (!cur) return res.status(404).json({ status: 'error', message: 'Not found' });
  if (req.actor.role === authz.ROLES.REGIONAL_OFFICER && !authz.canAccessRegionalOffice(req, cur.regional_office_id)) {
    return res.status(403).json({ status: 'error', message: 'Regional scope violation' });
  }
  db.deleteMonitoringLocation(req.params.id);
  res.json({ status: 'ok' });
}));

// Global error handler for this router
router.use((err, req, res, next) => {
  console.error('[Entities API Error]', err);
  res.status(500).json({ status: 'error', message: err.message });
});

module.exports = router;
