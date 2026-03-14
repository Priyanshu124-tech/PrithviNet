/* ==========================================
   PrithviNet Dashboard Copilot Widget
   ========================================== */

(function () {
  'use strict';

  function el(id) {
    return document.getElementById(id);
  }

  function nowTime() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function textFromNode(node) {
    return (node ? node.textContent : '').replace(/\s+/g, ' ').trim();
  }

  function normalizeName(value) {
    return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  async function buildIndustryLookup() {
    try {
      const resp = await fetch('/api/entities/industries');
      const json = await resp.json();
      if (!json || json.status !== 'ok' || !Array.isArray(json.data)) return [];
      return json.data
        .filter(item => item && item.name && item.id != null)
        .map(item => ({ id: item.id, key: normalizeName(item.name) }));
    } catch (_) {
      return [];
    }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    const root = el('dashboard-copilot');
    const toggleBtn = el('dashboard-copilot-toggle');
    const panel = el('dashboard-copilot-panel');
    const closeBtn = el('dashboard-copilot-close');
    const form = el('dashboard-copilot-form');
    const input = el('dashboard-copilot-input');
    const sendBtn = el('dashboard-copilot-send');
    const messages = el('dashboard-copilot-messages');
    const typing = el('dashboard-copilot-typing');

    if (!root || !toggleBtn || !panel || !form || !input || !sendBtn || !messages || !typing) {
      return;
    }

    function hasCopilotAccess() {
      const perms = (window.PrithviNet && window.PrithviNet.getPermissions)
        ? window.PrithviNet.getPermissions()
        : { copilot: true };
      return !!perms.copilot;
    }

    function applyRoleVisibility() {
      if (!hasCopilotAccess()) {
        root.style.display = 'none';
        closePanel();
        return;
      }
      root.style.display = '';
    }

    function openPanel() {
      panel.hidden = false;
      toggleBtn.setAttribute('aria-expanded', 'true');
      setTimeout(() => input.focus(), 20);
    }

    function closePanel() {
      panel.hidden = true;
      toggleBtn.setAttribute('aria-expanded', 'false');
    }

    function appendMessage(kind, value) {
      const msg = document.createElement('div');
      msg.className = 'dashboard-copilot-msg ' + kind;

      const bubble = document.createElement('div');
      bubble.className = 'dashboard-copilot-bubble';

      if (kind === 'bot' && window.marked && typeof window.marked.parse === 'function') {
        bubble.innerHTML = window.marked.parse(value || '');
      } else {
        bubble.textContent = value || '';
      }

      const meta = document.createElement('div');
      meta.className = 'dashboard-copilot-meta';
      meta.textContent = (kind === 'user' ? 'You' : 'Copilot') + ' - ' + nowTime();

      msg.appendChild(bubble);
      msg.appendChild(meta);
      messages.appendChild(msg);
      messages.scrollTop = messages.scrollHeight;
    }

    function setBusy(isBusy) {
      typing.hidden = !isBusy;
      input.disabled = isBusy;
      sendBtn.disabled = isBusy || !input.value.trim();
      if (isBusy) messages.scrollTop = messages.scrollHeight;
    }

    function autosizeInput() {
      input.style.height = 'auto';
      const nextHeight = Math.min(input.scrollHeight, 110);
      input.style.height = String(nextHeight) + 'px';
      sendBtn.disabled = !input.value.trim() || input.disabled;
    }

    let industryLookup = [];
    industryLookup = await buildIndustryLookup();

    function inferLocationId() {
      const selectedLabel = textFromNode(el('fc-location-name'));
      if (!selectedLabel) return 1;

      const key = normalizeName(selectedLabel);
      const exact = industryLookup.find(item => item.key === key);
      if (exact) return Number(exact.id) || 1;

      const fuzzy = industryLookup.find(item => key.includes(item.key) || item.key.includes(key));
      if (fuzzy) return Number(fuzzy.id) || 1;

      return 1;
    }

    toggleBtn.addEventListener('click', () => {
      if (panel.hidden) openPanel();
      else closePanel();
    });

    if (closeBtn) {
      closeBtn.addEventListener('click', closePanel);
    }

    window.addEventListener('prithvinet-role-change', () => {
      applyRoleVisibility();
    });

    input.addEventListener('input', autosizeInput);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        if (!sendBtn.disabled) {
          form.dispatchEvent(new Event('submit'));
        }
      }
    });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text || !hasCopilotAccess()) return;

      appendMessage('user', text);
      input.value = '';
      autosizeInput();
      setBusy(true);

      try {
        const locationId = inferLocationId();
        const response = await fetch('/api/copilot/ask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: text,
            location_id: locationId
          })
        });

        const data = await response.json();
        if (response.ok && data && data.status === 'ok') {
          appendMessage('bot', data.text || 'No response received.');
        } else {
          appendMessage('bot', 'Copilot is unavailable right now. Please try again shortly.');
        }
      } catch (_) {
        appendMessage('bot', 'Connection error while contacting Copilot.');
      } finally {
        setBusy(false);
        autosizeInput();
        input.focus();
      }
    });

    applyRoleVisibility();
    closePanel();
    autosizeInput();
  });
})();
