// JARVIS COMMAND CENTER - MAIN FRONTEND LOGIC & OTA MANAGER

const NATIVE_VERSION = "1.0.0";

// --- STATE MANAGEMENT ---
const state = {
  activeView: 'accueil',
  backendUrl: localStorage.getItem('jarvis_backend_url') || '',
  token: localStorage.getItem('jarvis_token') || '',
  status: 'offline',
  statusData: null,
  chatHistory: [],
  operations: [],
  services: [],
  tasks: [],
  plan: [],
  memory: null,
  skills: [],
  models: null,
  reflection: null,
  system: null,
  settings: null,
  rawCatalogModels: [],
  ota: {
    activeVersion: localStorage.getItem('jarvis_ota_active_version') || '1.0.0',
    previousVersion: localStorage.getItem('jarvis_ota_previous_version') || null,
    lastCheck: localStorage.getItem('jarvis_ota_last_check') || 'Jamais',
    autoCheck: localStorage.getItem('jarvis_ota_auto_check') !== 'false',
  },
};

// --- DOM ELEMENTS ---
const elements = {
  sidebar: document.getElementById('sidebar'),
  sidebarOverlay: document.getElementById('sidebar-overlay'),
  btnHamburger: document.getElementById('btn-hamburger'),
  headerTitle: document.getElementById('header-title'),
  statusBadge: document.getElementById('status-badge'),
  statusText: document.getElementById('status-text'),
  navItems: document.querySelectorAll('.nav-item'),
  sections: document.querySelectorAll('.view-section'),
  otaBanner: document.getElementById('ota-banner'),
};

// --- API HELPER FUNCTIONS ---
function getApiUrl(endpoint) {
  const base = state.backendUrl.trim().replace(/\/+$/, '');
  return `${base}${endpoint}`;
}

async function fetchApi(endpoint, options = {}) {
  const url = getApiUrl(endpoint);
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  if (state.token) {
    headers['Authorization'] = `Bearer ${state.token}`;
  }

  try {
    const response = await fetch(url, { ...options, headers });
    if (response.status === 401) {
      updateStatusBadge(false, 'Non autorisé');
      throw new Error('Authentification requise (token invalide ou manquant)');
    }
    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || `Erreur HTTP ${response.status}`);
    }
    const data = await response.json();
    updateStatusBadge(true, 'En ligne');
    return data;
  } catch (err) {
    updateStatusBadge(false, 'Hors ligne');
    throw err;
  }
}

function updateStatusBadge(online, label) {
  state.status = online ? 'online' : 'offline';
  if (online) {
    elements.statusBadge.classList.remove('offline');
    elements.statusText.textContent = label || 'En ligne';
  } else {
    elements.statusBadge.classList.add('offline');
    elements.statusText.textContent = label || 'Hors ligne';
  }
}

// --- OTA MANAGER ---
async function computeSha256(text) {
  const msgUint8 = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function checkOtaUpdates(isManual = false) {
  state.ota.lastCheck = new Date().toLocaleString();
  localStorage.setItem('jarvis_ota_last_check', state.ota.lastCheck);

  try {
    const manifest = await fetchApi('/api/ota/manifest');

    if (manifest.minimumNativeVersion && compareVersions(manifest.minimumNativeVersion, NATIVE_VERSION) > 0) {
      if (isManual) {
        alert(`Cette mise à jour (version native requise : ${manifest.minimumNativeVersion}) nécessite de télécharger un nouvel APK Android.`);
      }
      return null;
    }

    if (compareVersions(manifest.version, state.ota.activeVersion) > 0) {
      showOtaBanner(manifest);
      return manifest;
    } else if (isManual) {
      alert(`Votre Jarvis Command Center est déjà à jour (version OTA active : v${state.ota.activeVersion}).`);
    }
  } catch (err) {
    if (isManual) alert(`Impossible de vérifier les mises à jour OTA : ${err.message}`);
  }
  return null;
}

function compareVersions(v1, v2) {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);
  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  return 0;
}

function showOtaBanner(manifest) {
  if (!elements.otaBanner) return;
  elements.otaBanner.style.display = 'flex';
  elements.otaBanner.innerHTML = `
    <div>
      <strong style="color: var(--text-main);">🚀 Mise à jour OTA v${manifest.version} disponible !</strong>
      <div style="font-size: 0.85rem; color: var(--text-muted);">${manifest.releaseNotes}</div>
    </div>
    <div style="display: flex; gap: 8px;">
      <button class="btn btn-primary btn-sm" onclick="applyOtaUpdate('${manifest.version}')">Mettre à jour</button>
      <button class="btn btn-secondary btn-sm" onclick="closeOtaBanner()">Plus tard</button>
    </div>
  `;
}

function closeOtaBanner() {
  if (elements.otaBanner) elements.otaBanner.style.display = 'none';
}

async function applyOtaUpdate(version) {
  try {
    const manifest = await fetchApi('/api/ota/manifest');

    const bundleUrl = getApiUrl('/api/ota/bundle');
    const headers = {};
    if (state.token) {
      headers['Authorization'] = `Bearer ${state.token}`;
    }
    const response = await fetch(bundleUrl, { headers });
    if (!response.ok) {
      throw new Error(`Erreur HTTP ${response.status} lors du téléchargement du bundle OTA.`);
    }
    const bundleString = await response.text();

    if (manifest.sha256) {
      const computedHash = await computeSha256(bundleString);
      if (computedHash.toLowerCase() !== manifest.sha256.toLowerCase()) {
        alert('⚠️ Échec de vérification SHA-256 : le bundle téléchargé semble altéré. Mise à jour annulée.');
        return;
      }
    }

    const bundleData = JSON.parse(bundleString);
    if (!bundleData || !bundleData.files) {
      throw new Error('Bundle OTA invalide ou corrompu.');
    }

    localStorage.setItem('jarvis_ota_previous_version', state.ota.activeVersion);
    localStorage.setItem('jarvis_ota_previous_bundle', localStorage.getItem('jarvis_ota_active_bundle') || '');

    localStorage.setItem('jarvis_ota_active_version', manifest.version);
    localStorage.setItem('jarvis_ota_active_bundle', bundleString);

    state.ota.previousVersion = state.ota.activeVersion;
    state.ota.activeVersion = manifest.version;

    alert(`✅ Mise à jour OTA v${manifest.version} installée avec succès !`);
    window.location.reload();
  } catch (err) {
    alert(`Erreur lors de l'installation de la mise à jour OTA : ${err.message}`);
  }
}

function rollbackOtaUpdate() {
  const prevVersion = localStorage.getItem('jarvis_ota_previous_version');
  const prevBundle = localStorage.getItem('jarvis_ota_previous_bundle');

  if (!prevVersion) {
    alert('Aucune version précédente disponible pour le rollback.');
    return;
  }

  if (confirm(`Voulez-vous vraiment revenir à la version précédente (v${prevVersion}) ?`)) {
    localStorage.setItem('jarvis_ota_active_version', prevVersion);
    if (prevBundle) {
      localStorage.setItem('jarvis_ota_active_bundle', prevBundle);
    } else {
      localStorage.removeItem('jarvis_ota_active_bundle');
    }

    localStorage.removeItem('jarvis_ota_previous_version');
    localStorage.removeItem('jarvis_ota_previous_bundle');

    alert(`✅ Rollback effectué. Retour à la version v${prevVersion}.`);
    window.location.reload();
  }
}

// --- NAVIGATION LOGIC ---
function switchView(viewName) {
  state.activeView = viewName;

  elements.navItems.forEach((item) => {
    if (item.getAttribute('data-view') === viewName) {
      item.classList.add('active');
      const title = item.querySelector('span:last-child').textContent;
      elements.headerTitle.textContent = title;
    } else {
      item.classList.remove('active');
    }
  });

  elements.sections.forEach((sec) => {
    if (sec.id === `view-${viewName}`) {
      sec.classList.add('active');
    } else {
      sec.classList.remove('active');
    }
  });

  elements.sidebar.classList.remove('open');
  elements.sidebarOverlay.classList.remove('active');

  loadViewData(viewName);
}

function initNavigation() {
  elements.btnHamburger.addEventListener('click', () => {
    elements.sidebar.classList.toggle('open');
    elements.sidebarOverlay.classList.toggle('active');
  });

  elements.sidebarOverlay.addEventListener('click', () => {
    elements.sidebar.classList.remove('open');
    elements.sidebarOverlay.classList.remove('active');
  });

  elements.navItems.forEach((item) => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const view = item.getAttribute('data-view');
      switchView(view);
    });
  });
}

// --- DATA LOADERS FOR 11 VIEWS ---
async function loadViewData(viewName) {
  try {
    switch (viewName) {
      case 'accueil':
        await renderAccueilView();
        break;
      case 'chat':
        renderChatView();
        break;
      case 'operations':
        await renderOperationsView();
        break;
      case 'services':
        await renderServicesView();
        break;
      case 'tasks':
        await renderTasksView();
        break;
      case 'memory':
        await renderMemoryView();
        break;
      case 'skills':
        await renderSkillsView();
        break;
      case 'models':
        await renderModelsView();
        break;
      case 'reflection':
        await renderReflectionView();
        break;
      case 'system':
        await renderSystemView();
        break;
      case 'settings':
        renderSettingsView();
        break;
    }
  } catch (err) {
    console.error(`Erreur chargement vue ${viewName}:`, err);
  }
}

// 1. ACCUEIL VIEW
async function renderAccueilView() {
  const container = document.getElementById('view-accueil');
  container.innerHTML = `<div class="card"><div class="card-title">Chargement des données...</div></div>`;

  try {
    const status = await fetchApi('/api/status');
    state.statusData = status;

    container.innerHTML = `
      <div class="card-grid">
        <div class="card">
          <div class="card-title">État Jarvis</div>
          <div class="card-value" style="color: var(--accent-success);">🟢 En Ligne</div>
          <div class="card-subtext">Version OTA : v${state.ota.activeVersion} (Native: v${NATIVE_VERSION})</div>
        </div>
        <div class="card">
          <div class="card-title">Modèle IA Actif</div>
          <div class="card-value">${status.llmModel}</div>
          <div class="card-subtext">Fournisseur : ${status.llmProvider}</div>
        </div>
        <div class="card">
          <div class="card-title">Services externes</div>
          <div class="card-value">${status.servicesCount.enabled} / ${status.servicesCount.total}</div>
          <div class="card-subtext">Services configurés & actifs</div>
        </div>
        <div class="card">
          <div class="card-title">Opérations en cours</div>
          <div class="card-value">${status.operationsCount.inProgress + status.operationsCount.waitingInput}</div>
          <div class="card-subtext">${status.operationsCount.waitingInput} en attente de réponse</div>
        </div>
        <div class="card">
          <div class="card-title">Tâches personnelles</div>
          <div class="card-value">${status.remainingTasks}</div>
          <div class="card-subtext">Rappels / tâches à faire</div>
        </div>
        <div class="card">
          <div class="card-title">Mémoire Active</div>
          <div class="card-value">${status.memory.factsCount} faits</div>
          <div class="card-subtext">${status.memory.workingCount} messages récents</div>
        </div>
      </div>

      <div class="card" style="margin-top: 20px;">
        <div class="card-title">Actions Rapides</div>
        <div style="display: flex; gap: 12px; flex-wrap: wrap; margin-top: 8px;">
          <button class="btn btn-primary" onclick="switchView('chat')">💬 Parler à Jarvis</button>
          <button class="btn btn-secondary" onclick="switchView('operations')">⚡ Voir les Opérations</button>
          <button class="btn btn-secondary" onclick="switchView('services')">🔌 Voir les Services</button>
        </div>
      </div>
    `;
  } catch (err) {
    container.innerHTML = `
      <div class="card" style="border-color: var(--accent-danger);">
        <div class="card-title" style="color: var(--accent-danger);">Jarvis Inaccessible</div>
        <div class="card-subtext">${err.message}</div>
      </div>
    `;
  }
}

// 2. CHAT VIEW
function renderChatView() {
  const container = document.getElementById('view-chat');
  if (container.children.length > 0) return;

  container.innerHTML = `
    <div style="display: flex; flex-direction: column; height: calc(100vh - 120px); gap: 16px;">
      <div id="chat-messages" style="flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; padding-right: 8px;">
        <div class="msg agent" style="background: var(--bg-card); padding: 14px 18px; border-radius: 12px; border: 1px solid var(--border-color); max-width: 85%;">
          Bonjour, je suis <strong>Jarvis Command Center</strong>. Comment puis-je vous aider aujourd'hui ?
        </div>
      </div>
      <form id="chat-form" style="display: flex; gap: 12px; background: var(--bg-card); padding: 12px; border-radius: 16px; border: 1px solid var(--border-color);">
        <textarea id="chat-input" class="input-field" rows="1" placeholder="Posez une question ou demandez une action..." style="resize: none; flex: 1;"></textarea>
        <button type="submit" id="chat-send" class="btn btn-primary" style="min-width: 100px;">Envoyer</button>
      </form>
    </div>
  `;

  const form = document.getElementById('chat-form');
  const input = document.getElementById('chat-input');
  const sendButton = document.getElementById('chat-send');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (sendButton.disabled) return;

    const text = input.value.trim();
    if (!text) return;

    input.value = '';
    input.disabled = true;
    sendButton.disabled = true;
    sendButton.textContent = 'Envoi...';

    appendChatMessage('user', text);
    const pendingEl = appendChatMessage('agent pending', 'Jarvis is thinking...');

    try {
      const res = await fetchApi('/api/chat', {
        method: 'POST',
        body: JSON.stringify({ message: text }),
      });

      if (pendingEl) pendingEl.remove();
      appendChatMessage('agent', res.response);
    } catch (err) {
      if (pendingEl) pendingEl.remove();
      appendChatMessage('agent error', `⚠️ Erreur : ${err.message}`);
    } finally {
      input.disabled = false;
      sendButton.disabled = false;
      sendButton.textContent = 'Envoyer';
      input.focus();
    }
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.dispatchEvent(new Event('submit'));
    }
  });
}

function appendChatMessage(role, text) {
  const box = document.getElementById('chat-messages');
  if (!box) return null;

  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.style.cssText = `
    padding: 14px 18px;
    border-radius: 14px;
    max-width: 85%;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  `;

  if (role.includes('user')) {
    div.style.alignSelf = 'flex-end';
    div.style.backgroundColor = 'var(--accent-primary)';
    div.style.color = '#ffffff';
  } else {
    div.style.alignSelf = 'flex-start';
    div.style.backgroundColor = 'var(--bg-card)';
    div.style.border = '1px solid var(--border-color)';
    div.style.color = 'var(--text-main)';
  }

  div.textContent = text;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}

// 3. OPÉRATIONS VIEW
async function renderOperationsView() {
  const container = document.getElementById('view-operations');
  container.innerHTML = `<div class="card"><div class="card-title">Chargement des opérations...</div></div>`;

  try {
    const opsData = await fetchApi('/api/operations');
    const ops = Array.isArray(opsData) ? opsData : Array.isArray(opsData?.operations) ? opsData.operations : [];

    container.innerHTML = `
      <h2>Opérations Externe / Service Tasks</h2>
      <div style="display: flex; flex-direction: column; gap: 12px; margin-top: 12px;">
        ${ops.length === 0 ? '<div class="card"><div class="card-subtext">Aucune opération enregistrée.</div></div>' : ops.map((op) => `
          <div class="card">
            <div style="display: flex; justify-content: space-between;">
              <span class="badge badge-info">${op.status}</span>
              <span style="font-size: 0.8rem; color: var(--text-muted);">${new Date(op.createdAt).toLocaleString()}</span>
            </div>
            <div style="font-size: 1.1rem; font-weight: 600;">${op.objective}</div>
            <div style="font-size: 0.9rem; color: var(--text-muted);">Capacité: ${op.capability} | Service: ${op.selectedService}</div>
          </div>
        `).join('')}
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<div class="card" style="border-color: var(--accent-danger);"><div class="card-title" style="color: var(--accent-danger);">${err.message}</div></div>`;
  }
}

// 4. SERVICES VIEW
async function renderServicesView() {
  const container = document.getElementById('view-services');
  container.innerHTML = `<div class="card"><div class="card-title">Chargement des services...</div></div>`;

  try {
    const servicesData = await fetchApi('/api/services');
    const services = Array.isArray(servicesData) ? servicesData : Array.isArray(servicesData?.services) ? servicesData.services : [];

    container.innerHTML = `
      <h2>Registre des Services Extérieurs</h2>
      <div class="card-grid" style="margin-top: 12px;">
        ${services.length === 0 ? '<div class="card"><div class="card-subtext">Aucun service enregistré.</div></div>' : services.map((s) => `
          <div class="card">
            <div style="display: flex; justify-content: space-between;">
              <span class="card-title">${s.name}</span>
              <span class="badge ${s.enabled ? 'badge-success' : 'badge-danger'}">${s.enabled ? 'ACTIF' : 'DÉSACTIVÉ'}</span>
            </div>
            <div style="font-size: 0.9rem; color: var(--text-muted);">Endpoint: <code>${s.endpoint}</code></div>
          </div>
        `).join('')}
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<div class="card" style="border-color: var(--accent-danger);"><div class="card-title" style="color: var(--accent-danger);">${err.message}</div></div>`;
  }
}

// 5. TÂCHES & PLANS VIEW
async function renderTasksView() {
  const container = document.getElementById('view-tasks');
  container.innerHTML = `<div class="card"><div class="card-title">Chargement des tâches...</div></div>`;

  try {
    const tasksData = await fetchApi('/api/tasks');
    const tasks = Array.isArray(tasksData) ? tasksData : Array.isArray(tasksData?.tasks) ? tasksData.tasks : [];

    container.innerHTML = `
      <h2>Tâches Personnelles & Plans</h2>
      <div class="card" style="margin-top: 12px;">
        <div class="card-title">Liste des Tâches</div>
        <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 8px;">
          ${tasks.length === 0 ? '<div style="color: var(--text-muted);">Aucune tâche.</div>' : tasks.map((t) => `
            <div style="padding: 10px; background: var(--bg-dark); border-radius: 8px;">
              ${t.title}
            </div>
          `).join('')}
        </div>
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<div class="card" style="border-color: var(--accent-danger);"><div class="card-title" style="color: var(--accent-danger);">${err.message}</div></div>`;
  }
}

// 6. MÉMOIRE VIEW
async function renderMemoryView() {
  const container = document.getElementById('view-memory');
  container.innerHTML = `<div class="card"><div class="card-title">Chargement de la mémoire...</div></div>`;

  try {
    const memory = await fetchApi('/api/memory');
    const facts = Array.isArray(memory?.facts) ? memory.facts : [];

    container.innerHTML = `
      <h2>Gestion de la Mémoire</h2>
      <div class="card" style="margin-top: 12px;">
        <div class="card-title">Faits Connus</div>
        <div style="margin-top: 8px;">
          ${facts.length === 0 ? 'Aucun fait enregistré.' : facts.map((f) => `<div>${f.entity}.${f.attribute} = ${f.value}</div>`).join('')}
        </div>
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<div class="card" style="border-color: var(--accent-danger);"><div class="card-title" style="color: var(--accent-danger);">${err.message}</div></div>`;
  }
}

// 7. SKILLS VIEW
async function renderSkillsView() {
  const container = document.getElementById('view-skills');
  container.innerHTML = `<div class="card"><div class="card-title">Chargement des skills...</div></div>`;

  try {
    const skillsData = await fetchApi('/api/skills');
    const skills = Array.isArray(skillsData) ? skillsData : Array.isArray(skillsData?.skills) ? skillsData.skills : [];

    container.innerHTML = `
      <h2>Compétences Internes (Skills)</h2>
      <div class="card-grid" style="margin-top: 12px;">
        ${skills.length === 0 ? '<div class="card"><div class="card-subtext">Aucun skill trouvé.</div></div>' : skills.map((s) => `
          <div class="card">
            <span class="card-title" style="color: var(--accent-primary);">${s.name}</span>
            <div>${s.description}</div>
          </div>
        `).join('')}
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<div class="card" style="border-color: var(--accent-danger);"><div class="card-title" style="color: var(--accent-danger);">${err.message}</div></div>`;
  }
}

// 8. MODÈLES IA VIEW (BULLETPROOF & SAFE ARRAY CONTRACTS)
async function renderModelsView() {
  const container = document.getElementById('view-models');
  container.innerHTML = `<div class="card"><div class="card-title">Chargement des fournisseurs...</div></div>`;

  try {
    const modelsData = await fetchApi('/api/models');
    state.models = modelsData || {};

    const activeProvider = modelsData?.activeProvider || 'non défini';
    const activeModel = modelsData?.activeModel || 'non défini';

    const providers = Array.isArray(modelsData?.providers)
      ? modelsData.providers
      : Array.isArray(modelsData?.data?.providers)
      ? modelsData.data.providers
      : [];

    container.innerHTML = `
      <h2>Panneau de Contrôle Modèles IA</h2>

      <div class="card-grid" style="margin-top: 12px;">
        <div class="card">
          <div class="card-title">Fournisseur IA Actif</div>
          <div id="active-provider-display" class="card-value" style="color: var(--accent-primary);">${activeProvider}</div>
        </div>
        <div class="card">
          <div class="card-title">Modèle LLM Sélectionné</div>
          <div id="active-model-display" class="card-value" style="font-size: 1.4rem;">${activeModel}</div>
        </div>
      </div>

      <div class="card" style="margin-top: 16px;">
        <div class="card-title">Sélection du Fournisseur & du Modèle</div>

        <div class="form-group" style="margin-top: 12px;">
          <label class="form-label">Fournisseur IA</label>
          <div style="display: flex; align-items: center; gap: 12px;">
            <select id="select-provider" class="input-field" style="flex: 1;">
              ${providers.length === 0 ? '<option value="">Aucun fournisseur disponible</option>' : providers.map((p) => `
                <option value="${p.id}" ${p.id === activeProvider ? 'selected' : ''}>
                  ${p.name} ${p.available ? '🟢 (Configuré)' : '🔴 (Non configuré)'}
                </option>
              `).join('')}
            </select>
            <span id="provider-status-badge" class="badge badge-success">Configuré</span>
          </div>
        </div>

        <div class="form-group" style="margin-top: 12px;">
          <label class="form-label">Modèle à utiliser</label>
          <select id="select-model" class="input-field">
            <option value="">Chargement des modèles...</option>
          </select>
        </div>

        <div id="openrouter-filter-container" style="display: none; margin-top: 8px;">
          <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; color: var(--text-muted); font-size: 0.9rem;">
            <input type="checkbox" id="filter-free-models" />
            <span>Modèles gratuits uniquement</span>
          </label>
        </div>

        <div style="display: flex; gap: 12px; margin-top: 16px;">
          <button id="btn-test-model" class="btn btn-secondary">🧪 Tester</button>
          <button id="btn-apply-model" class="btn btn-primary">✅ Appliquer</button>
        </div>

        <div id="model-status-box" style="margin-top: 12px;"></div>
      </div>
    `;

    const selectProv = document.getElementById('select-provider');
    const freeCheckbox = document.getElementById('filter-free-models');
    const freeContainer = document.getElementById('openrouter-filter-container');

    const updateProviderBadge = () => {
      const selected = selectProv?.value;
      const provInfo = providers.find((p) => p && p.id === selected);
      const badge = document.getElementById('provider-status-badge');
      if (badge) {
        if (provInfo && provInfo.available) {
          badge.className = 'badge badge-success';
          badge.textContent = '🟢 Configuré';
        } else {
          badge.className = 'badge badge-danger';
          badge.textContent = '🔴 Non configuré';
        }
      }
      if (freeContainer) {
        freeContainer.style.display = selected === 'openrouter' ? 'block' : 'none';
      }
    };

    if (selectProv) {
      selectProv.addEventListener('change', async () => {
        updateProviderBadge();
        await loadModelsForSelectedProvider();
      });
    }

    if (freeCheckbox) {
      freeCheckbox.addEventListener('change', () => {
        renderModelDropdownOptions();
      });
    }

    updateProviderBadge();
    await loadModelsForSelectedProvider();

    const btnTest = document.getElementById('btn-test-model');
    const btnApply = document.getElementById('btn-apply-model');
    if (btnTest) btnTest.addEventListener('click', testSelectedModel);
    if (btnApply) btnApply.addEventListener('click', applySelectedModel);
  } catch (err) {
    container.innerHTML = `
      <div class="card" style="border-color: var(--accent-danger);">
        <div class="card-title" style="color: var(--accent-danger);">Erreur de chargement des Modèles IA</div>
        <div class="card-subtext">${err.message}</div>
        <div style="margin-top: 12px;">
          <button class="btn btn-primary btn-sm" onclick="renderModelsView()">Réessayer</button>
        </div>
      </div>
    `;
  }
}

async function loadModelsForSelectedProvider() {
  const selectProv = document.getElementById('select-provider');
  const selectMod = document.getElementById('select-model');
  const provider = selectProv ? selectProv.value : '';
  const statusBox = document.getElementById('model-status-box');

  if (selectMod) selectMod.innerHTML = '<option value="">Chargement des modèles...</option>';
  if (statusBox) statusBox.textContent = '';

  if (!provider) {
    state.rawCatalogModels = [];
    renderModelDropdownOptions();
    return;
  }

  if (provider === 'openrouter') {
    if (statusBox) statusBox.innerHTML = '<span style="color: var(--text-muted); font-size: 0.85rem;">Chargement du catalogue OpenRouter...</span>';
    try {
      const response = await fetchApi('/api/models/openrouter');
      state.rawCatalogModels = Array.isArray(response)
        ? response
        : Array.isArray(response?.models)
        ? response.models
        : Array.isArray(response?.data)
        ? response.data
        : [];
      if (statusBox) statusBox.textContent = '';
    } catch {
      state.rawCatalogModels = [
        { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', isFree: false },
        { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B Instruct (Free)', isFree: true },
      ];
      if (statusBox) statusBox.textContent = '';
    }
  } else {
    try {
      const response = await fetchApi(`/api/models/catalog/${provider}`);
      state.rawCatalogModels = Array.isArray(response)
        ? response
        : Array.isArray(response?.models)
        ? response.models
        : Array.isArray(response?.data)
        ? response.data
        : [];
    } catch {
      state.rawCatalogModels = [{ id: 'default', name: 'Default Model' }];
    }
  }

  renderModelDropdownOptions();
}

function renderModelDropdownOptions() {
  const selectProv = document.getElementById('select-provider');
  const selectMod = document.getElementById('select-model');
  const freeCheckbox = document.getElementById('filter-free-models');
  const isFreeOnly = freeCheckbox && freeCheckbox.checked;

  if (!selectMod) return;

  let list = Array.isArray(state.rawCatalogModels) ? state.rawCatalogModels : [];
  if (selectProv && selectProv.value === 'openrouter' && isFreeOnly) {
    list = list.filter((m) => Boolean(m && m.isFree));
  }

  if (list.length === 0) {
    selectMod.innerHTML = '<option value="">Aucun modèle disponible</option>';
    return;
  }

  const activeModel = state.models?.activeModel || '';

  selectMod.innerHTML = list.map((m) => {
    const id = m?.id || 'unknown';
    const name = m?.name || id;
    const isFree = Boolean(m?.isFree);
    return `
      <option value="${id}" ${id === activeModel ? 'selected' : ''}>
        ${name} ${isFree ? '🎁 (Gratuit)' : ''} (${id})
      </option>
    `;
  }).join('');
}

async function testSelectedModel() {
  const selectProv = document.getElementById('select-provider');
  const selectMod = document.getElementById('select-model');
  const statusBox = document.getElementById('model-status-box');

  const provider = selectProv ? selectProv.value : '';
  const model = selectMod ? selectMod.value : '';

  if (!model) return;

  if (statusBox) statusBox.innerHTML = '<span style="color: var(--accent-warning);">🧪 Test du modèle en cours...</span>';

  try {
    const res = await fetchApi('/api/models/test', {
      method: 'POST',
      body: JSON.stringify({ provider, model }),
    });

    if (statusBox) {
      if (res.ok) {
        statusBox.innerHTML = `<div style="padding: 10px; background: rgba(16,185,129,0.15); border: 1px solid var(--accent-success); border-radius: 8px; color: var(--accent-success);">✅ ${res.message}</div>`;
      } else {
        statusBox.innerHTML = `<div style="padding: 10px; background: rgba(239,68,68,0.15); border: 1px solid var(--accent-danger); border-radius: 8px; color: var(--accent-danger);">❌ Modèle inaccessible : ${res.error}</div>`;
      }
    }
  } catch (err) {
    if (statusBox) statusBox.innerHTML = `<div style="padding: 10px; background: rgba(239,68,68,0.15); border: 1px solid var(--accent-danger); border-radius: 8px; color: var(--accent-danger);">❌ Erreur de test : ${err.message}</div>`;
  }
}

async function applySelectedModel() {
  const selectProv = document.getElementById('select-provider');
  const selectMod = document.getElementById('select-model');
  const statusBox = document.getElementById('model-status-box');

  const provider = selectProv ? selectProv.value : '';
  const model = selectMod ? selectMod.value : '';

  if (!model) return;

  if (statusBox) statusBox.innerHTML = '<span style="color: var(--accent-primary);">⏳ Validation et bascule du modèle en cours...</span>';

  try {
    const res = await fetchApi('/api/models/select', {
      method: 'POST',
      body: JSON.stringify({ provider, model }),
    });

    if (res.ok) {
      const provDisp = document.getElementById('active-provider-display');
      const modDisp = document.getElementById('active-model-display');
      if (provDisp) provDisp.textContent = res.activeProvider;
      if (modDisp) modDisp.textContent = res.activeModel;
      if (statusBox) statusBox.innerHTML = `<div style="padding: 10px; background: rgba(16,185,129,0.15); border: 1px solid var(--accent-success); border-radius: 8px; color: var(--accent-success);">✅ ${res.message}</div>`;
    } else if (statusBox) {
      statusBox.innerHTML = `<div style="padding: 10px; background: rgba(239,68,68,0.15); border: 1px solid var(--accent-danger); border-radius: 8px; color: var(--accent-danger);">⚠️ ${res.error}</div>`;
    }
  } catch (err) {
    if (statusBox) statusBox.innerHTML = `<div style="padding: 10px; background: rgba(239,68,68,0.15); border: 1px solid var(--accent-danger); border-radius: 8px; color: var(--accent-danger);">❌ Erreur : ${err.message}</div>`;
  }
}

// 9. RÉFLEXION VIEW
async function renderReflectionView() {
  const container = document.getElementById('view-reflection');
  container.innerHTML = `<div class="card"><div class="card-title">Chargement de la réflexion...</div></div>`;

  try {
    const reflection = await fetchApi('/api/reflection');
    container.innerHTML = `
      <h2>Module de Réflexion Continue</h2>
      <div class="card" style="margin-top: 12px;">
        <div class="card-title">Statut Réflexion</div>
        <div class="card-value" style="color: var(--accent-success);">🟢 Active (Tous les ${reflection.everyNSteps} tours)</div>
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<div class="card" style="border-color: var(--accent-danger);"><div class="card-title" style="color: var(--accent-danger);">${err.message}</div></div>`;
  }
}

// 10. SYSTÈME VIEW
async function renderSystemView() {
  const container = document.getElementById('view-system');
  container.innerHTML = `<div class="card"><div class="card-title">Diagnostic système...</div></div>`;

  try {
    const sys = await fetchApi('/api/system');

    container.innerHTML = `
      <h2>Informations & Diagnostics Système</h2>

      <div class="card-grid" style="margin-top: 12px;">
        <div class="card">
          <div class="card-title">Backend Status</div>
          <div class="card-value" style="color: var(--accent-success);">🟢 ${sys.backend}</div>
        </div>
        <div class="card">
          <div class="card-title">Base SQLite</div>
          <div class="card-value" style="color: var(--accent-success);">🟢 ${sys.dbStatus}</div>
        </div>
      </div>

      <div class="card" style="margin-top: 12px;">
        <div class="card-title">Mises à jour OTA (Over-The-Air)</div>
        <div style="font-size: 0.9rem; color: var(--text-muted); line-height: 1.6; margin-top: 8px;">
          Version native APK : <strong>v${NATIVE_VERSION}</strong><br/>
          Version OTA active : <strong style="color: var(--accent-primary);">v${state.ota.activeVersion}</strong><br/>
          ${state.ota.previousVersion ? `Version précédente (Backup) : <strong>v${state.ota.previousVersion}</strong><br/>` : ''}
          Dernière vérification : ${state.ota.lastCheck}
        </div>
        <div style="display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap;">
          <button class="btn btn-primary btn-sm" onclick="checkOtaUpdates(true)">🔍 Rechercher une mise à jour</button>
          ${state.ota.previousVersion ? `<button class="btn btn-secondary btn-sm" onclick="rollbackOtaUpdate()">↩️ Revenir à la version précédente</button>` : ''}
        </div>
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<div class="card" style="border-color: var(--accent-danger);"><div class="card-title" style="color: var(--accent-danger);">${err.message}</div></div>`;
  }
}

// 11. PARAMÈTRES VIEW
function renderSettingsView() {
  const container = document.getElementById('view-settings');

  container.innerHTML = `
    <h2>Paramètres du Command Center</h2>

    <div class="card" style="margin-top: 12px;">
      <div class="card-title">Connexion Backend (Réseau / Render)</div>
      <div class="form-group" style="margin-top: 8px;">
        <label class="form-label">URL du Serveur Jarvis (ex: https://votre-app.onrender.com)</label>
        <input type="text" id="setting-backend-url" class="input-field" value="${state.backendUrl}" placeholder="Laissez vide pour le même serveur HTTP" />
      </div>
      <div class="form-group" style="margin-top: 8px;">
        <label class="form-label">Token d'Authentification API (Optionnel)</label>
        <input type="password" id="setting-token" class="input-field" value="${state.token}" placeholder="Token d'accès si configuré" />
      </div>
      <div style="margin-top: 12px;">
        <button class="btn btn-primary" onclick="saveConnectionSettings()">Sauvegarder Connexion</button>
      </div>
    </div>

    <div class="card" style="margin-top: 12px;">
      <div class="card-title">Gestion des Mises à jour OTA</div>
      <div style="font-size: 0.9rem; color: var(--text-muted); line-height: 1.6; margin-top: 8px;">
        Version native APK : <strong>v${NATIVE_VERSION}</strong><br/>
        Version OTA active : <strong style="color: var(--accent-primary);">v${state.ota.activeVersion}</strong>
      </div>
      <div style="display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap;">
        <button class="btn btn-primary btn-sm" onclick="checkOtaUpdates(true)">🔍 Rechercher une mise à jour OTA</button>
        ${state.ota.previousVersion ? `<button class="btn btn-secondary btn-sm" onclick="rollbackOtaUpdate()">↩️ Rollback version précédente</button>` : ''}
      </div>
    </div>
  `;
}

function saveConnectionSettings() {
  const url = document.getElementById('setting-backend-url').value.trim();
  const token = document.getElementById('setting-token').value.trim();

  state.backendUrl = url;
  state.token = token;

  localStorage.setItem('jarvis_backend_url', url);
  localStorage.setItem('jarvis_token', token);

  alert('Paramètres de connexion réseau sauvegardés !');
  renderAccueilView();
}

// --- INITIALIZATION ---
let jarvisInitialized = false;

function bootstrapJarvis() {
  if (jarvisInitialized) return;
  jarvisInitialized = true;

  initNavigation();
  switchView('accueil');

  if (state.ota && state.ota.autoCheck) {
    setTimeout(() => checkOtaUpdates(false), 2000);
  }
}

if (typeof window !== 'undefined') {
  window.bootstrapJarvis = bootstrapJarvis;
  window.jarvisInitialized = () => jarvisInitialized;
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrapJarvis, { once: true });
  } else {
    bootstrapJarvis();
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { bootstrapJarvis, state, switchView };
}