/* ==========================================
   PrithviNet — Entity Management JS
   Fetches and renders master tables, handles
   basic CRUD operations via API.
   ========================================== */

(function() {
  'use strict';

  // API base
  const API_BASE = '/api/entities';

  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('panel-' + btn.dataset.target).classList.add('active');
    });
  });

  // State
  let officesData = [];
  let industriesData = [];
  let locationsData = [];

  // Init
  async function loadAllData() {
    try {
      const [offices, industries, locations] = await Promise.all([
        fetch(API_BASE + '/regional-offices').then(r => r.json()),
        fetch(API_BASE + '/industries').then(r => r.json()),
        fetch(API_BASE + '/monitoring-locations').then(r => r.json())
      ]);

      officesData = offices.data || [];
      industriesData = industries.data || [];
      locationsData = locations.data || [];

      renderOffices();
      renderIndustries();
      renderLocations();
    } catch (err) {
      console.error('Failed to load entity data:', err);
    }
  }

  function renderOffices() {
    const tbody = document.querySelector('#table-offices tbody');
    tbody.innerHTML = '';
    officesData.forEach(o => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${o.code}</strong></td>
        <td>${o.name}</td>
        <td>${o.district || '-'}</td>
        <td>${o.head_name || '-'}</td>
        <td>${o.lat}, ${o.lon}</td>
        <td class="actions">
          <button class="btn-edit" onclick="editEntity('office', ${o.id})">Edit</button>
          <button class="btn-del" onclick="deleteEntity('regional-offices', ${o.id})">Del</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  function renderIndustries() {
    const tbody = document.querySelector('#table-industries tbody');
    tbody.innerHTML = '';
    industriesData.forEach(i => {
      const tr = document.createElement('tr');
      // Category badge
      let catColor = '#64748b';
      if(i.category === 'red') catColor = '#ef4444';
      if(i.category === 'orange') catColor = '#f97316';
      if(i.category === 'green') catColor = '#10b981';

      tr.innerHTML = `
        <td><strong>${i.name}</strong></td>
        <td><span style="text-transform:capitalize">${i.type}</span></td>
        <td><span style="background:${catColor};color:white;padding:2px 6px;border-radius:4px;font-size:11px;text-transform:uppercase">${i.category}</span></td>
        <td>${i.ro_name || '-'}</td>
        <td>${i.consent_status}</td>
        <td class="actions">
          <button class="btn-edit" onclick="editEntity('industry', ${i.id})">Edit</button>
          <button class="btn-del" onclick="deleteEntity('industries', ${i.id})">Del</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  function renderLocations() {
    const tbody = document.querySelector('#table-locations tbody');
    tbody.innerHTML = '';
    locationsData.forEach(l => {
      const tr = document.createElement('tr');
      let typeIcon = l.type === 'air' ? '☁️ Air' : l.type === 'water' ? '💧 Water' : '🔊 Noise';
      tr.innerHTML = `
        <td><strong>${l.code || '-'}</strong></td>
        <td>${l.name}</td>
        <td>${typeIcon}</td>
        <td>${l.region || '-'}</td>
        <td>${l.lat}, ${l.lon}</td>
        <td class="actions">
          <button class="btn-edit" onclick="editEntity('location', ${l.id})">Edit</button>
          <button class="btn-del" onclick="deleteEntity('monitoring-locations', ${l.id})">Del</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  // Generic Delete
  window.deleteEntity = async function(endpoint, id) {
    if (!confirm('Are you sure you want to delete this entity?')) return;
    try {
      const res = await fetch(`${API_BASE}/${endpoint}/${id}`, { method: 'DELETE' });
      if (res.ok) {
        loadAllData();
      } else {
        alert('Failed to delete.');
      }
    } catch (e) {
      console.error(e);
      alert('Error occurred while deleting.');
    }
  };

  /* Modal Form Logic */
  const modal = document.getElementById('entity-modal');
  const modalTitle = document.getElementById('modal-title');
  const formFields = document.getElementById('dynamic-form-fields');
  const formId = document.getElementById('f-id');
  const formType = document.getElementById('f-entity-type');

  const schemas = {
    office: [
      { name: 'name', label: 'Name', type: 'text', req: true },
      { name: 'code', label: 'Code', type: 'text', req: true },
      { name: 'district', label: 'District', type: 'text' },
      { name: 'head_name', label: 'Head Officer Name', type: 'text' },
      { name: 'lat', label: 'Latitude', type: 'number' },
      { name: 'lon', label: 'Longitude', type: 'number' }
    ],
    industry: [
      { name: 'name', label: 'Industry Name', type: 'text', req: true },
      { name: 'type', label: 'Industry Type', type: 'text', placeholder: 'steel, textile, chemical' },
      { name: 'category', label: 'Category', type: 'select', options: ['red', 'orange', 'green'] },
      { name: 'consent_status', label: 'Consent Status', type: 'select', options: ['active', 'pending', 'expired'] },
      { name: 'lat', label: 'Latitude', type: 'number' },
      { name: 'lon', label: 'Longitude', type: 'number' }
    ],
    location: [
      { name: 'name', label: 'Location Name', type: 'text', req: true },
      { name: 'code', label: 'Station Code', type: 'text' },
      { name: 'type', label: 'Monitoring Type', type: 'select', options: ['air', 'water', 'noise'] },
      { name: 'region', label: 'Region / Ward', type: 'text' },
      { name: 'lat', label: 'Latitude', type: 'number', req: true },
      { name: 'lon', label: 'Longitude', type: 'number', req: true }
    ]
  };

  window.openModal = function(type, id = null) {
    formType.value = type;
    formId.value = id || '';
    modalTitle.textContent = id ? `Edit ${type}` : `Add New ${type}`;
    
    // Build form
    let html = '';
    const schema = schemas[type];
    let existingData = {};

    if (id) {
      if (type === 'office') existingData = officesData.find(o => o.id === id);
      else if (type === 'industry') existingData = industriesData.find(i => i.id === id);
      else if (type === 'location') existingData = locationsData.find(l => l.id === id);
    }

    schema.forEach(field => {
      const val = existingData && existingData[field.name] ? existingData[field.name] : '';
      html += `<div class="form-group"><label>${field.label}</label>`;
      
      if (field.type === 'select') {
        html += `<select name="${field.name}">`;
        field.options.forEach(opt => {
          html += `<option value="${opt}" ${val === opt ? 'selected' : ''}>${opt.toUpperCase()}</option>`;
        });
        html += `</select>`;
      } else {
        html += `<input type="${field.type === 'number' ? 'number' : 'text'}" step="any" name="${field.name}" value="${val}" ${field.req ? 'required' : ''} placeholder="${field.placeholder||''}" />`;
      }
      html += `</div>`;
    });

    formFields.innerHTML = html;
    modal.classList.add('active');
  };

  window.closeModal = function() {
    modal.classList.remove('active');
    document.getElementById('entity-form').reset();
  };

  window.editEntity = function(type, id) {
    openModal(type, id);
  };

  document.getElementById('entity-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const type = formType.value;
    const id = formId.value;
    const formData = new FormData(e.target);
    const data = Object.fromEntries(formData.entries());
    
    // Map internal type to endpoint
    let endpoint = '';
    if (type === 'office') endpoint = 'regional-offices';
    else if (type === 'industry') endpoint = 'industries';
    else if (type === 'location') endpoint = 'monitoring-locations';

    const url = id ? `${API_BASE}/${endpoint}/${id}` : `${API_BASE}/${endpoint}`;
    const method = id ? 'PUT' : 'POST';

    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      if (res.ok) {
        closeModal();
        loadAllData();
      } else {
        alert('Failed to save entity');
      }
    } catch (err) {
      console.error(err);
      alert('Error saving entity');
    }
  });

  // Role validation check (enforce client-side)
  function checkAccess() {
    const rolePermissions = window.PrithviNet ? window.PrithviNet.getPermissions() : null;
    if (rolePermissions && !rolePermissions.entities) {
      document.body.innerHTML = `
        <div style="padding: 50px; text-align: center; color: white;">
          <h2>Access Denied</h2>
          <p>Your current role does not have permission to view the Entity Management dashboard.</p>
          <a href="index.html" style="color: #00d4ff;">Return to Dashboard</a>
        </div>
      `;
    }
  }

  // Boot
  document.addEventListener('DOMContentLoaded', () => {
    window.addEventListener('prithvinet-role-change', checkAccess);
    setTimeout(checkAccess, 100); // initial check after roles.js runs
    loadAllData();
  });

})();
