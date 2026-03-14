/* ==========================================
   PrithviNet — Mocked Role System
   ==========================================
   Provides a floating role-switcher widget
   for demo purposes. Persists selected role
   in localStorage. Other modules read the
   current role via window.PrithviNet.role
   ========================================== */

(function () {
  'use strict';

  // CRITICAL: Inject a blocking style IMMEDIATELY to prevent FOUC.
  // Elements with data-role-require are hidden until applyRole() explicitly shows them.
  const blockingStyle = document.createElement('style');
  blockingStyle.id = 'role-blocking-style';
  blockingStyle.textContent = '[data-role-require] { display: none !important; }';
  document.head.appendChild(blockingStyle);

  const ROLES = [
    { id: 'super_admin',      label: 'Super Admin',      icon: '👑', desc: 'State HQ — full access' },
    { id: 'regional_officer', label: 'Regional Officer',  icon: '🏛️', desc: 'Regional oversight' },
    { id: 'monitoring_team',  label: 'Monitoring Team',   icon: '📋', desc: 'Field data collection' },
    { id: 'industry_user',    label: 'Industry User',     icon: '🏭', desc: 'Submit compliance data' },
    { id: 'citizen',          label: 'Citizen',            icon: '👤', desc: 'Public transparency' }
  ];

  // Role-based visibility rules
  const ROLE_PERMISSIONS = {
    super_admin:      { entities: true,  compliance: true, copilot: true,  reports: true, alerts: true, dashboard: true, civic: true },
    regional_officer: { entities: true,  compliance: true, copilot: true,  reports: true, alerts: true, dashboard: true, civic: true },
    monitoring_team:  { entities: false, compliance: true, copilot: false, reports: true, alerts: true, dashboard: true, civic: false },
    industry_user:    { entities: false, compliance: true, copilot: false, reports: true, alerts: true, dashboard: true, civic: false },
    citizen:          { entities: false, compliance: false, copilot: false, reports: true, alerts: false, dashboard: true, civic: false }
  };

  const STORAGE_KEY = 'prithvinet_role';

  function getCurrentRole() {
    return localStorage.getItem(STORAGE_KEY) || 'super_admin';
  }

  function setRole(roleId) {
    localStorage.setItem(STORAGE_KEY, roleId);
    applyRole(roleId);
    updateToggleUI(roleId);

    // Dispatch custom event so other modules can react
    window.dispatchEvent(new CustomEvent('prithvinet-role-change', { detail: { role: roleId } }));
  }

  function getPermissions(roleId) {
    return ROLE_PERMISSIONS[roleId] || ROLE_PERMISSIONS.citizen;
  }

  function getRoleInfo(roleId) {
    return ROLES.find(r => r.id === roleId) || ROLES[0];
  }

  function getActorContext(roleId) {
    const role = roleId || getCurrentRole();
    const voterUid = localStorage.getItem('prithvinet_voter_uid') || ('citizen_' + Date.now().toString(36));
    if (!localStorage.getItem('prithvinet_voter_uid')) {
      localStorage.setItem('prithvinet_voter_uid', voterUid);
    }

    const defaults = {
      super_admin:      { userId: 'admin', regionalOfficeId: '', industryId: '', teamId: '' },
      regional_officer: { userId: 'ro_north', regionalOfficeId: '1', industryId: '', teamId: '' },
      monitoring_team:  { userId: 'team_alpha', regionalOfficeId: '1', industryId: '', teamId: '1' },
      industry_user:    { userId: 'industry_user_demo', regionalOfficeId: '', industryId: '1', teamId: '' },
      citizen:          { userId: voterUid, regionalOfficeId: '', industryId: '', teamId: '' }
    };

    return { role, ...(defaults[role] || defaults.citizen) };
  }

  function getAuthQuery(roleId) {
    const a = getActorContext(roleId);
    const params = new URLSearchParams();
    params.set('as_role', a.role);
    if (a.userId) params.set('as_user_id', a.userId);
    if (a.regionalOfficeId) params.set('as_regional_office_id', a.regionalOfficeId);
    if (a.industryId) params.set('as_industry_id', a.industryId);
    if (a.teamId) params.set('as_team_id', a.teamId);
    return params.toString();
  }

  function installFetchInterceptor() {
    if (window.__prithviFetchWrapped) return;
    window.__prithviFetchWrapped = true;

    const originalFetch = window.fetch.bind(window);
    window.fetch = function (input, init = {}) {
      try {
        const rawUrl = typeof input === 'string' ? input : (input && input.url ? input.url : '');
        const isApi = rawUrl.includes('/api/');
        if (!isApi) return originalFetch(input, init);

        const actor = getActorContext(getCurrentRole());
        const headers = new Headers(init.headers || (input && input.headers) || {});
        headers.set('x-role', actor.role);
        headers.set('x-user-id', actor.userId);
        if (actor.regionalOfficeId) headers.set('x-regional-office-id', actor.regionalOfficeId);
        if (actor.industryId) headers.set('x-industry-id', actor.industryId);
        if (actor.teamId) headers.set('x-team-id', actor.teamId);

        return originalFetch(input, { ...init, headers });
      } catch (_) {
        return originalFetch(input, init);
      }
    };
  }

  /** Apply role-based visibility to the DOM */
  function applyRole(roleId) {
    const perms = getPermissions(roleId);

    // Remove the blocking style now that we are explicitly managing visibility
    const bs = document.getElementById('role-blocking-style');
    if (bs) bs.remove();

    // Hide/show elements with data-role-require attribute
    document.querySelectorAll('[data-role-require]').forEach(el => {
      const required = el.dataset.roleRequire;
      if (perms[required]) {
        el.style.display = '';
        el.classList.remove('role-hidden');
      } else {
        el.style.display = 'none';
        el.classList.add('role-hidden');
      }
    });

    // Update role indicator in sidebar if present
    const indicator = document.getElementById('role-indicator');
    if (indicator) {
      const info = getRoleInfo(roleId);
      indicator.innerHTML = `${info.icon} <span>${info.label}</span>`;
    }

    // Add role class to body for CSS-based hiding
    document.body.className = document.body.className.replace(/role-\w+/g, '');
    document.body.classList.add('role-' + roleId);
  }

  /** Build the floating role-toggle widget */
  function createToggleWidget() {
    // Container
    const widget = document.createElement('div');
    widget.id = 'role-switcher';
    widget.className = 'role-switcher';

    // Collapsed button
    const trigger = document.createElement('button');
    trigger.className = 'role-trigger';
    trigger.title = 'Switch Demo Role';
    const currentInfo = getRoleInfo(getCurrentRole());
    trigger.innerHTML = `<span class="role-trigger-icon">${currentInfo.icon}</span><span class="role-trigger-label">${currentInfo.label}</span>`;
    trigger.addEventListener('click', () => {
      widget.classList.toggle('open');
    });
    widget.appendChild(trigger);

    // Dropdown
    const dropdown = document.createElement('div');
    dropdown.className = 'role-dropdown';

    const header = document.createElement('div');
    header.className = 'role-dropdown-header';
    header.textContent = 'SWITCH DEMO ROLE';
    dropdown.appendChild(header);

    ROLES.forEach(role => {
      const item = document.createElement('button');
      item.className = 'role-item' + (role.id === getCurrentRole() ? ' active' : '');
      item.dataset.role = role.id;
      item.innerHTML = `
        <span class="role-item-icon">${role.icon}</span>
        <div class="role-item-info">
          <div class="role-item-label">${role.label}</div>
          <div class="role-item-desc">${role.desc}</div>
        </div>
        <div class="role-item-check">✓</div>
      `;
      item.addEventListener('click', () => {
        setRole(role.id);
        dropdown.querySelectorAll('.role-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        // Close after short delay
        setTimeout(() => widget.classList.remove('open'), 250);
      });
      dropdown.appendChild(item);
    });

    widget.appendChild(dropdown);
    document.body.appendChild(widget);
  }

  function updateToggleUI(roleId) {
    const info = getRoleInfo(roleId);
    const trigger = document.querySelector('.role-trigger');
    if (trigger) {
      trigger.querySelector('.role-trigger-icon').textContent = info.icon;
      trigger.querySelector('.role-trigger-label').textContent = info.label;
    }
  }

  /** Inject styles for the role-switcher widget */
  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      /* ====== Role Switcher Widget ====== */
      .role-switcher {
        position: fixed;
        bottom: 20px;
        right: 20px;
        z-index: 10000;
        font-family: 'Inter', sans-serif;
      }

      .role-trigger {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 16px;
        background: linear-gradient(135deg, rgba(16, 185, 129, 0.9), rgba(59, 130, 246, 0.9));
        border: 1px solid rgba(255,255,255,0.15);
        border-radius: 50px;
        color: #fff;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        backdrop-filter: blur(12px);
        box-shadow: 0 4px 20px rgba(0,0,0,0.3), 0 0 40px rgba(16, 185, 129, 0.15);
        transition: all 0.3s ease;
        white-space: nowrap;
      }
      .role-trigger:hover {
        transform: translateY(-2px);
        box-shadow: 0 6px 28px rgba(0,0,0,0.4), 0 0 50px rgba(16, 185, 129, 0.25);
      }
      .role-trigger-icon {
        font-size: 18px;
      }
      .role-trigger-label {
        font-size: 12px;
        letter-spacing: 0.5px;
        text-transform: uppercase;
      }

      .role-dropdown {
        position: absolute;
        bottom: calc(100% + 8px);
        right: 0;
        width: 280px;
        background: rgba(15, 23, 42, 0.97);
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 16px;
        padding: 8px;
        opacity: 0;
        transform: translateY(10px) scale(0.95);
        pointer-events: none;
        transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
        backdrop-filter: blur(20px);
        box-shadow: 0 12px 40px rgba(0,0,0,0.5);
      }
      .role-switcher.open .role-dropdown {
        opacity: 1;
        transform: translateY(0) scale(1);
        pointer-events: auto;
      }

      .role-dropdown-header {
        padding: 10px 12px 6px;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 1.5px;
        color: rgba(148, 163, 184, 0.7);
      }

      .role-item {
        display: flex;
        align-items: center;
        gap: 10px;
        width: 100%;
        padding: 10px 12px;
        border: none;
        background: transparent;
        border-radius: 10px;
        cursor: pointer;
        text-align: left;
        color: #cbd5e1;
        transition: all 0.15s ease;
      }
      .role-item:hover {
        background: rgba(255,255,255,0.06);
        color: #f1f5f9;
      }
      .role-item.active {
        background: rgba(16, 185, 129, 0.12);
        color: #10b981;
      }
      .role-item-icon {
        font-size: 20px;
        width: 28px;
        text-align: center;
        flex-shrink: 0;
      }
      .role-item-info {
        flex: 1;
        min-width: 0;
      }
      .role-item-label {
        font-size: 13px;
        font-weight: 600;
      }
      .role-item-desc {
        font-size: 10px;
        color: #64748b;
        margin-top: 1px;
      }
      .role-item.active .role-item-desc {
        color: rgba(16, 185, 129, 0.6);
      }
      .role-item-check {
        font-size: 14px;
        color: #10b981;
        opacity: 0;
        transition: opacity 0.15s;
      }
      .role-item.active .role-item-check {
        opacity: 1;
      }

      /* Role indicator in sidebar */
      #role-indicator {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 10px;
        font-size: 10px;
        font-weight: 600;
        letter-spacing: 0.5px;
        color: #94a3b8;
        text-transform: uppercase;
      }
      #role-indicator span {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      /* Utility: hide elements not permitted for current role */
      .role-hidden {
        display: none !important;
      }

      /* Close dropdown when clicking outside */
      @media (max-width: 768px) {
        .role-switcher {
          bottom: 12px;
          right: 12px;
        }
        .role-dropdown {
          width: 250px;
        }
      }
    `;
    document.head.appendChild(style);
  }

  // Public API
  window.PrithviNet = window.PrithviNet || {};
  window.PrithviNet.role = getCurrentRole;
  window.PrithviNet.setRole = setRole;
  window.PrithviNet.getPermissions = () => getPermissions(getCurrentRole());
  window.PrithviNet.getRoleInfo = () => getRoleInfo(getCurrentRole());
  window.PrithviNet.getActorContext = () => getActorContext(getCurrentRole());
  window.PrithviNet.getAuthQuery = () => getAuthQuery(getCurrentRole());
  window.PrithviNet.ROLES = ROLES;

  installFetchInterceptor();

  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    const widget = document.getElementById('role-switcher');
    if (widget && !widget.contains(e.target)) {
      widget.classList.remove('open');
    }
  });

  // Apply role IMMEDIATELY on script parse — don't wait for DOMContentLoaded.
  // This prevents the flash where restricted elements appear then disappear.
  applyRole(getCurrentRole());

  // Init widget and re-apply on DOM ready (safety net for late-parsed elements)
  document.addEventListener('DOMContentLoaded', () => {
    injectStyles();
    createToggleWidget();
    applyRole(getCurrentRole());
  });

})();
