const express = require('express');
const router = express.Router();
const db = require('../db');
const authz = require('../authz');

router.use(authz.attachActor);

const ACTIVE_ALERT_STATUSES = ['open', 'new', 'acknowledged', 'in_action', 'escalated'];

function getAlertScopeDetails(alertId) {
  return db.getDb().prepare(`
    SELECT ca.id, ca.location_id, ca.industry_id, ml.regional_office_id
    FROM compliance_alerts ca
    LEFT JOIN monitoring_locations ml ON ml.id = ca.location_id
    WHERE ca.id = ?
  `).get(alertId);
}

function parseSqlDate(v) {
  if (!v) return null;
  return new Date(String(v).endsWith('Z') ? v : `${v}Z`);
}

function toSqlDate(d) {
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function ageMinutes(since) {
  const dt = parseSqlDate(since);
  if (!dt || Number.isNaN(dt.getTime())) return 0;
  return Math.floor((Date.now() - dt.getTime()) / 60000);
}

function filterAlertsByRole(req, alerts) {
  const role = req.actor.role;
  if (role === authz.ROLES.SUPER_ADMIN) return alerts;
  if (role === authz.ROLES.REGIONAL_OFFICER || role === authz.ROLES.MONITORING_TEAM) {
    if (!req.actor.regionalOfficeId) return [];
    return alerts.filter(a => Number(a.regional_office_id || -1) === Number(req.actor.regionalOfficeId));
  }
  if (role === authz.ROLES.INDUSTRY_USER) {
    if (!req.actor.industryId) return [];
    return alerts.filter(a => Number(a.industry_id || -1) === Number(req.actor.industryId));
  }
  return [];
}

function filterMissingByRole(req, events) {
  const role = req.actor.role;
  if (role === authz.ROLES.SUPER_ADMIN) return events;
  if (role === authz.ROLES.REGIONAL_OFFICER || role === authz.ROLES.MONITORING_TEAM) {
    if (!req.actor.regionalOfficeId) return [];
    return events.filter(e => Number(e.regional_office_id || -1) === Number(req.actor.regionalOfficeId));
  }
  if (role === authz.ROLES.INDUSTRY_USER) {
    if (!req.actor.industryId) return [];
    return events.filter(e => Number(e.industry_id || -1) === Number(req.actor.industryId));
  }
  return [];
}

function enrichAlertMicrocopy(a) {
  const mins = ageMinutes(a.first_triggered_at || a.created_at);
  const ratio = Number(a.exceedance_ratio || 1).toFixed(2);
  const unit = a.type === 'noise' ? 'dB' : (a.type === 'water' ? 'units' : 'AQI/ugm3');
  return {
    ...a,
    live_copy: `${a.parameter} above limit for ${mins} min · ${ratio}x exceedance`,
    pending_sla_minutes: a.severity === 'critical' ? Math.max(0, 30 - mins) : Math.max(0, 120 - mins),
    quick_actions: ['acknowledged', 'in_action', 'resolved', 'escalated'],
    unit
  };
}

function runAutoEscalation(req, alerts) {
  const now = Date.now();
  const escalationRows = [];

  alerts.forEach(a => {
    if (a.severity !== 'critical' || !ACTIVE_ALERT_STATUSES.includes(a.status)) return;
    const base = parseSqlDate(a.first_triggered_at || a.created_at);
    if (!base) return;
    const mins = Math.floor((now - base.getTime()) / 60000);
    const existing = db.getEscalations(a.id);
    const hasRegional = existing.some(e => e.to_role === 'regional_officer');
    const hasHigher = existing.some(e => e.to_role === 'higher_authority');

    if (mins > 30 && !hasRegional) {
      db.createEscalation({
        alert_id: a.id,
        from_role: 'system',
        to_role: 'regional_officer',
        note: 'Critical alert unresolved beyond 30 minutes'
      });
      db.updateAlertStatus(a.id, 'escalated', req.actor.userId || 'system');
      escalationRows.push({ alert_id: a.id, level: 'L1', to_role: 'regional_officer' });
    }

    if (mins > 120 && !hasHigher) {
      db.createEscalation({
        alert_id: a.id,
        from_role: 'system',
        to_role: 'higher_authority',
        note: 'Critical alert unresolved beyond 2 hours'
      });
      db.updateAlertStatus(a.id, 'escalated', req.actor.userId || 'system');
      escalationRows.push({ alert_id: a.id, level: 'L2', to_role: 'higher_authority' });
    }
  });

  return escalationRows;
}

function getKpisForAlerts(alerts) {
  const openAlerts = alerts.filter(a => ACTIVE_ALERT_STATUSES.includes(a.status));
  const bySeverity = {
    critical: openAlerts.filter(a => a.severity === 'critical').length,
    warning: openAlerts.filter(a => a.severity !== 'critical').length
  };

  const offenders = new Map();
  alerts.forEach(a => {
    const key = `${a.industry_id || 'none'}::${a.industry_name || a.location_name || 'Unknown'}`;
    offenders.set(key, (offenders.get(key) || 0) + 1);
  });

  const repeatOffenders = Array.from(offenders.entries())
    .map(([k, c]) => {
      const parts = k.split('::');
      return { industry_id: parts[0], name: parts[1], count: c };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const mttaSource = alerts.filter(a => a.acknowledged_at && a.created_at);
  const mttrSource = alerts.filter(a => a.resolved_at && a.created_at);

  const mean = (arr) => arr.length ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : 0;
  const mtta = mean(mttaSource.map(a => Math.max(0, Math.floor((parseSqlDate(a.acknowledged_at) - parseSqlDate(a.created_at)) / 60000))));
  const mttr = mean(mttrSource.map(a => Math.max(0, Math.floor((parseSqlDate(a.resolved_at) - parseSqlDate(a.created_at)) / 60000))));

  const slaBreaches = alerts.filter(a => {
    if (!ACTIVE_ALERT_STATUSES.includes(a.status)) return false;
    const mins = ageMinutes(a.first_triggered_at || a.created_at);
    if (a.severity === 'critical') return mins > 30;
    return mins > 120;
  }).length;

  return {
    openBySeverity: bySeverity,
    repeatOffenders,
    slaBreaches,
    meanTimeToAcknowledgeMinutes: mtta,
    meanTimeToResolveMinutes: mttr
  };
}

function computeMissingScheduleBuckets(schedules) {
  const now = Date.now();
  let dueSoon = 0;
  let overdueNow = 0;

  schedules.forEach(s => {
    const base = parseSqlDate(s.last_submission_at) || parseSqlDate(s.created_at);
    if (!base || Number.isNaN(base.getTime())) return;

    const dueAt = new Date(base.getTime() + Number(s.frequency_minutes || 60) * 60000);
    const overdueAt = new Date(dueAt.getTime() + Number(s.grace_minutes || 30) * 60000);

    if (now >= overdueAt.getTime()) {
      overdueNow++;
      return;
    }

    const minsToDue = Math.floor((dueAt.getTime() - now) / 60000);
    if (minsToDue >= 0 && minsToDue <= 60) {
      dueSoon++;
    }
  });

  return { dueSoon, overdueNow };
}

// GET /api/compliance/alerts
router.get('/alerts', (req, res) => {
  try {
    if (!authz.hasRole(req, authz.ROLES.SUPER_ADMIN, authz.ROLES.REGIONAL_OFFICER, authz.ROLES.MONITORING_TEAM, authz.ROLES.INDUSTRY_USER)) {
      return res.status(403).json({ error: 'Compliance alerts are not available for this role' });
    }

    const { status, type, source } = req.query;
    const statusFilter = status === 'open' ? null : (status || null);

    const alertsRaw = db.getDb().prepare(`
      SELECT ca.*, ml.name as location_name, ml.region, ml.regional_office_id, i.name as industry_name
      FROM compliance_alerts ca
      LEFT JOIN monitoring_locations ml ON ml.id = ca.location_id
      LEFT JOIN industries i ON i.id = ca.industry_id
      WHERE (? IS NULL OR ca.status = ?)
        AND (? IS NULL OR ca.type = ?)
        AND (? IS NULL OR ca.source = ?)
      ORDER BY ca.created_at DESC
    `).all(statusFilter, statusFilter, type || null, type || null, source || null, source || null);

    let alerts = filterAlertsByRole(req, alertsRaw).map(enrichAlertMicrocopy);
    if (status === 'open') {
      alerts = alerts.filter(a => ACTIVE_ALERT_STATUSES.includes(a.status));
    }

    res.json(alerts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch alerts' });
  }
});

// GET /api/compliance/alerts/:id/timeline
router.get('/alerts/:id/timeline', (req, res) => {
  try {
    const { id } = req.params;
    const scoped = getAlertScopeDetails(id);
    if (!scoped) return res.status(404).json({ error: 'Alert not found' });

    if (req.actor.role === authz.ROLES.CITIZEN) {
      return res.status(403).json({ error: 'Timeline is not available for this role' });
    }

    if ((req.actor.role === authz.ROLES.REGIONAL_OFFICER || req.actor.role === authz.ROLES.MONITORING_TEAM) &&
      !authz.canAccessRegionalOffice(req, scoped.regional_office_id)) {
      return res.status(403).json({ error: 'Regional scope violation' });
    }

    if (req.actor.role === authz.ROLES.INDUSTRY_USER && !authz.canAccessIndustry(req, scoped.industry_id)) {
      return res.status(403).json({ error: 'Industry scope violation' });
    }

    const timeline = db.getAlertTimeline(id);
    const escalations = db.getEscalations(id);
    res.json({ timeline, escalations });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch alert timeline' });
  }
});

// PUT /api/compliance/alerts/:id/assign
router.put('/alerts/:id/assign', (req, res) => {
  try {
    const { id } = req.params;
    const { assigned_to, assigned_role } = req.body || {};
    const scoped = getAlertScopeDetails(id);
    if (!scoped) return res.status(404).json({ error: 'Alert not found' });

    if (!authz.hasRole(req, authz.ROLES.SUPER_ADMIN, authz.ROLES.REGIONAL_OFFICER)) {
      return res.status(403).json({ error: 'Only Super Admin or Regional Officer can assign alerts' });
    }

    if (req.actor.role === authz.ROLES.REGIONAL_OFFICER && !authz.canAccessRegionalOffice(req, scoped.regional_office_id)) {
      return res.status(403).json({ error: 'Regional scope violation' });
    }

    db.assignAlert(id, assigned_to || null, assigned_role || null, req.actor.role, req.actor.userId);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to assign alert' });
  }
});

// POST /api/compliance/alerts/:id/escalate
router.post('/alerts/:id/escalate', (req, res) => {
  try {
    const { id } = req.params;
    const { note, to_role } = req.body || {};
    const scoped = getAlertScopeDetails(id);
    if (!scoped) return res.status(404).json({ error: 'Alert not found' });

    if (!authz.hasRole(req, authz.ROLES.SUPER_ADMIN, authz.ROLES.REGIONAL_OFFICER, authz.ROLES.MONITORING_TEAM)) {
      return res.status(403).json({ error: 'Role not allowed to escalate alerts' });
    }

    if ((req.actor.role === authz.ROLES.REGIONAL_OFFICER || req.actor.role === authz.ROLES.MONITORING_TEAM) &&
      !authz.canAccessRegionalOffice(req, scoped.regional_office_id)) {
      return res.status(403).json({ error: 'Regional scope violation' });
    }

    db.createEscalation({
      alert_id: id,
      from_role: req.actor.role,
      to_role: to_role || 'higher_authority',
      note: note || 'Escalated manually from operations inbox'
    });
    db.updateAlertStatus(id, 'escalated', req.actor.userId);

    res.json({ success: true, status: 'escalated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to escalate alert' });
  }
});

// PUT /api/compliance/alerts/:id/status
router.put('/alerts/:id/status', (req, res) => {
  try {
    const { id } = req.params;
    const { status, note, userId } = req.body;
    const role = req.actor.role;
    const scoped = getAlertScopeDetails(id);
    if (!scoped) return res.status(404).json({ error: 'Alert not found' });

    if (role === authz.ROLES.CITIZEN) {
      return res.status(403).json({ error: 'Citizens cannot update compliance alerts' });
    }

    if (role === authz.ROLES.REGIONAL_OFFICER || role === authz.ROLES.MONITORING_TEAM) {
      if (!authz.canAccessRegionalOffice(req, scoped.regional_office_id)) {
        return res.status(403).json({ error: 'Regional scope violation' });
      }
    }

    if (role === authz.ROLES.INDUSTRY_USER && !authz.canAccessIndustry(req, scoped.industry_id)) {
      return res.status(403).json({ error: 'Industry scope violation' });
    }

    if (role === authz.ROLES.MONITORING_TEAM && !['acknowledged', 'in_action'].includes(status)) {
      return res.status(403).json({ error: 'Monitoring Team can only acknowledge or move to in_action' });
    }

    if (role === authz.ROLES.REGIONAL_OFFICER && !['acknowledged', 'in_action', 'resolved', 'escalated'].includes(status)) {
      return res.status(403).json({ error: 'Regional Officer can only acknowledge, in_action, resolve, or escalate' });
    }

    if (role === authz.ROLES.INDUSTRY_USER && status !== 'industry_response') {
      return res.status(403).json({ error: 'Industry User can only submit industry_response' });
    }

    db.updateAlertStatus(id, status, userId || req.actor.userId || null);

    if (status === 'escalated') {
      db.createEscalation({
        alert_id: id,
        from_role: role,
        to_role: 'higher_authority',
        note: note || 'Escalated to higher authorities immediately.'
      });
    }

    if (status === 'industry_response') {
      db.createEscalation({
        alert_id: id,
        from_role: 'industry_user',
        to_role: 'regional_officer',
        note: note || 'Industry has submitted mitigation response.'
      });
    }

    res.json({ success: true, status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update alert status' });
  }
});

// GET /api/compliance/escalations/:alertId
router.get('/escalations/:alertId', (req, res) => {
  try {
    const { alertId } = req.params;
    const scoped = getAlertScopeDetails(alertId);
    if (!scoped) return res.status(404).json({ error: 'Alert not found' });

    if (req.actor.role === authz.ROLES.CITIZEN) {
      return res.status(403).json({ error: 'Escalations are not available for this role' });
    }
    if ((req.actor.role === authz.ROLES.REGIONAL_OFFICER || req.actor.role === authz.ROLES.MONITORING_TEAM) &&
      !authz.canAccessRegionalOffice(req, scoped.regional_office_id)) {
      return res.status(403).json({ error: 'Regional scope violation' });
    }
    if (req.actor.role === authz.ROLES.INDUSTRY_USER && !authz.canAccessIndustry(req, scoped.industry_id)) {
      return res.status(403).json({ error: 'Industry scope violation' });
    }

    const escalations = db.getEscalations(alertId);
    res.json(escalations);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch escalations' });
  }
});

// PUT /api/compliance/missing-reports/:id/status
router.put('/missing-reports/:id/status', (req, res) => {
  try {
    if (!authz.hasRole(req, authz.ROLES.SUPER_ADMIN, authz.ROLES.REGIONAL_OFFICER, authz.ROLES.MONITORING_TEAM)) {
      return res.status(403).json({ error: 'Role not allowed to update missing reports' });
    }
    const { id } = req.params;
    const { status } = req.body || {};
    if (!['acknowledged', 'resolved', 'escalation_candidate'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status for missing report event' });
    }
    db.updateMissingReportEvent(id, { status });
    res.json({ success: true, status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update missing report status' });
  }
});

// POST /api/compliance/missing-reports/:id/notify
router.post('/missing-reports/:id/notify', (req, res) => {
  try {
    if (!authz.hasRole(req, authz.ROLES.SUPER_ADMIN, authz.ROLES.REGIONAL_OFFICER, authz.ROLES.MONITORING_TEAM)) {
      return res.status(403).json({ error: 'Role not allowed to notify for missing reports' });
    }
    const { id } = req.params;
    const { channel } = req.body || {};
    db.updateMissingReportEvent(id, {
      status: 'acknowledged',
      message: 'Reminder notification dispatched',
      metadata: {
        channel: channel || 'dashboard',
        notified_by: req.actor.userId,
        notified_role: req.actor.role,
        notified_at: toSqlDate(new Date())
      }
    });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to dispatch reminder notification' });
  }
});

// GET /api/compliance/schedules
router.get('/schedules', (req, res) => {
  try {
    if (!authz.hasRole(req, authz.ROLES.SUPER_ADMIN, authz.ROLES.REGIONAL_OFFICER, authz.ROLES.MONITORING_TEAM)) {
      return res.status(403).json({ error: 'Schedules unavailable for this role' });
    }
    const schedules = filterMissingByRole(req, db.listMissingReportSchedules());
    res.json({ schedules });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch schedules' });
  }
});

// PUT /api/compliance/schedules/:id
router.put('/schedules/:id', (req, res) => {
  try {
    if (!authz.hasRole(req, authz.ROLES.SUPER_ADMIN, authz.ROLES.REGIONAL_OFFICER)) {
      return res.status(403).json({ error: 'Only admin or regional officer can update schedules' });
    }

    const { id } = req.params;
    const existing = db.listMissingReportSchedules().find(s => Number(s.id) === Number(id));
    if (!existing) return res.status(404).json({ error: 'Schedule not found' });

    if (req.actor.role === authz.ROLES.REGIONAL_OFFICER && Number(existing.regional_office_id || -1) !== Number(req.actor.regionalOfficeId || -1)) {
      return res.status(403).json({ error: 'Regional scope violation' });
    }

    const next = {
      entity_type: existing.entity_type,
      entity_id: existing.entity_id,
      type: existing.type,
      frequency_minutes: Math.max(15, Number(req.body?.frequency_minutes ?? existing.frequency_minutes ?? 60)),
      grace_minutes: Math.max(5, Number(req.body?.grace_minutes ?? existing.grace_minutes ?? 30)),
      escalation_minutes: Math.max(30, Number(req.body?.escalation_minutes ?? existing.escalation_minutes ?? 120)),
      is_active: req.body?.is_active === undefined ? Number(existing.is_active || 1) : (req.body.is_active ? 1 : 0)
    };

    db.upsertMissingReportSchedule(next);
    res.json({ success: true, schedule: next });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update schedule' });
  }
});

// GET /api/compliance/inbox
router.get('/inbox', (req, res) => {
  try {
    if (!authz.hasRole(req, authz.ROLES.SUPER_ADMIN, authz.ROLES.REGIONAL_OFFICER, authz.ROLES.MONITORING_TEAM, authz.ROLES.INDUSTRY_USER)) {
      return res.status(403).json({ error: 'Compliance inbox unavailable for this role' });
    }

    const alertsRaw = db.getDb().prepare(`
      SELECT ca.*, ml.name as location_name, ml.region, ml.regional_office_id, ml.lat as location_lat, ml.lon as location_lon, i.name as industry_name
      FROM compliance_alerts ca
      LEFT JOIN monitoring_locations ml ON ml.id = ca.location_id
      LEFT JOIN industries i ON i.id = ca.industry_id
      ORDER BY ca.created_at DESC
      LIMIT 500
    `).all();
    const alerts = filterAlertsByRole(req, alertsRaw).map(enrichAlertMicrocopy);

    const missing = filterMissingByRole(req, db.listMissingReportEvents())
      .filter(m => ['new', 'escalation_candidate', 'acknowledged'].includes(m.status));

    const allEsc = db.getDb().prepare(`
      SELECT e.*, ca.location_id, ca.industry_id, ml.regional_office_id, ml.name as location_name
      FROM escalations e
      JOIN compliance_alerts ca ON ca.id = e.alert_id
      LEFT JOIN monitoring_locations ml ON ml.id = ca.location_id
      ORDER BY e.created_at DESC
      LIMIT 500
    `).all();
    const escalations = filterAlertsByRole(req, allEsc);

    const schedules = filterMissingByRole(req, db.listMissingReportSchedules());
    const scheduleBuckets = computeMissingScheduleBuckets(schedules);

    const tabs = {
      activeAlerts: alerts.filter(a => ACTIVE_ALERT_STATUSES.includes(a.status)).sort((a, b) => {
        const sev = { critical: 2, warning: 1 };
        if ((sev[b.severity] || 0) !== (sev[a.severity] || 0)) return (sev[b.severity] || 0) - (sev[a.severity] || 0);
        return ageMinutes(b.created_at) - ageMinutes(a.created_at);
      }),
      missingReports: missing.sort((a, b) => {
        if (a.status === 'escalation_candidate' && b.status !== 'escalation_candidate') return -1;
        if (b.status === 'escalation_candidate' && a.status !== 'escalation_candidate') return 1;
        return ageMinutes(b.detected_at) - ageMinutes(a.detected_at);
      }),
      escalations
    };

    const kpis = getKpisForAlerts(alerts);

    res.json({
      tabs,
      kpis,
      counts: {
        activeAlerts: tabs.activeAlerts.length,
        missingReports: tabs.missingReports.length,
        escalations: tabs.escalations.length,
        dueSoon: scheduleBuckets.dueSoon,
        overdueNow: scheduleBuckets.overdueNow
      },
      schedules
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch operations inbox' });
  }
});

// GET /api/compliance/kpis
router.get('/kpis', (req, res) => {
  try {
    if (!authz.hasRole(req, authz.ROLES.SUPER_ADMIN, authz.ROLES.REGIONAL_OFFICER, authz.ROLES.MONITORING_TEAM, authz.ROLES.INDUSTRY_USER)) {
      return res.status(403).json({ error: 'Compliance KPI unavailable for this role' });
    }

    const alertsRaw = db.getDb().prepare(`
      SELECT ca.*, ml.regional_office_id, i.name as industry_name
      FROM compliance_alerts ca
      LEFT JOIN monitoring_locations ml ON ml.id = ca.location_id
      LEFT JOIN industries i ON i.id = ca.industry_id
      WHERE ca.created_at >= datetime('now', '-30 days')
      ORDER BY ca.created_at DESC
    `).all();
    const alerts = filterAlertsByRole(req, alertsRaw);
    res.json(getKpisForAlerts(alerts));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch KPI metrics' });
  }
});

// GET /api/compliance/trends
router.get('/trends', (req, res) => {
  try {
    if (!authz.hasRole(req, authz.ROLES.SUPER_ADMIN, authz.ROLES.REGIONAL_OFFICER, authz.ROLES.MONITORING_TEAM, authz.ROLES.INDUSTRY_USER)) {
      return res.status(403).json({ error: 'Compliance trends unavailable for this role' });
    }

    const windowQuery = String(req.query.window || '7d').toLowerCase();
    const groupBy = String(req.query.groupBy || 'industry').toLowerCase();
    const days = windowQuery === '30d' ? 30 : 7;

    const alertsRaw = db.getDb().prepare(`
      SELECT ca.*, ml.regional_office_id, ml.region, i.name as industry_name
      FROM compliance_alerts ca
      LEFT JOIN monitoring_locations ml ON ml.id = ca.location_id
      LEFT JOIN industries i ON i.id = ca.industry_id
      WHERE ca.created_at >= datetime('now', '-' || ? || ' days')
      ORDER BY ca.created_at DESC
    `).all(days);

    const scoped = filterAlertsByRole(req, alertsRaw);
    const keyFn = groupBy === 'parameter'
      ? (r) => r.parameter || 'Unknown'
      : groupBy === 'region'
        ? (r) => r.region || 'Unmapped Region'
        : (r) => r.industry_name || 'Unknown Industry';

    const grouped = new Map();
    scoped.forEach(row => {
      const key = keyFn(row);
      if (!grouped.has(key)) grouped.set(key, { key, total: 0, critical: 0, warning: 0, resolved: 0, open: 0 });
      const g = grouped.get(key);
      g.total++;
      if (row.severity === 'critical') g.critical++;
      else g.warning++;
      if (ACTIVE_ALERT_STATUSES.includes(row.status)) g.open++;
      if (row.status === 'resolved' || row.status === 'auto_closed') g.resolved++;
    });

    const series = Array.from(grouped.values()).sort((a, b) => b.total - a.total).slice(0, 12);
    res.json({ window: `${days}d`, groupBy, series });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch compliance trends' });
  }
});

module.exports = router;
