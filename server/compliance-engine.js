const db = require('./db');

class ComplianceEngine {
  constructor() {
    this.limits = {};
    this.cooldownMinutes = 30;
    this.autoCloseMinutes = 120;
    this.paramMap = {
      'pm25': 'PM2.5',
      'pm10': 'PM10',
      'no2': 'NO2',
      'so2': 'SO2',
      'co': 'CO',
      'o3': 'O3',
      'ph': 'pH',
      'dissolved_oxygen': 'DO',
      'bod': 'BOD',
      'cod': 'COD',
      'turbidity': 'Turbidity',
      'noise_level_db': 'Noise Level'
    };
  }

  loadLimits() {
    const allLimits = db.getAllPrescribedLimits();
    this.limits = {};
    allLimits.forEach(l => {
      if (!this.limits[l.type]) this.limits[l.type] = {};
      this.limits[l.type][l.parameter] = l;
    });
  }

  computeSeverity(val, threshold, conditionStr, existingOccurrences = 0) {
    if (!threshold || threshold <= 0) {
      return { severity: 'warning', ratio: 1, score: 40 };
    }
    const ratio = conditionStr === 'fell below'
      ? Math.max(0, threshold / Math.max(val, 0.001))
      : Math.max(0, val / threshold);

    const persistenceBoost = Math.min(25, existingOccurrences * 3);
    const ratioScore = Math.min(100, Math.round((ratio - 1) * 70 + 40));
    const score = Math.max(0, Math.min(100, ratioScore + persistenceBoost));
    const severity = (ratio >= 1.5 || score >= 80) ? 'critical' : 'warning';
    return { severity, ratio: Math.round(ratio * 100) / 100, score };
  }

  evaluateMissingReports(now = new Date()) {
    const schedules = db.listMissingReportSchedules();
    const nowMs = now.getTime();
    let created = 0;
    let escalated = 0;

    for (const schedule of schedules) {
      const latest = db.getDb().prepare(`
        SELECT recorded_at
        FROM monitoring_data
        WHERE location_id = ? AND type = ?
        ORDER BY recorded_at DESC
        LIMIT 1
      `).get(schedule.entity_id, schedule.type);

      const lastSubmission = latest?.recorded_at ? new Date(`${latest.recorded_at}Z`) : null;
      const fallbackBase = schedule.last_submission_at
        ? new Date(`${schedule.last_submission_at}Z`)
        : new Date(nowMs - (schedule.frequency_minutes + schedule.grace_minutes + 1) * 60000);
      const base = lastSubmission || fallbackBase;
      const dueAt = new Date(base.getTime() + schedule.frequency_minutes * 60000);
      const graceAt = new Date(dueAt.getTime() + schedule.grace_minutes * 60000);
      const escalationAt = new Date(graceAt.getTime() + schedule.escalation_minutes * 60000);

      db.touchScheduleHeartbeat(
        schedule.id,
        lastSubmission ? lastSubmission.toISOString().replace('T', ' ').slice(0, 19) : schedule.last_submission_at,
        dueAt.toISOString().replace('T', ' ').slice(0, 19)
      );

      const openEvent = db.getOpenMissingEventBySchedule(schedule.id);
      const isMissing = nowMs > graceAt.getTime();

      if (!isMissing) {
        if (openEvent) {
          db.updateMissingReportEvent(openEvent.id, {
            status: 'resolved',
            message: `Report received from ${schedule.location_name || 'location'} (${schedule.type})`
          });
        }
        continue;
      }

      const hoursOverdue = ((nowMs - dueAt.getTime()) / 3600000).toFixed(1);
      const baseMessage = `No ${schedule.type} report received from ${schedule.location_name || 'location'} for ${hoursOverdue} hours`;

      if (!openEvent) {
        db.createMissingReportEvent({
          schedule_id: schedule.id,
          entity_type: schedule.entity_type,
          entity_id: schedule.entity_id,
          type: schedule.type,
          status: 'new',
          severity: 'warning',
          reminder_level: 't_plus_0',
          message: baseMessage,
          due_at: dueAt.toISOString().replace('T', ' ').slice(0, 19),
          escalation_due_at: escalationAt.toISOString().replace('T', ' ').slice(0, 19),
          metadata_json: JSON.stringify({ location_name: schedule.location_name || null })
        });
        created++;
        continue;
      }

      if (nowMs > escalationAt.getTime() && openEvent.status !== 'escalation_candidate') {
        db.updateMissingReportEvent(openEvent.id, {
          status: 'escalation_candidate',
          severity: 'critical',
          reminder_level: 't_plus_2h',
          message: `${baseMessage}. Escalation candidate reached.`
        });
        escalated++;
      }
    }

    return { created, escalated };
  }

  runSlaEscalation(now = new Date()) {
    const criticalAlerts = db.getDb().prepare(`
      SELECT id, severity, status, first_triggered_at, created_at
      FROM compliance_alerts
      WHERE severity = 'critical'
        AND status IN ('open', 'new', 'acknowledged', 'in_action', 'escalated')
      ORDER BY id DESC
      LIMIT 500
    `).all();

    let level1 = 0;
    let level2 = 0;

    criticalAlerts.forEach(alert => {
      const baseTs = alert.first_triggered_at || alert.created_at;
      if (!baseTs) return;

      const base = new Date(`${baseTs}Z`);
      if (Number.isNaN(base.getTime())) return;
      const mins = Math.floor((now.getTime() - base.getTime()) / 60000);
      if (mins < 30) return;

      const existing = db.getEscalations(alert.id);
      const hasRegional = existing.some(e => e.to_role === 'regional_officer');
      const hasHigher = existing.some(e => e.to_role === 'higher_authority');

      if (mins >= 30 && !hasRegional) {
        db.createEscalation({
          alert_id: alert.id,
          from_role: 'system',
          to_role: 'regional_officer',
          note: 'Critical unresolved > 30 minutes (SLA L1)'
        });
        db.updateAlertStatus(alert.id, 'escalated', 'system');
        level1++;
      }

      if (mins >= 120 && !hasHigher) {
        db.createEscalation({
          alert_id: alert.id,
          from_role: 'system',
          to_role: 'higher_authority',
          note: 'Critical unresolved > 2 hours (SLA L2)'
        });
        db.updateAlertStatus(alert.id, 'escalated', 'system');
        level2++;
      }
    });

    return { level1, level2 };
  }

  evaluateBatch(dataBatch) {
    if (Object.keys(this.limits).length === 0) this.loadLimits();

    let newAlertsCount = 0;
    let updatedAlertsCount = 0;

    // Auto-close stale active alerts.
    db.getDb().prepare(`
      UPDATE compliance_alerts
      SET status = 'auto_closed', closed_at = datetime('now')
      WHERE status IN ('open', 'new', 'acknowledged', 'in_action', 'escalated')
        AND last_triggered_at IS NOT NULL
        AND datetime(last_triggered_at, '+${this.autoCloseMinutes} minutes') < datetime('now')
    `).run();

    dataBatch.forEach(reading => {
      const type = reading.type;
      const typeLimits = this.limits[type] || {};

      for (const [key, val] of Object.entries(reading)) {
        if (val === null || val === undefined) continue;
        
        const paramName = this.paramMap[key];
        if (!paramName) continue; // Skip if we don't map it to a limit

        const limit = typeLimits[paramName];
        if (!limit) continue; // No limit defined in DB

        let isViolation = false;
        let conditionStr = '';
        let threshold = 0;

        if (limit.limit_max !== null && val > limit.limit_max) {
          isViolation = true;
          conditionStr = 'exceeded';
          threshold = limit.limit_max;
        } else if (limit.limit_min !== null && val < limit.limit_min) {
          isViolation = true;
          conditionStr = 'fell below';
          threshold = limit.limit_min;
        }

        if (isViolation) {
          const existing = db.getLatestOpenAlertForKey(reading.location_id, reading.type, paramName);
          const severityInfo = this.computeSeverity(val, threshold, conditionStr, existing?.occurrence_count || 0);
          const message = `${paramName} ${conditionStr} limit (${threshold} ${limit.unit}) for ${Math.round(severityInfo.ratio * 100) / 100}x severity. Recorded ${val.toFixed(2)} ${limit.unit}`;
          const nowSql = new Date().toISOString().replace('T', ' ').slice(0, 19);
          const cooldownUntil = new Date(Date.now() + this.cooldownMinutes * 60000).toISOString().replace('T', ' ').slice(0, 19);
          const autoCloseAt = new Date(Date.now() + this.autoCloseMinutes * 60000).toISOString().replace('T', ' ').slice(0, 19);

          if (existing) {
            const existingLast = existing.last_triggered_at ? new Date(`${existing.last_triggered_at}Z`).getTime() : 0;
            const canCreateFresh = (Date.now() - existingLast) > this.cooldownMinutes * 60000;

            if (!canCreateFresh) {
              db.bumpAlertOccurrence(existing.id, {
                recorded_value: val,
                prescribed_limit: threshold,
                severity: severityInfo.severity,
                message,
                last_triggered_at: nowSql,
                cooldown_until: cooldownUntil,
                exceedance_ratio: severityInfo.ratio,
                severity_score: severityInfo.score,
                auto_close_at: autoCloseAt
              });
              db.logAlertTimeline({
                alert_id: existing.id,
                event_type: 'breach_repeat',
                title: 'Repeated breach observed',
                detail: `${paramName} remained above/below legal threshold`,
                actor_role: 'system',
                actor_id: 'compliance_engine',
                metadata: { ratio: severityInfo.ratio, score: severityInfo.score }
              });
              updatedAlertsCount++;
              return;
            }
          }

          db.createComplianceAlert({
            location_id: reading.location_id,
            industry_id: reading.industry_id || null,
            type: reading.type,
            parameter: paramName,
            recorded_value: val,
            prescribed_limit: threshold,
            severity: severityInfo.severity,
            status: 'new',
            message,
            source: 'limit_breach',
            first_triggered_at: nowSql,
            last_triggered_at: nowSql,
            cooldown_until: cooldownUntil,
            occurrence_count: 1,
            exceedance_ratio: severityInfo.ratio,
            severity_score: severityInfo.score,
            auto_close_at: autoCloseAt
          });
          newAlertsCount++;
        }
      }
    });

    const reminderStats = this.evaluateMissingReports();
    const escalationStats = this.runSlaEscalation();
    if (newAlertsCount > 0 || updatedAlertsCount > 0 || reminderStats.created > 0 || reminderStats.escalated > 0 || escalationStats.level1 > 0 || escalationStats.level2 > 0) {
      console.log(
        `[Compliance Engine] Alerts: +${newAlertsCount} new, ${updatedAlertsCount} updated. Missing reports: +${reminderStats.created} reminders, ${reminderStats.escalated} escalated. SLA escalations: L1 ${escalationStats.level1}, L2 ${escalationStats.level2}.`
      );
    }
  }
}

module.exports = new ComplianceEngine();
