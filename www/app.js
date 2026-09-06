// JARVIS COMMAND CENTER - MAIN FRONTEND LOGIC

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

// --- NAVIGATION LOGIC ---
function switchView(viewName) {
  state.activeView = viewName;

  // Update nav item highlights
  elements.navItems.forEach((item) => {
    if (item.getAttribute('data-view') === viewName) {
      item.classList.add('active');
      const title = item.querySelector('span:last-child').textContent;
      elements.headerTitle.textContent = title;
    } else {
      item.classList.remove('active');
    }
  });

  // Update active section
  elements.sections.forEach((sec) => {
    if (sec.id === `view-${viewName}`) {
      sec.classList.add('active');
    } else {
      sec.classList.remove('active');
    }
  });

  // Close sidebar drawer on tablet portrait
  elements.sidebar.classList.remove('open');
  elements.sidebarOverlay.classList.remove('active');

  // Load view data
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

// --- DATA LOADERS & RENDERERS FOR 11 VIEWS ---

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
    console.error(`Erreur lors du chargement de la vue ${viewName}:`, err);
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
          <div class="card-subtext">Version ${status.version}</div>
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

      ${status.lastError ? `
        <div class="card" style="border-color: var(--accent-danger); background-color: rgba(239,68,68,0.1);">
          <div class="card-title" style="color: var(--accent-danger);">Dernière Erreur Important</div>
          <div style="color: var(--text-main); font-family: monospace;">${status.lastError}</div>
        </div>
      ` : ''}
    `;
  } catch (err) {
    container.innerHTML = `
      <div class="card" style="border-color: var(--accent-danger);">
        <div class="card-title" style="color: var(--accent-danger);">Jarvis Inaccessible</div>
        <div class="card-subtext">${err.message}</div>
        <div style="margin-top: 12px;">
          <button class="btn btn-primary btn-sm" onclick="renderAccueilView()">Réessayer</button>
          <button class="btn btn-secondary btn-sm" onclick="switchView('settings')">Configurer l'URL Backend</button>
        </div>
      </div>
    `;
  }
}

// 2. CHAT VIEW
function renderChatView() {
  const container = document.getElementById('view-chat');
  if (container.children.length > 0) return; // Keep existing chat session DOM

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
  const messagesBox = document.getElementById('chat-messages');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;

    input.value = '';
    appendChatMessage('user', text);

    const pendingEl = appendChatMessage('agent pending', '🧠 Reflexion en cours...');

    try {
      const res = await fetchApi('/api/chat', {
        method: 'POST',
        body: JSON.stringify({ message: text }),
      });

      pendingEl.remove();
      appendChatMessage('agent', res.response);

      // Check if any operations need user action
      checkPendingOperationsForChat();
    } catch (err) {
      pendingEl.remove();
      appendChatMessage('agent error', `⚠️ Erreur : ${err.message}`);
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
  } else if (role.includes('error')) {
    div.style.alignSelf = 'flex-start';
    div.style.backgroundColor = 'rgba(239, 68, 68, 0.15)';
    div.style.border = '1px solid var(--accent-danger)';
    div.style.color = 'var(--accent-danger)';
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

async function checkPendingOperationsForChat() {
  try {
    const ops = await fetchApi('/api/operations');
    const waiting = ops.filter((o) => o.status === 'WAITING_INPUT' || o.status === 'WAITING_PERMISSION');
    const box = document.getElementById('chat-messages');
    if (!box) return;

    waiting.forEach((op) => {
      const card = document.createElement('div');
      card.className = 'card';
      card.style.cssText = 'border-color: var(--accent-warning); margin-top: 8px; width: 100%;';
      card.innerHTML = `
        <div class="card-title" style="color: var(--accent-warning);">⚠️ Action Requise (${op.capability})</div>
        <div><strong>${op.objective}</strong></div>
        <div style="font-size: 0.9rem; color: var(--text-muted);">${op.result || op.error || 'Permission demandée'}</div>
        <div style="display: flex; gap: 8px; margin-top: 8px;">
          <button class="btn btn-success btn-sm" onclick="respondOperation('${op.taskId}', 'authorize')">Autoriser</button>
          <button class="btn btn-danger btn-sm" onclick="respondOperation('${op.taskId}', 'reject')">Refuser</button>
        </div>
      `;
      box.appendChild(card);
      box.scrollTop = box.scrollHeight;
    });
  } catch {}
}

async function respondOperation(taskId, action, value = '') {
  try {
    await fetchApi(`/api/operations/${taskId}/respond`, {
      method: 'POST',
      body: JSON.stringify({ action, value }),
    });
    alert('Réponse transmise avec succès !');
    if (state.activeView === 'operations') renderOperationsView();
    if (state.activeView === 'chat') {
      const box = document.getElementById('chat-messages');
      if (box) appendChatMessage('agent', `Action '${action}' enregistrée pour l'opération.`);
    }
  } catch (err) {
    alert(`Erreur : ${err.message}`);
  }
}

// 3. OPÉRATIONS VIEW
async function renderOperationsView() {
  const container = document.getElementById('view-operations');
  container.innerHTML = `<div class="card"><div class="card-title">Chargement des opérations...</div></div>`;

  try {
    const ops = await fetchApi('/api/operations');
    state.operations = ops;

    if (!ops || ops.length === 0) {
      container.innerHTML = `
        <div class="card">
          <div class="card-title">Aucune Opération</div>
          <div class="card-subtext">Aucune tâche ou délégation de service n'a été enregistrée pour le moment.</div>
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <h2>Opérations Externe / Service Tasks</h2>
        <button class="btn btn-secondary btn-sm" onclick="renderOperationsView()">🔄 Actualiser</button>
      </div>

      <div style="display: flex; flex-direction: column; gap: 12px; margin-top: 12px;">
        ${ops.map((op) => {
          let badgeClass = 'badge-info';
          if (op.status === 'COMPLETED') badgeClass = 'badge-success';
          if (op.status === 'FAILED' || op.status === 'REJECTED') badgeClass = 'badge-danger';
          if (op.status === 'WAITING_INPUT' || op.status === 'WAITING_PERMISSION') badgeClass = 'badge-warning';

          return `
            <div class="card" style="display: flex; flex-direction: column; gap: 8px;">
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <span class="badge ${badgeClass}">${op.status}</span>
                <span style="font-size: 0.8rem; color: var(--text-muted);">${new Date(op.createdAt).toLocaleString()}</span>
              </div>
              <div style="font-size: 1.1rem; font-weight: 600;">${op.objective}</div>
              <div style="font-size: 0.9rem; color: var(--text-muted);">
                Capacité: <strong>${op.capability}</strong> | Service: <strong>${op.selectedService}</strong>
              </div>
              ${op.result ? `<div style="background: var(--bg-dark); padding: 10px; border-radius: 8px; font-size: 0.9rem;">${op.result}</div>` : ''}
              ${op.error ? `<div style="background: rgba(239,68,68,0.1); color: var(--accent-danger); padding: 10px; border-radius: 8px; font-size: 0.9rem;">${op.error}</div>` : ''}

              ${(op.status === 'WAITING_INPUT' || op.status === 'WAITING_PERMISSION') ? `
                <div style="display: flex; gap: 8px; margin-top: 8px;">
                  <button class="btn btn-success btn-sm" onclick="respondOperation('${op.taskId}', 'authorize')">Autoriser</button>
                  <button class="btn btn-danger btn-sm" onclick="respondOperation('${op.taskId}', 'reject')">Refuser</button>
                </div>
              ` : ''}
            </div>
          `;
        }).join('')}
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<div class="card" style="border-color: var(--accent-danger);"><div class="card-title" style="color: var(--accent-danger);">${err.message}</div></div>`;
  }
}

// 4. SERVICES VIEW
async function renderServicesView() {
  const container = document.getElementById('view-services');
  container.innerHTML = `<div class="card"><div class="card-title">Chargement du Service Registry...</div></div>`;

  try {
    const services = await fetchApi('/api/services');
    state.services = services;

    container.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <h2>Registre des Services Extérieurs</h2>
        <button class="btn btn-secondary btn-sm" onclick="renderServicesView()">🔄 Actualiser</button>
      </div>

      <div class="card-grid" style="margin-top: 12px;">
        ${services.map((s) => `
          <div class="card">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <span class="card-title">${s.name}</span>
              <span class="badge ${s.enabled ? 'badge-success' : 'badge-danger'}">${s.enabled ? 'ACTIF' : 'DÉSACTIVÉ'}</span>
            </div>
            <div style="font-size: 0.9rem; color: var(--text-muted);">
              Endpoint: <code>${s.endpoint}</code><br/>
              Priorité: ${s.priority}
            </div>
            <div style="font-size: 0.85rem; color: var(--text-muted);">
              Capacités : ${s.capabilities.map((c) => `<span class="badge badge-info" style="margin-right: 4px;">${c}</span>`).join('')}
            </div>
            <div style="display: flex; gap: 8px; margin-top: 8px;">
              <button class="btn btn-secondary btn-sm" onclick="testService('${s.id}')">Test connexion</button>
              <button class="btn ${s.enabled ? 'btn-danger' : 'btn-success'} btn-sm" onclick="toggleService('${s.id}', ${!s.enabled})">
                ${s.enabled ? 'Désactiver' : 'Activer'}
              </button>
            </div>
            <div id="test-result-${s.id}" style="font-size: 0.85rem; margin-top: 4px;"></div>
          </div>
        `).join('')}
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<div class="card" style="border-color: var(--accent-danger);"><div class="card-title" style="color: var(--accent-danger);">${err.message}</div></div>`;
  }
}

async function testService(id) {
  const target = document.getElementById(`test-result-${id}`);
  if (target) target.textContent = 'Test en cours...';
  try {
    const res = await fetchApi(`/api/services/${id}/test`, { method: 'POST' });
    if (target) {
      target.style.color = res.reachable ? 'var(--accent-success)' : 'var(--accent-danger)';
      target.textContent = res.reachable ? '🟢 Connexion réussie !' : `🔴 Inaccessible (${res.error || 'timeout'})`;
    }
  } catch (err) {
    if (target) {
      target.style.color = 'var(--accent-danger)';
      target.textContent = `Erreur: ${err.message}`;
    }
  }
}

async function toggleService(id, enabled) {
  try {
    await fetchApi(`/api/services/${id}/toggle`, {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    });
    renderServicesView();
  } catch (err) {
    alert(`Erreur toggle: ${err.message}`);
  }
}

// 5. TÂCHES & PLANS VIEW
async function renderTasksView() {
  const container = document.getElementById('view-tasks');
  container.innerHTML = `<div class="card"><div class="card-title">Chargement des tâches et du plan...</div></div>`;

  try {
    const tasks = await fetchApi('/api/tasks');
    const plan = await fetchApi('/api/plan');

    container.innerHTML = `
      <h2>Tâches Personnelles & Plans</h2>

      <div class="card" style="margin-top: 12px;">
        <div class="card-title">Ajouter une Tâche</div>
        <form id="add-task-form" style="display: flex; gap: 8px; margin-top: 8px;">
          <input type="text" id="task-title-input" class="input-field" placeholder="ex: Rappeler le client demain à 14h" required />
          <button type="submit" class="btn btn-primary" style="min-width: 120px;">Ajouter</button>
        </form>
      </div>

      <div class="card" style="margin-top: 12px;">
        <div class="card-title">Liste des Tâches</div>
        <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 8px;">
          ${tasks.length === 0 ? '<div style="color: var(--text-muted);">Aucune tâche enregistrée.</div>' : tasks.map((t) => `
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px; background: var(--bg-dark); border-radius: 8px;">
              <div>
                <span style="${t.status === 'done' ? 'text-decoration: line-through; color: var(--text-muted);' : 'font-weight: 600;'}">${t.title}</span>
                ${t.dueAt ? `<span style="font-size: 0.8rem; color: var(--text-muted); margin-left: 8px;">(Échéance: ${new Date(t.dueAt).toLocaleString()})</span>` : ''}
              </div>
              ${t.status === 'pending' ? `<button class="btn btn-success btn-sm" onclick="completeTask('${t.id}')">Terminer</button>` : `<span class="badge badge-success">FAIT</span>`}
            </div>
          `).join('')}
        </div>
      </div>

      <div class="card" style="margin-top: 12px;">
        <div class="card-title">Plan de l'Agent (Planner)</div>
        <div style="margin-top: 8px;">
          ${plan.length === 0 ? '<div style="color: var(--text-muted);">Aucun plan actif.</div>' : plan.map((p) => `
            <div style="padding: 10px; background: var(--bg-dark); border-radius: 8px; margin-bottom: 8px;">
              <strong>[${p.status}]</strong> ${p.goal}
            </div>
          `).join('')}
        </div>
      </div>
    `;

    document.getElementById('add-task-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.getElementById('task-title-input');
      const title = input.value.trim();
      if (!title) return;
      await fetchApi('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({ title }),
      });
      renderTasksView();
    });
  } catch (err) {
    container.innerHTML = `<div class="card" style="border-color: var(--accent-danger);"><div class="card-title" style="color: var(--accent-danger);">${err.message}</div></div>`;
  }
}

async function completeTask(id) {
  try {
    await fetchApi(`/api/tasks/${id}/complete`, { method: 'POST' });
    renderTasksView();
  } catch (err) {
    alert(`Erreur : ${err.message}`);
  }
}

// 6. MÉMOIRE VIEW
async function renderMemoryView() {
  const container = document.getElementById('view-memory');
  container.innerHTML = `<div class="card"><div class="card-title">Chargement de la mémoire...</div></div>`;

  try {
    const memory = await fetchApi('/api/memory');

    container.innerHTML = `
      <h2>Gestion de la Mémoire</h2>

      <div class="card-grid" style="margin-top: 12px;">
        <div class="card">
          <div class="card-title">Faits Enregistrés</div>
          <div class="card-value">${memory.factsCount}</div>
        </div>
        <div class="card">
          <div class="card-title">Messages de Travail</div>
          <div class="card-value">${memory.recentWorking.length}</div>
        </div>
      </div>

      <div class="card" style="margin-top: 12px;">
        <div class="card-title">Ajouter un Fait à Mémoriser</div>
        <form id="add-fact-form" style="display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px;">
          <input type="text" id="fact-entity" class="input-field" placeholder="Entité (ex: utilisateur)" style="flex: 1;" required />
          <input type="text" id="fact-attr" class="input-field" placeholder="Attribut (ex: ville)" style="flex: 1;" required />
          <input type="text" id="fact-val" class="input-field" placeholder="Valeur (ex: Paris)" style="flex: 1;" required />
          <button type="submit" class="btn btn-primary" style="min-width: 120px;">Mémoriser</button>
        </form>
      </div>

      <div class="card" style="margin-top: 12px;">
        <div class="card-title">Faits Connus</div>
        <div style="display: flex; flex-direction: column; gap: 6px; margin-top: 8px;">
          ${memory.facts.length === 0 ? '<div style="color: var(--text-muted);">Aucun fait enregistré.</div>' : memory.facts.map((f) => `
            <div style="padding: 8px 12px; background: var(--bg-dark); border-radius: 6px; font-family: monospace;">
              ${f.entity}.${f.attribute} = <strong>${f.value}</strong>
            </div>
          `).join('')}
        </div>
      </div>

      <div class="card" style="margin-top: 12px;">
        <div class="card-title">Rechercher dans les Souvenirs</div>
        <form id="search-memory-form" style="display: flex; gap: 8px; margin-top: 8px;">
          <input type="text" id="search-memory-query" class="input-field" placeholder="Tapez un mot-clé ou sujet..." required />
          <button type="submit" class="btn btn-secondary" style="min-width: 120px;">Rechercher</button>
        </form>
        <div id="memory-search-results" style="margin-top: 12px;"></div>
      </div>
    `;

    document.getElementById('add-fact-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const entity = document.getElementById('fact-entity').value.trim();
      const attribute = document.getElementById('fact-attr').value.trim();
      const value = document.getElementById('fact-val').value.trim();
      await fetchApi('/api/memory/facts', {
        method: 'POST',
        body: JSON.stringify({ entity, attribute, value }),
      });
      renderMemoryView();
    });

    document.getElementById('search-memory-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const query = document.getElementById('search-memory-query').value.trim();
      const target = document.getElementById('memory-search-results');
      target.innerHTML = 'Recherche en cours...';
      try {
        const res = await fetchApi('/api/memory/search', {
          method: 'POST',
          body: JSON.stringify({ query }),
        });
        target.innerHTML = res.relevantMemories.map((m) => `
          <div style="padding: 10px; background: var(--bg-dark); border-radius: 8px; margin-bottom: 6px;">
            <div style="font-size: 0.8rem; color: var(--text-muted);">${m.kind} (score: ${m.score.toFixed(2)})</div>
            <div>${m.text}</div>
          </div>
        `).join('') || 'Aucun souvenir trouvé.';
      } catch (err) {
        target.textContent = `Erreur: ${err.message}`;
      }
    });
  } catch (err) {
    container.innerHTML = `<div class="card" style="border-color: var(--accent-danger);"><div class="card-title" style="color: var(--accent-danger);">${err.message}</div></div>`;
  }
}

// 7. SKILLS VIEW
async function renderSkillsView() {
  const container = document.getElementById('view-skills');
  container.innerHTML = `<div class="card"><div class="card-title">Chargement des compétences...</div></div>`;

  try {
    const skills = await fetchApi('/api/skills');

    container.innerHTML = `
      <h2>Compétences Internes (Skills)</h2>
      <div style="font-size: 0.9rem; color: var(--text-muted); margin-bottom: 12px;">
        Les skills sont les capacités internes nativement exécutées par le moteur de Jarvis.
      </div>

      <div class="card-grid">
        ${skills.map((s) => `
          <div class="card">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <span class="card-title" style="color: var(--accent-primary); font-size: 1.1rem;">${s.name}</span>
              <span class="badge badge-success">DISPONIBLE</span>
            </div>
            <div>${s.description}</div>
            <div style="font-size: 0.85rem; color: var(--text-muted); font-family: monospace; background: var(--bg-dark); padding: 6px 10px; border-radius: 6px;">
              Arguments : ${s.argsHint}
            </div>
          </div>
        `).join('')}
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<div class="card" style="border-color: var(--accent-danger);"><div class="card-title" style="color: var(--accent-danger);">${err.message}</div></div>`;
  }
}

// 8. MODÈLES IA VIEW (INTERACTIVE CONTROL PANEL)
async function renderModelsView() {
  const container = document.getElementById('view-models');
  container.innerHTML = `<div class="card"><div class="card-title">Chargement des modèles...</div></div>`;

  try {
    const modelsData = await fetchApi('/api/models');
    state.models = modelsData;

    container.innerHTML = `
      <h2>Panneau de Contrôle Modèles IA</h2>

      <div class="card-grid" style="margin-top: 12px;">
        <div class="card">
          <div class="card-title">Fournisseur IA Actif</div>
          <div id="active-provider-display" class="card-value" style="color: var(--accent-primary);">${modelsData.activeProvider}</div>
        </div>
        <div class="card">
          <div class="card-title">Modèle LLM Sélectionné</div>
          <div id="active-model-display" class="card-value" style="font-size: 1.4rem;">${modelsData.activeModel}</div>
        </div>
      </div>

      <div class="card" style="margin-top: 16px;">
        <div class="card-title">Sélection du Fournisseur & du Modèle</div>

        <div class="form-group" style="margin-top: 12px;">
          <label class="form-label">Fournisseur IA</label>
          <div style="display: flex; align-items: center; gap: 12px;">
            <select id="select-provider" class="input-field" style="flex: 1;">
              ${modelsData.providers.map((p) => `
                <option value="${p.id}" ${p.id === modelsData.activeProvider ? 'selected' : ''}>
                  ${p.name} ${p.available ? '🟢 (Configuré)' : '🔴 (Non configuré)'}
                </option>
              `).join('')}
            </select>
            <span id="provider-status-badge" class="badge badge-success">Configuré</span>
          </div>
        </div>

        <div class="form-group" style="margin-top: 12px;">
          <label class="form-label">Modèle à utiliser</label>
          <select id="select-model" class="input-field"></select>
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

      <div class="card" style="margin-top: 16px; border-color: var(--border-color);">
        <div class="card-title">Sécurité des Identifiants</div>
        <div class="card-subtext" style="line-height: 1.5;">
          Les clés API restent exclusivement stockées côté backend (variables d'environnement Render ou serveur). Aucun secret n'est transmis au navigateur ou à l'application Android.
        </div>
      </div>
    `;

    const selectProv = document.getElementById('select-provider');
    const selectMod = document.getElementById('select-model');
    const freeCheckbox = document.getElementById('filter-free-models');
    const freeContainer = document.getElementById('openrouter-filter-container');

    const updateProviderBadge = () => {
      const selected = selectProv.value;
      const provInfo = modelsData.providers.find((p) => p.id === selected);
      const badge = document.getElementById('provider-status-badge');
      if (provInfo && provInfo.available) {
        badge.className = 'badge badge-success';
        badge.textContent = '🟢 Configuré';
      } else {
        badge.className = 'badge badge-danger';
        badge.textContent = '🔴 Non configuré';
      }
      freeContainer.style.display = selected === 'openrouter' ? 'block' : 'none';
    };

    selectProv.addEventListener('change', async () => {
      updateProviderBadge();
      await loadModelsForSelectedProvider();
    });

    freeCheckbox.addEventListener('change', () => {
      renderModelDropdownOptions();
    });

    updateProviderBadge();
    await loadModelsForSelectedProvider();

    document.getElementById('btn-test-model').addEventListener('click', testSelectedModel);
    document.getElementById('btn-apply-model').addEventListener('click', applySelectedModel);
  } catch (err) {
    container.innerHTML = `<div class="card" style="border-color: var(--accent-danger);"><div class="card-title" style="color: var(--accent-danger);">${err.message}</div></div>`;
  }
}

async function loadModelsForSelectedProvider() {
  const selectProv = document.getElementById('select-provider');
  const provider = selectProv.value;
  const statusBox = document.getElementById('model-status-box');
  statusBox.textContent = '';

  if (provider === 'openrouter') {
    statusBox.innerHTML = '<span style="color: var(--text-muted); font-size: 0.85rem;">Chargement du catalogue OpenRouter...</span>';
    try {
      state.rawCatalogModels = await fetchApi('/api/models/openrouter');
      statusBox.textContent = '';
    } catch {
      state.rawCatalogModels = [
        { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', isFree: false },
        { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B Instruct (Free)', isFree: true },
      ];
      statusBox.textContent = '';
    }
  } else {
    try {
      state.rawCatalogModels = await fetchApi(`/api/models/catalog/${provider}`);
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

  let list = state.rawCatalogModels || [];
  if (selectProv.value === 'openrouter' && isFreeOnly) {
    list = list.filter((m) => m.isFree);
  }

  if (list.length === 0) {
    selectMod.innerHTML = '<option value="">Aucun modèle disponible</option>';
    return;
  }

  selectMod.innerHTML = list.map((m) => `
    <option value="${m.id}" ${m.id === state.models?.activeModel ? 'selected' : ''}>
      ${m.name} ${m.isFree ? '🎁 (Gratuit)' : ''} (${m.id})
    </option>
  `).join('');
}

async function testSelectedModel() {
  const selectProv = document.getElementById('select-provider');
  const selectMod = document.getElementById('select-model');
  const statusBox = document.getElementById('model-status-box');

  const provider = selectProv.value;
  const model = selectMod.value;

  if (!model) return;

  statusBox.innerHTML = '<span style="color: var(--accent-warning);">🧪 Test du modèle en cours...</span>';

  try {
    const res = await fetchApi('/api/models/test', {
      method: 'POST',
      body: JSON.stringify({ provider, model }),
    });

    if (res.ok) {
      statusBox.innerHTML = `<div style="padding: 10px; background: rgba(16,185,129,0.15); border: 1px solid var(--accent-success); border-radius: 8px; color: var(--accent-success);">✅ ${res.message}</div>`;
    } else {
      statusBox.innerHTML = `<div style="padding: 10px; background: rgba(239,68,68,0.15); border: 1px solid var(--accent-danger); border-radius: 8px; color: var(--accent-danger);">❌ Modèle inaccessible : ${res.error}</div>`;
    }
  } catch (err) {
    statusBox.innerHTML = `<div style="padding: 10px; background: rgba(239,68,68,0.15); border: 1px solid var(--accent-danger); border-radius: 8px; color: var(--accent-danger);">❌ Erreur de test : ${err.message}</div>`;
  }
}

async function applySelectedModel() {
  const selectProv = document.getElementById('select-provider');
  const selectMod = document.getElementById('select-model');
  const statusBox = document.getElementById('model-status-box');

  const provider = selectProv.value;
  const model = selectMod.value;

  if (!model) return;

  statusBox.innerHTML = '<span style="color: var(--accent-primary);">⏳ Validation et bascule du modèle en cours...</span>';

  try {
    const res = await fetchApi('/api/models/select', {
      method: 'POST',
      body: JSON.stringify({ provider, model }),
    });

    if (res.ok) {
      document.getElementById('active-provider-display').textContent = res.activeProvider;
      document.getElementById('active-model-display').textContent = res.activeModel;
      statusBox.innerHTML = `<div style="padding: 10px; background: rgba(16,185,129,0.15); border: 1px solid var(--accent-success); border-radius: 8px; color: var(--accent-success);">✅ ${res.message}</div>`;
    } else {
      statusBox.innerHTML = `<div style="padding: 10px; background: rgba(239,68,68,0.15); border: 1px solid var(--accent-danger); border-radius: 8px; color: var(--accent-danger);">⚠️ ${res.error}</div>`;
    }
  } catch (err) {
    statusBox.innerHTML = `<div style="padding: 10px; background: rgba(239,68,68,0.15); border: 1px solid var(--accent-danger); border-radius: 8px; color: var(--accent-danger);">❌ Erreur : ${err.message}</div>`;
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

      <div class="card-grid" style="margin-top: 12px;">
        <div class="card">
          <div class="card-title">Statut Réflexion</div>
          <div class="card-value" style="color: var(--accent-success);">🟢 Active</div>
        </div>
        <div class="card">
          <div class="card-title">Fréquence</div>
          <div class="card-value">Tous les ${reflection.everyNSteps} tours</div>
        </div>
      </div>

      <div class="card" style="margin-top: 12px;">
        <div class="card-title">Déclencher une Réflexion Manuelle</div>
        <div style="margin-top: 8px;">
          <button class="btn btn-primary" onclick="triggerReflection()">🔍 Analyser les Échanges Récents</button>
        </div>
        <div id="reflection-manual-result" style="margin-top: 12px;"></div>
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<div class="card" style="border-color: var(--accent-danger);"><div class="card-title" style="color: var(--accent-danger);">${err.message}</div></div>`;
  }
}

async function triggerReflection() {
  const target = document.getElementById('reflection-manual-result');
  if (target) target.textContent = 'Analyse des récents tours en cours...';
  try {
    const res = await fetchApi('/api/reflection/trigger', { method: 'POST' });
    if (target) {
      target.innerHTML = res.insight
        ? `<div style="padding: 12px; background: var(--bg-dark); border-radius: 8px;"><strong>Enseignement extrait :</strong> ${res.insight}</div>`
        : 'Pas suffisamment d\'échanges récents pour générer un enseignement.';
    }
  } catch (err) {
    if (target) target.textContent = `Erreur: ${err.message}`;
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
        <div class="card">
          <div class="card-title">Checkpoints Sauvegardés</div>
          <div class="card-value">${sys.checkpoints.length}</div>
        </div>
      </div>

      <div class="card" style="margin-top: 12px;">
        <div class="card-title">Lancer le Test de Diagnostic</div>
        <div style="margin-top: 8px;">
          <button class="btn btn-primary" onclick="runDiagnostics()">🧪 Lancer les Tests</button>
        </div>
        <div id="diagnostics-results" style="margin-top: 12px;"></div>
      </div>

      <div class="card" style="margin-top: 12px;">
        <div class="card-title">Liste des Points de Reprise (Checkpoints)</div>
        <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 8px;">
          ${sys.checkpoints.length === 0 ? '<div style="color: var(--text-muted);">Aucun checkpoint enregistré.</div>' : sys.checkpoints.map((c) => `
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px; background: var(--bg-dark); border-radius: 8px;">
              <div>
                <strong>${c.label}</strong>
                <span style="font-size: 0.8rem; color: var(--text-muted); margin-left: 8px;">(${new Date(c.createdAt).toLocaleString()})</span>
              </div>
              <button class="btn btn-secondary btn-sm" onclick="restoreCheckpoint('${c.id}')">Restaurer</button>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<div class="card" style="border-color: var(--accent-danger);"><div class="card-title" style="color: var(--accent-danger);">${err.message}</div></div>`;
  }
}

async function runDiagnostics() {
  const target = document.getElementById('diagnostics-results');
  if (target) target.textContent = 'Exécution des diagnostics...';
  try {
    const res = await fetchApi('/api/system/diagnostics', { method: 'POST' });
    if (target) {
      target.innerHTML = res.tests.map((t) => `
        <div style="padding: 8px 12px; background: var(--bg-dark); border-radius: 6px; margin-bottom: 6px; display: flex; justify-content: space-between;">
          <span>${t.name} ${t.detail ? `(${t.detail})` : ''}</span>
          <span class="badge ${t.status === 'ok' ? 'badge-success' : 'badge-warning'}">${t.status}</span>
        </div>
      `).join('');
    }
  } catch (err) {
    if (target) target.textContent = `Erreur : ${err.message}`;
  }
}

async function restoreCheckpoint(id) {
  try {
    await fetchApi(`/api/checkpoints/${id}/restore`, { method: 'POST' });
    alert('Checkpoint restauré avec succès !');
  } catch (err) {
    alert(`Erreur restauration: ${err.message}`);
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
      <div class="card-title">Réglages du Moteur Agent</div>
      <div class="form-group" style="margin-top: 8px;">
        <label class="form-label">Budget de tokens de contexte</label>
        <input type="number" id="setting-budget" class="input-field" value="4000" />
      </div>
      <div class="form-group" style="margin-top: 8px;">
        <label class="form-label">Limite max d'itérations par cycle</label>
        <input type="number" id="setting-max-iter" class="input-field" value="5" />
      </div>
      <div style="margin-top: 12px;">
        <button class="btn btn-secondary" onclick="saveAgentSettings()">Mettre à jour les réglages</button>
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

async function saveAgentSettings() {
  const tokenBudget = Number(document.getElementById('setting-budget').value);
  const maxIterations = Number(document.getElementById('setting-max-iter').value);

  try {
    await fetchApi('/api/settings', {
      method: 'POST',
      body: JSON.stringify({ tokenBudget, maxIterations }),
    });
    alert('Réglages de l\'agent mis à jour !');
  } catch (err) {
    alert(`Erreur : ${err.message}`);
  }
}

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', () => {
  initNavigation();
  switchView('accueil');
});
