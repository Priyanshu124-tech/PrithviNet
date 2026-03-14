'use strict';

const ROLES = {
  SUPER_ADMIN: 'super_admin',
  REGIONAL_OFFICER: 'regional_officer',
  MONITORING_TEAM: 'monitoring_team',
  INDUSTRY_USER: 'industry_user',
  CITIZEN: 'citizen'
};

function parseIntOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Mock auth context from headers/query/body for demo mode.
// Default role is super_admin to preserve existing non-auth flows.
function attachActor(req, _res, next) {
  const h = req.headers || {};
  const q = req.query || {};
  const b = req.body || {};

  const role = (h['x-role'] || q.as_role || b.as_role || ROLES.SUPER_ADMIN).toString().toLowerCase();

  req.actor = {
    role,
    userId: (h['x-user-id'] || q.as_user_id || b.as_user_id || '').toString() || 'demo-user',
    regionalOfficeId: parseIntOrNull(h['x-regional-office-id'] || q.as_regional_office_id || b.as_regional_office_id),
    industryId: parseIntOrNull(h['x-industry-id'] || q.as_industry_id || b.as_industry_id),
    teamId: parseIntOrNull(h['x-team-id'] || q.as_team_id || b.as_team_id)
  };

  next();
}

function hasRole(req, ...roles) {
  return !!req.actor && roles.includes(req.actor.role);
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!hasRole(req, ...roles)) {
      return res.status(403).json({
        status: 'error',
        message: `Role '${req.actor?.role || 'unknown'}' is not allowed for this operation`
      });
    }
    next();
  };
}

function isRegionalScoped(role) {
  return role === ROLES.REGIONAL_OFFICER || role === ROLES.MONITORING_TEAM;
}

function canAccessRegionalOffice(req, targetRegionalOfficeId) {
  if (req.actor?.role === ROLES.SUPER_ADMIN) return true;
  if (isRegionalScoped(req.actor?.role)) {
    if (!req.actor.regionalOfficeId) return false;
    return Number(req.actor.regionalOfficeId) === Number(targetRegionalOfficeId);
  }
  return false;
}

function canAccessIndustry(req, targetIndustryId) {
  if (req.actor?.role === ROLES.SUPER_ADMIN) return true;
  if (req.actor?.role === ROLES.INDUSTRY_USER) {
    if (!req.actor.industryId) return false;
    return Number(req.actor.industryId) === Number(targetIndustryId);
  }
  return false;
}

module.exports = {
  ROLES,
  attachActor,
  hasRole,
  requireRole,
  canAccessRegionalOffice,
  canAccessIndustry
};
