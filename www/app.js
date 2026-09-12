// JARVIS COMMAND CENTER - MAIN FRONTEND LOGIC & OTA MANAGER

const NATIVE_VERSION = "1.0.0";

// Clés historiques : présentes sur toutes les installations déjà en production.
// Ne jamais les renommer/supprimer sans passer par migrateLegacyOtaState().
const OTA_LEGACY_KEYS = {
  activeVersion: 'jarvis_ota_active_version',
  activeBundle: 'jarvis_ota_active_bundle',
  previousVersion: 'jarvis_ota_previous_version',
  previousBundle: 'jarvis_ota_previous_bundle',
  lastCheck: 'jarvis_ota_last_check',
  autoCheck: 'jarvis_ota_auto_check',
};
// Identité unique du bundle actif/précédent (buildId ou, à défaut, SHA-256).
// C'est cette identité — pas le numéro de version affiché à l'utilisateur — qui sert
// à détecter une nouvelle mise à jour et à empêcher la réinstallation en boucle.
const OTA_KEYS = Object.assign({}, OTA_LEGACY_KEYS, {
  activeBuildId: 'jarvis_ota_active_build_id',
  activeSha256: 'jarvis_ota_active_sha256',
  previousBuildId: 'jarvis_ota_previous_build_id',
  previousSha256: 'jarvis_ota_previous_sha256',
});

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
    activeVersion: localStorage.getItem(OTA_KEYS.activeVersion) || '1.0.0',
    activeBuildId: localStorage.getItem(OTA_KEYS.activeBuildId) || null,
    activeSha256: localStorage.getItem(OTA_KEYS.activeSha256) || null,
    previousVersion: localStorage.getItem(OTA_KEYS.previousVersion) || null,
    previousBuildId: localStorage.getItem(OTA_KEYS.previousBuildId) || null,
    previousSha256: localStorage.getItem(OTA_KEYS.previousSha256) || null,
    lastCheck: localStorage.getItem(OTA_KEYS.lastCheck) || 'Jamais',
    autoCheck: localStorage.getItem(OTA_KEYS.autoCheck) !== 'false',
  },
};

/**
 * Installations existantes : seules la version affichée et le contenu du bundle
 * étaient stockés (pas d'identité unique). On dérive une identité stable — le
 * SHA-256 du bundle déjà installé — pour que ces installations rejoignent le nouveau
 * mécanisme sans jamais se croire "à jour avec rien" ni se réinstaller en boucle.
 */
async function migrateLegacyOtaState() {
  if (localStorage.getItem(OTA_KEYS.activeBuildId) === null) {
    const legacyBundle = localStorage.getItem(OTA_LEGACY_KEYS.activeBundle);
    const derivedId = legacyBundle ? await computeSha256(legacyBundle) : '';
    localStorage.setItem(OTA_KEYS.activeBuildId, derivedId);
    localStorage.setItem(OTA_KEYS.activeSha256, derivedId);
    state.ota.activeBuildId = derivedId || null;
    state.ota.activeSha256 = derivedId || null;
  }

  if (localStorage.getItem(OTA_KEYS.previousBuildId) === null) {
    const legacyPrevBundle = localStorage.getItem(OTA_LEGACY_KEYS.previousBundle);
    const derivedPrevId = legacyPrevBundle ? await computeSha256(legacyPrevBundle) : '';
    localStorage.setItem(OTA_KEYS.previousBuildId, derivedPrevId);
    localStorage.setItem(OTA_KEYS.previousSha256, derivedPrevId);
    state.ota.previousBuildId = derivedPrevId || null;
    state.ota.previousSha256 = derivedPrevId || null;
  }
}

function getOtaManifestIdentity(manifest) {
  if (!manifest) return null;
  const id = manifest.buildId || manifest.sha256;
  return id ? String(id) : null;
}

function getActiveOtaIdentity() {
  return state.ota.activeBuildId || state.ota.activeSha256 || null;
}

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

// crypto.randomUUID() throws (not just "undefined") on a non-secure origin or an old
// WebView — the same fallback already used in conversationPersistence.js's newRequestId().
function newRequestId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    try { return window.crypto.randomUUID(); } catch (_) { /* fall through */ }
  }
  return 'web-' + Date.now() + '-' + Math.random().toString(16).slice(2);
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

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const err = new Error("Le serveur configuré n'a pas renvoyé une réponse API Jarvis valide.");
      err.code = 'API_RESPONSE_NOT_JSON';
      throw err;
    }

    if (response.status === 401) {
      updateStatusBadge(false, 'Non autorisé');
      const err = new Error('Authentification requise (token invalide ou manquant)');
      err.code = 'AUTH_REQUIRED';
      throw err;
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

/**
 * Télécharge le bundle annoncé par `manifest` et vérifie obligatoirement son SHA-256
 * avant de le considérer installable. Partagé entre l'installation automatique au
 * démarrage et l'installation manuelle depuis l'écran Système, pour qu'un hash invalide
 * soit refusé de façon identique dans les deux cas.
 */
async function fetchAndVerifyOtaBundle(manifest) {
  if (!manifest.sha256) {
    throw new Error('Manifeste OTA invalide : SHA-256 manquant, mise à jour refusée par sécurité.');
  }

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

  const computedHash = await computeSha256(bundleString);
  if (computedHash.toLowerCase() !== manifest.sha256.toLowerCase()) {
    const err = new Error('Échec de vérification SHA-256 : le bundle téléchargé semble altéré.');
    err.code = 'OTA_SHA256_MISMATCH';
    throw err;
  }

  const bundleData = JSON.parse(bundleString);
  if (!bundleData || !bundleData.files) {
    throw new Error('Bundle OTA invalide ou corrompu.');
  }

  return { bundleString, bundleData, computedHash };
}

/**
 * Enregistre le bundle vérifié comme version active (buildId/SHA-256 + contenu) et
 * conserve l'ancien bundle comme version précédente pour permettre un rollback.
 */
function persistOtaInstall(manifest, bundleString, computedHash, activeIdentity) {
  const oldVersion = state.ota.activeVersion;
  const oldBundle = localStorage.getItem(OTA_LEGACY_KEYS.activeBundle) || '';
  const oldBuildId = activeIdentity || '';
  const oldSha256 = state.ota.activeSha256 || '';
  const newIdentity = manifest.buildId ? String(manifest.buildId) : computedHash;

  localStorage.setItem(OTA_KEYS.previousVersion, oldVersion);
  localStorage.setItem(OTA_KEYS.previousBundle, oldBundle);
  localStorage.setItem(OTA_KEYS.previousBuildId, oldBuildId);
  localStorage.setItem(OTA_KEYS.previousSha256, oldSha256);

  localStorage.setItem(OTA_KEYS.activeVersion, manifest.version);
  localStorage.setItem(OTA_KEYS.activeBundle, bundleString);
  localStorage.setItem(OTA_KEYS.activeBuildId, newIdentity);
  localStorage.setItem(OTA_KEYS.activeSha256, computedHash);

  state.ota.previousVersion = oldVersion;
  state.ota.previousBuildId = oldBuildId || null;
  state.ota.previousSha256 = oldSha256 || null;
  state.ota.activeVersion = manifest.version;
  state.ota.activeBuildId = newIdentity;
  state.ota.activeSha256 = computedHash;
}

/**
 * Recharge l'application sur le bundle actif. Si ce bundle contient un index.html
 * (toujours le cas : scripts/build-ota.mjs l'inclut systématiquement), on réécrit le
 * document courant avec — sinon un simple window.location.reload() re-servirait
 * l'index.html natif figé dans l'APK et ignorerait silencieusement toute évolution
 * HTML pourtant déjà vérifiée par SHA-256 avec le reste du bundle. Le document réécrit
 * réexécute lui-même le bootloader (même vérification SHA-256, même injection
 * style.css/app.js), donc rien ne change pour ces deux fichiers.
 */
function reloadJarvisApp() {
  try {
    const activeBundleStr = localStorage.getItem(OTA_KEYS.activeBundle);
    if (activeBundleStr) {
      const bundle = JSON.parse(activeBundleStr);
      if (bundle && bundle.files && bundle.files['index.html']) {
        document.open();
        document.write(bundle.files['index.html']);
        document.close();
        return;
      }
    }
  } catch (err) {
    console.error('[OTA] Échec de rechargement via le index.html du bundle, repli sur reload() :', err);
  }
  window.location.reload();
}

async function checkOtaUpdates(isManual = false) {
  state.ota.lastCheck = new Date().toLocaleString();
  localStorage.setItem(OTA_KEYS.lastCheck, state.ota.lastCheck);

  try {
    const manifest = await fetchApi('/api/ota/manifest');

    if (manifest.minimumNativeVersion && compareVersions(manifest.minimumNativeVersion, NATIVE_VERSION) > 0) {
      if (isManual) {
        alert(`Cette mise à jour (version native requise : ${manifest.minimumNativeVersion}) nécessite de télécharger un nouvel APK Android.`);
      }
      return null;
    }

    // La détection d'une nouvelle mise à jour repose sur l'identité unique du bundle
    // (buildId ou SHA-256), pas sur une comparaison de numéro de version : ça évite de
    // dépendre d'un OTA_VERSION bumpé à la main et empêche de réinstaller en boucle un
    // bundle déjà actif même si son numéro de version affiché n'a pas changé.
    const manifestIdentity = getOtaManifestIdentity(manifest);
    const activeIdentity = getActiveOtaIdentity();

    if (manifestIdentity && activeIdentity && manifestIdentity === activeIdentity) {
      if (isManual) {
        alert(`Votre Jarvis Command Center est déjà à jour (version OTA active : v${state.ota.activeVersion}).`);
      }
      return null;
    }

    if (!isManual) {
      // Vérification automatique au démarrage : téléchargement, vérification SHA-256
      // et installation sans aucune interaction utilisateur. Un hash invalide annule
      // silencieusement l'installation ; l'ancienne version active reste en place.
      try {
        const { bundleString, computedHash } = await fetchAndVerifyOtaBundle(manifest);
        persistOtaInstall(manifest, bundleString, computedHash, activeIdentity);
        reloadJarvisApp();
      } catch (err) {
        console.error('[OTA] Mise à jour automatique refusée :', err.message);
        return null;
      }
      return manifest;
    }

    showOtaBanner(manifest);
    return manifest;
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
      <button class="btn btn-primary btn-sm" onclick="applyOtaUpdate()">Mettre à jour</button>
      <button class="btn btn-secondary btn-sm" onclick="closeOtaBanner()">Plus tard</button>
    </div>
  `;
}

function closeOtaBanner() {
  if (elements.otaBanner) elements.otaBanner.style.display = 'none';
}

async function applyOtaUpdate() {
  try {
    const manifest = await fetchApi('/api/ota/manifest');

    const manifestIdentity = getOtaManifestIdentity(manifest);
    const activeIdentity = getActiveOtaIdentity();
    if (manifestIdentity && activeIdentity && manifestIdentity === activeIdentity) {
      // Ne jamais réinstaller un bundle déjà actif, même sur un clic manuel répété.
      alert(`Votre Jarvis Command Center est déjà à jour (version OTA active : v${state.ota.activeVersion}).`);
      closeOtaBanner();
      return;
    }

    const { bundleString, computedHash } = await fetchAndVerifyOtaBundle(manifest);
    persistOtaInstall(manifest, bundleString, computedHash, activeIdentity);

    alert(`✅ Mise à jour OTA v${manifest.version} installée avec succès !`);
    reloadJarvisApp();
  } catch (err) {
    if (err && err.code === 'OTA_SHA256_MISMATCH') {
      alert(`⚠️ ${err.message} Mise à jour annulée.`);
      return;
    }
    alert(`Erreur lors de l'installation de la mise à jour OTA : ${err.message}`);
  }
}

function rollbackOtaUpdate() {
  const prevVersion = localStorage.getItem(OTA_KEYS.previousVersion);
  const prevBundle = localStorage.getItem(OTA_KEYS.previousBundle);
  const prevBuildId = localStorage.getItem(OTA_KEYS.previousBuildId);
  const prevSha256 = localStorage.getItem(OTA_KEYS.previousSha256);

  if (!prevVersion) {
    alert('Aucune version précédente disponible pour le rollback.');
    return;
  }

  if (confirm(`Voulez-vous vraiment revenir à la version précédente (v${prevVersion}) ?`)) {
    localStorage.setItem(OTA_KEYS.activeVersion, prevVersion);
    localStorage.setItem(OTA_KEYS.activeBuildId, prevBuildId || '');
    localStorage.setItem(OTA_KEYS.activeSha256, prevSha256 || '');
    if (prevBundle) {
      localStorage.setItem(OTA_KEYS.activeBundle, prevBundle);
    } else {
      localStorage.removeItem(OTA_KEYS.activeBundle);
    }

    localStorage.removeItem(OTA_KEYS.previousVersion);
    localStorage.removeItem(OTA_KEYS.previousBundle);
    localStorage.removeItem(OTA_KEYS.previousBuildId);
    localStorage.removeItem(OTA_KEYS.previousSha256);

    state.ota.activeVersion = prevVersion;
    state.ota.activeBuildId = prevBuildId || null;
    state.ota.activeSha256 = prevSha256 || null;
    state.ota.previousVersion = null;
    state.ota.previousBuildId = null;
    state.ota.previousSha256 = null;

    alert(`✅ Rollback effectué. Retour à la version v${prevVersion}.`);
    reloadJarvisApp();
  }
}

// --- NAVIGATION LOGIC ---
function switchView(viewName) {
  state.activeView = viewName;
  localStorage.setItem('jarvis_last_view', viewName);

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
      case 'autonomy':
        await renderAutonomyView();
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
const SERVICE_STAGE_LABELS = {
  GITHUB_AUTHENTICATING: 'Connexion GitHub',
  GITHUB_AUTHENTICATED: 'GitHub connecté',
  USING_EXACT_CONTENT: 'Contenu préparé',
  GENERATING_CODE_UPDATE: 'Génération du code',
  GITHUB_CREATING_BRANCH: 'Création de la branche',
  GITHUB_BRANCH_CREATED: 'Branche prête',
  GITHUB_UPDATING_FILE: 'Mise à jour du fichier',
  GITHUB_FILE_UPDATED: 'Fichier mis à jour',
  GITHUB_CHECKING_DIFF: 'Vérification du diff',
  GITHUB_DIFF_VERIFIED: 'Diff vérifié',
  GITHUB_CREATING_PR: 'Création de la Pull Request',
  GITHUB_PR_CREATED: 'Pull Request prête',
};

const TERMINAL_OPERATION_STATUSES = new Set([
  'COMPLETED',
  'FAILED',
  'REJECTED',
  'CANCELLED',
  'WAITING_INPUT',
  'WAITING_PERMISSION',
]);

const ACTIVE_SERVICE_STAGES = new Set([
  'GITHUB_AUTHENTICATING',
  'GENERATING_CODE_UPDATE',
  'GITHUB_CREATING_BRANCH',
  'GITHUB_UPDATING_FILE',
  'GITHUB_CHECKING_DIFF',
  'GITHUB_CREATING_PR',
]);

function serviceEventToTimelineEntry(event) {
  const payload = event && payloadIsRecord(event.payload) ? event.payload : {};
  let label;
  let state = 'complete';

  switch (event && event.type) {
    case 'TASK_ACCEPTED':
      label = 'Tâche acceptée';
      break;
    case 'TASK_PROGRESS':
      label = SERVICE_STAGE_LABELS[payload.stage] || (payload.message != null ? String(payload.message) : 'Progression');
      if (ACTIVE_SERVICE_STAGES.has(payload.stage) || (payload.stage == null && payload.message != null)) {
        state = 'active-candidate';
      }
      break;
    case 'NEEDS_INPUT':
      label = 'Information utilisateur requise';
      state = 'active';
      break;
    case 'NEEDS_PERMISSION':
      label = 'Approbation requise';
      state = 'active';
      break;
    case 'TASK_COMPLETED':
      label = 'Terminé';
      break;
    case 'TASK_FAILED':
      label = 'Échec';
      state = 'failed';
      break;
    case 'TASK_REJECTED':
      label = 'Rejeté';
      state = 'failed';
      break;
    default:
      label = event && event.type ? String(event.type) : 'Événement de service';
  }

  return { label, state };
}

function timelineMarkerForEntry(entry, isLast, operationStatus) {
  if (entry.state === 'failed') return '×';
  if (entry.state === 'active') return '●';
  if (entry.state === 'active-candidate' && isLast && !TERMINAL_OPERATION_STATUSES.has(operationStatus)) return '●';
  return '✓';
}

function payloadIsRecord(payload) {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload);
}

function normalizeOperations(data) {
  return Array.isArray(data) ? data : Array.isArray(data && data.operations) ? data.operations : [];
}

function createTimelineCard(host, operation) {
  const card = document.createElement('section');
  card.className = 'chat-timeline';
  const heading = document.createElement('div');
  heading.className = 'chat-timeline-heading';
  heading.textContent = 'Jarvis';
  const status = document.createElement('span');
  status.className = 'chat-timeline-status';
  const steps = document.createElement('div');
  steps.className = 'chat-timeline-steps';
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'Détails';
  const raw = document.createElement('pre');
  details.append(summary, raw);
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'chat-timeline-toggle';
  toggle.textContent = 'Voir les détails';
  toggle.setAttribute('aria-expanded', 'true');
  toggle.addEventListener('click', () => {
    const expanded = card.classList.toggle('expanded');
    toggle.textContent = expanded ? 'Masquer les détails' : 'Voir les détails';
    toggle.setAttribute('aria-expanded', String(expanded));
  });
  card.append(heading, status, steps, details, toggle);
  host.appendChild(card);
  host.hidden = false;
  return { card, status, steps, raw, operation };
}

function validHttpUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function appendApprovalControls(host, operation, onDecision) {
  if (operation.status !== 'WAITING_PERMISSION' || operation.approvalState !== 'PENDING') return;
  const panel = document.createElement('div');
  panel.className = 'approval-controls';
  const title = document.createElement('strong');
  title.textContent = 'Approbation requise';
  const risk = document.createElement('div');
  risk.textContent = `Niveau : ${operation.riskLevel}`;
  const reason = document.createElement('div');
  reason.textContent = operation.approvalReason || 'Approbation humaine requise avant dispatch.';
  const approve = document.createElement('button');
  approve.className = 'btn btn-primary';
  approve.textContent = 'Autoriser';
  const reject = document.createElement('button');
  reject.className = 'btn btn-secondary';
  reject.textContent = 'Refuser';
  const decide = async (action) => {
    approve.disabled = reject.disabled = true;
    try {
      let value;
      if (action === 'authorize' && operation.riskLevel === 'CRITICAL') {
        value = window.prompt('Saisissez APPROVE_CRITICAL pour confirmer :');
        if (value !== 'APPROVE_CRITICAL') return;
      }
      await fetchApi(`/api/operations/${encodeURIComponent(operation.taskId)}/respond`, {
        method: 'POST', body: JSON.stringify({ action, value }),
      });
      await onDecision();
    } finally {
      approve.disabled = reject.disabled = false;
    }
  };
  approve.addEventListener('click', () => void decide('authorize'));
  reject.addEventListener('click', () => void decide('reject'));
  const buttons = document.createElement('div');
  buttons.className = 'approval-buttons';
  buttons.append(approve, reject);
  panel.append(title, risk, reason, buttons);
  host.appendChild(panel);
}

function applyThemeRuntime(themeName) {
  const root = typeof document !== 'undefined' ? (document.documentElement || document.body) : null;
  if (!root || !root.classList) return;
  root.classList.remove('theme-light', 'theme-dark');
  if (themeName === 'LIGHT') {
    root.classList.add('theme-light');
  } else if (themeName === 'DARK') {
    root.classList.add('theme-dark');
  }
}

function renderTimelineCard(view, operation, events) {
  const timelineMode = localStorage.getItem('jarvis_timeline_mode') || 'AUTO';
  const expandCompleted = localStorage.getItem('jarvis_expand_completed_missions') === 'true';

  view.status.textContent = operation.status === 'COMPLETED'
    ? `✓ Mission terminée · ${events.length} étape${events.length > 1 ? 's' : ''}`
    : operation.status;
  view.status.dataset.status = operation.status;
  view.card.classList.toggle('terminal', TERMINAL_OPERATION_STATUSES.has(operation.status));

  if (timelineMode === 'ALWAYS' || (operation.status === 'COMPLETED' && expandCompleted)) {
    view.card.classList.add('expanded');
  } else if (timelineMode === 'COMPACT') {
    view.card.classList.remove('expanded');
  }

  const toggle = view.card.querySelector('.chat-timeline-toggle');
  if (toggle) toggle.hidden = !TERMINAL_OPERATION_STATUSES.has(operation.status);
  view.steps.replaceChildren();

  events.forEach((event, index) => {
    const entry = serviceEventToTimelineEntry(event);
    const row = document.createElement('div');
    row.className = `chat-timeline-step ${entry.state}`;
    const marker = document.createElement('span');
    marker.textContent = timelineMarkerForEntry(entry, index === events.length - 1, operation.status);
    const label = document.createElement('span');
    label.textContent = entry.label;
    row.append(marker, label);

    if (event.type === 'TASK_COMPLETED') {
      const prUrl = validHttpUrl(event.payload && event.payload.pr_url);
      if (prUrl) {
        const link = document.createElement('a');
        link.href = prUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'Voir la Pull Request';
        row.appendChild(link);
      }
      const artifactCount = Array.isArray(event.payload && event.payload.artifacts) ? event.payload.artifacts.length : 0;
      if (artifactCount > 0) {
        const produced = document.createElement('span'); produced.textContent = `${artifactCount} livrable(s) produit(s)`; row.appendChild(produced);
        if (operation.workspaceId) { const access = document.createElement('button'); access.className = 'btn btn-secondary btn-sm'; access.textContent = 'Accéder au workspace'; access.addEventListener('click', () => switchView('tasks')); row.appendChild(access); }
      }
    }
    view.steps.appendChild(row);
  });
  appendApprovalControls(view.steps, operation, async () => {
    const refreshed = await fetchApi(`/api/operations/${encodeURIComponent(operation.taskId)}`);
    const eventData = await fetchApi(`/api/operations/${encodeURIComponent(operation.taskId)}/events`);
    renderTimelineCard(view, refreshed, Array.isArray(eventData.events) ? eventData.events : []);
  });

  const safeEvents = events.map((event) => ({ ...event, payload: payloadIsRecord(event.payload) ? { ...event.payload, artifacts: Array.isArray(event.payload.artifacts) ? event.payload.artifacts.map(({ content_base64, ...descriptor }) => descriptor) : event.payload.artifacts } : event.payload }));
  view.raw.textContent = JSON.stringify({
    task_id: operation.taskId,
    trace_id: operation.traceId,
    service: operation.selectedService,
    status: operation.status,
    events: safeEvents,
  }, null, 2);
}

const waitForTimelinePoll = () => new Promise((resolve) => setTimeout(resolve, 900));

async function pollTimelineOperation(initialOperation, view) {
  let operation = initialOperation;
  while (true) {
    try {
      const eventData = await fetchApi(`/api/operations/${encodeURIComponent(operation.taskId)}/events`);
      operation = await fetchApi(`/api/operations/${encodeURIComponent(operation.taskId)}`);
      const events = Array.isArray(eventData.events) ? eventData.events : [];
      renderTimelineCard(view, operation, events);
      if (TERMINAL_OPERATION_STATUSES.has(operation.status)) {
        const finalEventData = await fetchApi(`/api/operations/${encodeURIComponent(operation.taskId)}/events`);
        renderTimelineCard(view, operation, Array.isArray(finalEventData.events) ? finalEventData.events : []);
        return;
      }
    } catch (err) {
      view.status.textContent = `Indisponible : ${err.message}`;
      return;
    }
    await waitForTimelinePoll();
  }
}

async function monitorChatOperations(requestId, host, control) {
  const detectedTaskIds = new Set();
  const discover = async () => {
    let operations;
    try {
      operations = normalizeOperations(await fetchApi('/api/operations'));
    } catch {
      return;
    }
    for (const operation of operations) {
      // Corrélation par identifiant explicite (traceId = requestId de ce tour), pas par
      // fenêtre de temps : deux clients concurrents ne partagent jamais de requestId et ne
      // peuvent donc jamais voir les opérations l'un de l'autre.
      if (operation.traceId !== requestId || detectedTaskIds.has(operation.taskId)) continue;
      detectedTaskIds.add(operation.taskId);
      const view = createTimelineCard(host, operation);
      void pollTimelineOperation(operation, view);
    }
  };

  while (control.chatPending) {
    await discover();
    await waitForTimelinePoll();
  }
  await discover();
}

function isNearChatBottom(box, threshold = 96) {
  return box.scrollHeight - box.scrollTop - box.clientHeight <= threshold;
}

function scrollChatIfNearBottom(box, wasNearBottom = true) {
  if (wasNearBottom) box.scrollTop = box.scrollHeight;
}

async function copyPlainText(text, navigatorRef = window.navigator) {
  if (navigatorRef.clipboard && typeof navigatorRef.clipboard.writeText === 'function') {
    await navigatorRef.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('Copie indisponible');
}

function createMessageAction(label, title, handler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'chat-action';
  button.textContent = label;
  button.title = title;
  button.setAttribute('aria-label', title);
  button.addEventListener('click', handler);
  return button;
}

function updateRegenerateAvailability() {
  const responses = Array.from(document.querySelectorAll('.msg.agent[data-final="true"]'));
  responses.forEach((message, index) => {
    const button = message.querySelector('[data-action="regenerate"]');
    if (button) button.hidden = index !== responses.length - 1;
  });
}

function renderChatView() {
  const container = document.getElementById('view-chat');
  if (!container || !container.children || container.children.length > 0) return;

  const layout = document.createElement('div'); layout.className = 'chat-layout';
  const messages = document.createElement('div'); messages.id = 'chat-messages'; messages.className = 'chat-messages';
  const form = document.createElement('form'); form.id = 'chat-form'; form.className = 'chat-composer';
  const input = document.createElement('textarea'); input.id = 'chat-input'; input.className = 'input-field chat-input'; input.rows = 1; input.placeholder = 'Posez une question ou demandez une action…'; input.setAttribute('aria-label', 'Message à Jarvis');
  const sendButton = document.createElement('button'); sendButton.type = 'submit'; sendButton.id = 'chat-send'; sendButton.className = 'btn btn-primary chat-send'; sendButton.textContent = 'Envoyer';
  form.append(input, sendButton); layout.append(messages, form); container.appendChild(layout);
  appendChatMessage('agent', "Bonjour, je suis Jarvis Command Center. Comment puis-je vous aider aujourd'hui ?", { regeneratable: false });

  let submitting = false;
  const resizeInput = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 160)}px`; };
  input.addEventListener('input', resizeInput);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submitting) return;
    const text = input.value.trim();
    if (!text) return;
    submitting = true;
    input.value = ''; resizeInput();
    sendButton.disabled = true; sendButton.textContent = 'Envoi…';

    // requestId : identifiant unique de CE tour, généré avant l'envoi et transmis au serveur
    // (voir Agent.step/httpApi.ts). Corrèle de façon fiable les opérations affichées en
    // direct pendant la requête, sans dépendre d'une fenêtre de temps qui peut faire
    // apparaître chez un client les opérations déclenchées par un autre client concurrent.
    // Envoyé à la fois comme `requestId` (route directe httpApi.ts /api/chat) et
    // `clientRequestId` (route réellement active en production : l'ingress de conversation
    // durable — installConversationHttpIngress — intercepte /api/chat avant httpApi.ts et ne
    // lit que ce second nom de champ).
    const requestId = newRequestId();
    appendChatMessage('user', text);
    const timelineHost = document.createElement('div'); timelineHost.className = 'chat-timeline-host'; timelineHost.hidden = true; messages.appendChild(timelineHost);
    const pendingEl = appendChatMessage('agent pending', 'Jarvis is thinking...');
    const monitorControl = { chatPending: true };
    void monitorChatOperations(requestId, timelineHost, monitorControl);

    try {
      const res = await fetchApi('/api/chat', { method: 'POST', body: JSON.stringify({ message: text, requestId, clientRequestId: requestId }) });
      pendingEl?.remove(); appendChatMessage('agent', res.response);
    } catch (err) {
      pendingEl?.remove();
      appendChatMessage('agent error', `⚠️ Erreur : ${err.message}`);
    } finally {
      monitorControl.chatPending = false; submitting = false; sendButton.disabled = false; sendButton.textContent = 'Envoyer'; input.focus();
    }
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit')); }
  });
}

function appendChatMessage(role, text, options = {}) {
  const box = document.getElementById('chat-messages');
  if (!box) return null;
  const shouldScroll = isNearChatBottom(box);
  const article = document.createElement('article'); article.className = `msg ${role}`;
  const label = document.createElement('div'); label.className = 'msg-label'; label.textContent = role.includes('user') ? 'Vous' : 'Jarvis';
  const content = document.createElement('div'); content.className = 'msg-content'; content.textContent = text;
  article.append(label, content);

  if (!role.includes('pending') && !role.includes('error')) {
    const actions = document.createElement('div'); actions.className = 'msg-actions';
    const copy = createMessageAction('Copier', 'Copier le texte du message', async () => {
      try { await copyPlainText(content.textContent || ''); copy.textContent = 'Copié ✓'; setTimeout(() => { copy.textContent = 'Copier'; }, 1600); } catch { copy.textContent = 'Échec'; }
    });
    actions.appendChild(copy);
    if (role.includes('user')) {
      actions.prepend(createMessageAction('Modifier', 'Modifier ce message', () => {
        const input = document.getElementById('chat-input'); input.value = content.textContent || ''; input.dispatchEvent(new Event('input')); input.focus();
      }));
    } else {
      if (options.regeneratable !== false) article.dataset.final = 'true';
      if ('speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function') {
        const read = createMessageAction('Lire', 'Lire cette réponse à voix haute', () => {
          if (read.dataset.reading === 'true') { window.speechSynthesis.cancel(); read.dataset.reading = 'false'; read.textContent = 'Lire'; return; }
          window.speechSynthesis.cancel();
          document.querySelectorAll('[data-action="read"]').forEach((other) => { other.dataset.reading = 'false'; other.textContent = 'Lire'; });
          const utterance = new window.SpeechSynthesisUtterance(content.textContent || ''); utterance.lang = 'fr-FR';
          const reset = () => { read.dataset.reading = 'false'; read.textContent = 'Lire'; }; utterance.onend = reset; utterance.onerror = reset;
          read.dataset.action = 'read'; read.dataset.reading = 'true'; read.textContent = 'Arrêter'; window.speechSynthesis.speak(utterance);
        }); read.dataset.action = 'read'; actions.appendChild(read);
      }
      const regenerate = createMessageAction('Régénérer', 'Reformuler cette réponse', async () => {
        if (regenerate.disabled) return;
        const oldText = content.textContent; regenerate.disabled = true; regenerate.textContent = 'Régénération…';
        try { const result = await fetchApi('/api/chat/regenerate', { method: 'POST', body: '{}' }); content.textContent = result.response; }
        catch { content.textContent = oldText; regenerate.textContent = 'Erreur — réessayer'; setTimeout(() => { regenerate.textContent = 'Régénérer'; }, 2200); }
        finally { regenerate.disabled = false; if (regenerate.textContent === 'Régénération…') regenerate.textContent = 'Régénérer'; }
      });
      if (options.regeneratable !== false) {
        regenerate.dataset.action = 'regenerate';
        actions.appendChild(regenerate);
      }
    }
    article.appendChild(actions);
  }
  box.appendChild(article); updateRegenerateAvailability(); scrollChatIfNearBottom(box, shouldScroll); return article;
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
    const cards = container.querySelectorAll('.card');
    ops.forEach((op, index) => {
      const card = cards[index];
      if (op.executionMode === 'background') { const badge=document.createElement('span'); badge.className='badge badge-info'; badge.textContent='Background'; card.appendChild(badge); }
      if (op.status === 'QUEUED' || op.status === 'WAITING_PERMISSION') { const button=document.createElement('button'); button.className='btn btn-secondary'; button.textContent='Annuler'; button.onclick=async()=>{await fetchApi(`/api/operations/${encodeURIComponent(op.taskId)}/cancel`,{method:'POST'});await renderOperationsView();};card.appendChild(button); }
      if (op.cancelRequestedAt && (op.status === 'RUNNING' || op.status === 'DISPATCHING')) { const note=document.createElement('div');note.className='card-subtext';note.textContent='Annulation demandée — effet externe non garanti.';card.appendChild(note); }
      appendApprovalControls(card, op, renderOperationsView);
    });
  } catch (err) {
    container.innerHTML = `<div class="card" style="border-color: var(--accent-danger);"><div class="card-title" style="color: var(--accent-danger);">${err.message}</div></div>`;
  }
}

async function renderAutonomyView() {
  const container=document.getElementById('view-autonomy'); container.replaceChildren();
  const heading=document.createElement('h2');heading.textContent='Autonomie';container.appendChild(heading);
  try {
    const [notifications,schedules,count]=await Promise.all([fetchApi('/api/notifications'),fetchApi('/api/schedules'),fetchApi('/api/notifications/unread-count')]);
    document.getElementById('notification-count').textContent=count.count?`(${count.count})`:'';
    const makeSection=(title)=>{const card=document.createElement('div');card.className='card';const h=document.createElement('div');h.className='card-title';h.textContent=title;card.appendChild(h);container.appendChild(card);return card;};
    const inbox=makeSection('Notifications');
    for(const item of notifications){const row=document.createElement('div');row.className='autonomy-row';const text=document.createElement('span');text.textContent=`${item.title} — ${item.message}`;row.appendChild(text);if(!item.readAt){const b=document.createElement('button');b.className='btn btn-secondary';b.textContent='Marquer comme lu';b.onclick=async()=>{await fetchApi(`/api/notifications/${encodeURIComponent(item.id)}/read`,{method:'POST'});await renderAutonomyView();};row.appendChild(b);}inbox.appendChild(row);}
    const scheduleBox=makeSection('Planifications');
    for(const item of schedules){const row=document.createElement('div');row.className='autonomy-row';const text=document.createElement('span');text.textContent=`${item.title} · ${item.taskType} · ${item.nextRunAt?new Date(item.nextRunAt).toLocaleString():'terminé'} · ${item.repeatIntervalMs?`toutes les ${item.repeatIntervalMs} ms`:'une fois'}`;row.appendChild(text);const b=document.createElement('button');b.className='btn btn-secondary';b.textContent=item.enabled?'Désactiver':'Activer';b.onclick=async()=>{await fetchApi(`/api/schedules/${encodeURIComponent(item.id)}/${item.enabled?'disable':'enable'}`,{method:'POST'});await renderAutonomyView();};row.appendChild(b);scheduleBox.appendChild(row);}
  } catch(err) { const error=document.createElement('div');error.textContent=err.message;container.appendChild(error); }
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
function appendPlanField(host, label, value) {
  const row = document.createElement('div');
  const strong = document.createElement('strong');
  strong.textContent = `${label} : `;
  const text = document.createElement('span');
  text.textContent = value;
  row.append(strong, text);
  host.appendChild(row);
}

async function showPlanOperation(host, taskId) {
  host.replaceChildren();
  const operation = await fetchApi(`/api/operations/${encodeURIComponent(taskId)}`);
  const eventData = await fetchApi(`/api/operations/${encodeURIComponent(taskId)}/events`);
  const view = createTimelineCard(host, operation);
  renderTimelineCard(view, operation, Array.isArray(eventData.events) ? eventData.events : []);
  if (!TERMINAL_OPERATION_STATUSES.has(operation.status)) void pollTimelineOperation(operation, view);
}

async function renderPlanDetails(host, plans) {
  host.replaceChildren();
  if (plans.length === 0) {
    const empty = document.createElement('div');
    empty.style.color = 'var(--text-muted)';
    empty.textContent = 'Aucun plan.';
    host.appendChild(empty);
    return;
  }
  const marks = { done: '✓', in_progress: '●', pending: '○', waiting: '⏸', failed: '×', abandoned: '↻', cancelled: '×' };
  for (const plan of plans) {
    const nodes = await fetchApi(`/api/plans/${encodeURIComponent(plan.id)}/nodes`);
    const activeNodes = nodes.filter((node) => node.status === 'in_progress' || node.status === 'waiting');
    const current = activeNodes[0];
    const planMetrics = await fetchApi(`/api/plans/${encodeURIComponent(plan.id)}/metrics`);
    const activityData = await fetchApi(`/api/activity?planRunId=${encodeURIComponent(plan.id)}&limit=200`);
    const card = document.createElement('article'); card.className = 'plan-card';
    const header = document.createElement('header');
    const objective = document.createElement('strong'); objective.textContent = String(plan.objective);
    const status = document.createElement('span'); status.className = 'chat-timeline-status'; status.dataset.status = String(plan.status); status.textContent = String(plan.status);
    header.append(objective, status); card.appendChild(header);
    appendPlanField(card, 'Génération', String(plan.generation));
    appendPlanField(card, 'Replan', `${plan.replanCount}/${plan.maxReplans}`);
    appendPlanField(card, 'Étapes actives', String(activeNodes.length));
    appendPlanField(card, 'Durée', planMetrics.durationMs == null ? '—' : `${Number(planMetrics.durationMs)} ms`);
    appendPlanField(card, 'Peak parallelism', String(planMetrics.peakParallelism || 0));
    appendPlanField(card, 'Spécialistes utilisés', Array.isArray(planMetrics.specialists) && planMetrics.specialists.length ? planMetrics.specialists.join(', ') : '—');
    if (plan.workspaceId) {
      appendPlanField(card, 'Workspace', String(plan.workspaceId));
      const workspace = document.createElement('section');
      const workspaceTitle = document.createElement('strong'); workspaceTitle.textContent = 'Fichiers & livrables';
      const files = await fetchApi(`/api/workspaces/${encodeURIComponent(plan.workspaceId)}/files`);
      const artifacts = await fetchApi(`/api/workspaces/${encodeURIComponent(plan.workspaceId)}/artifacts`);
      const fileList = document.createElement('ul');
      for (const file of files) { const item = document.createElement('li'); const label = document.createElement('span'); label.textContent = `${String(file.path)} (${Number(file.size)} octets) `; const download = document.createElement('button'); download.className = 'btn btn-secondary btn-sm'; download.textContent = 'Télécharger'; download.addEventListener('click', async () => { const response = await fetch(`${state.backendUrl}/api/workspaces/${encodeURIComponent(plan.workspaceId)}/files/content?path=${encodeURIComponent(file.path)}`, { headers: { Authorization: `Bearer ${state.token}` } }); const blob = await response.blob(); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = String(file.path).split('/').pop(); link.click(); URL.revokeObjectURL(link.href); }); item.append(label, download); fileList.appendChild(item); }
      const artifactList = document.createElement('ul');
      for (const artifact of artifacts) { const item = document.createElement('li'); const label = document.createElement('span'); label.textContent = `${String(artifact.name)} · ${String(artifact.kind)} · ${String(artifact.mimeType || '')} · ${String(artifact.operationTaskId || 'manuel')} `; item.appendChild(label); if (artifact.kind === 'LINK') { const url = validHttpUrl(artifact.externalUrl); if (url) { const open = document.createElement('button'); open.className = 'btn btn-secondary btn-sm'; open.textContent = 'Ouvrir'; open.addEventListener('click', () => window.open(url, '_blank', 'noopener,noreferrer')); item.appendChild(open); } } else { const download = document.createElement('button'); download.className = 'btn btn-secondary btn-sm'; download.textContent = 'Télécharger'; download.addEventListener('click', async () => { const response = await fetch(`${state.backendUrl}/api/artifacts/${encodeURIComponent(artifact.id)}?download=1`, { headers: { Authorization: `Bearer ${state.token}` } }); const blob = await response.blob(); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = String(artifact.name); link.click(); URL.revokeObjectURL(link.href); }); item.appendChild(download); } artifactList.appendChild(item); }
      const upload = document.createElement('input'); upload.type = 'file'; upload.addEventListener('change', async () => { const file = upload.files?.[0]; if (!file) return; const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); await fetchApi(`/api/workspaces/${encodeURIComponent(plan.workspaceId)}/files`, { method: 'POST', body: JSON.stringify({ path: file.name, contentBase64: btoa(binary), mimeType: file.type || 'application/octet-stream' }) }); await renderTasksView(); });
      workspace.append(workspaceTitle, fileList, artifactList, upload); card.appendChild(workspace);
    }
    if (current) appendPlanField(card, 'Étape actuelle', String(current.title));
    const list = document.createElement('ol');
    for (const node of nodes) {
      const item = document.createElement('li'); item.className = `plan-step ${node.status}`;
      const mark = document.createElement('span'); mark.textContent = marks[node.status] || '○';
      const detail = document.createElement('div');
      const title = document.createElement('strong'); title.textContent = String(node.title);
      const capability = document.createElement('span'); capability.textContent = ` · ${String(node.capability || 'racine')}`;
      detail.append(title, capability);
      appendPlanField(detail, 'Dépendances', Array.isArray(node.dependencies) && node.dependencies.length ? node.dependencies.join(', ') : 'aucune');
      appendPlanField(detail, 'Spécialiste', node.specialistId ? String(node.specialistId) : '—');
      appendPlanField(detail, 'Operation task', node.operationTaskId ? String(node.operationTaskId) : '—');
      if (node.operationTaskId) { const metrics = await fetchApi(`/api/operations/${encodeURIComponent(node.operationTaskId)}/metrics`); appendPlanField(detail, 'Service', String(metrics.selected_service || '—')); appendPlanField(detail, 'Durée', metrics.duration_ms == null ? '—' : `${Number(metrics.duration_ms)} ms`); appendPlanField(detail, 'Retries', String(metrics.retry_count || 0)); appendPlanField(detail, 'Tokens', metrics.total_tokens == null ? '—' : String(metrics.total_tokens)); appendPlanField(detail, 'Coût', metrics.cost_usd == null ? '—' : `$${Number(metrics.cost_usd)}`); appendPlanField(detail, 'Artifacts', String(metrics.artifact_count || 0)); }
      if (node.result !== undefined) { const result = document.createElement('pre'); result.textContent = String(node.result); detail.appendChild(result); }
      if (node.error !== undefined) { const error = document.createElement('div'); error.className = 'plan-error'; error.textContent = String(node.error); detail.appendChild(error); }
      if (node.operationTaskId) {
        const operationHost = document.createElement('div'); operationHost.className = 'plan-operation';
        const show = document.createElement('button'); show.className = 'btn btn-secondary btn-sm'; show.textContent = 'Voir la timeline réelle';
        show.addEventListener('click', () => void showPlanOperation(operationHost, String(node.operationTaskId)));
        detail.append(show, operationHost);
        if (node.status === 'waiting') {
          const operation = await fetchApi(`/api/operations/${encodeURIComponent(node.operationTaskId)}`);
          appendApprovalControls(detail, operation, async () => { await showPlanOperation(operationHost, String(node.operationTaskId)); await renderTasksView(); });
        }
      }
      item.append(mark, detail); list.appendChild(item);
    }
    card.appendChild(list);
    const activityTitle = document.createElement('strong'); activityTitle.textContent = 'Activité factuelle'; const activityList = document.createElement('ul'); for (const event of Array.isArray(activityData.items) ? activityData.items : []) { const item = document.createElement('li'); item.textContent = `${new Date(Number(event.timestamp)).toLocaleString()} · ${String(event.event_type)} · ${String(event.message)}`; activityList.appendChild(item); } card.append(activityTitle, activityList);
    if (!['COMPLETED', 'CANCELLED', 'FAILED'].includes(plan.status)) {
      const cancel = document.createElement('button'); cancel.className = 'btn btn-secondary btn-sm'; cancel.textContent = 'Annuler le plan';
      cancel.addEventListener('click', async () => { await fetchApi(`/api/plans/${encodeURIComponent(plan.id)}/cancel`, { method: 'POST' }); await renderTasksView(); });
      card.appendChild(cancel);
    }
    host.appendChild(card);
  }
}

async function renderTasksView() {
  const container = document.getElementById('view-tasks');
  container.replaceChildren();
  const loading = document.createElement('div'); loading.className = 'card'; loading.textContent = 'Chargement des tâches et plans...'; container.appendChild(loading);
  try {
    const [tasksData, plansData] = await Promise.all([fetchApi('/api/tasks'), fetchApi('/api/plans')]);
    const tasks = Array.isArray(tasksData) ? tasksData : Array.isArray(tasksData?.tasks) ? tasksData.tasks : [];
    const plans = Array.isArray(plansData) ? plansData : [];
    container.replaceChildren();
    const heading = document.createElement('h2'); heading.textContent = 'Tâches Personnelles & Plans'; container.appendChild(heading);
    const taskCard = document.createElement('div'); taskCard.className = 'card';
    const taskTitle = document.createElement('div'); taskTitle.className = 'card-title'; taskTitle.textContent = 'Liste des Tâches'; taskCard.appendChild(taskTitle);
    for (const task of tasks) { const row = document.createElement('div'); row.className = 'task-row'; row.textContent = String(task.title); taskCard.appendChild(row); }
    if (!tasks.length) { const empty = document.createElement('div'); empty.textContent = 'Aucune tâche.'; taskCard.appendChild(empty); }
    const planCard = document.createElement('div'); planCard.className = 'card';
    const planTitle = document.createElement('div'); planTitle.className = 'card-title'; planTitle.textContent = "Plans d'exécution";
    const planList = document.createElement('div'); planList.className = 'plan-list'; planCard.append(planTitle, planList);
    container.append(taskCard, planCard); await renderPlanDetails(planList, plans);
  } catch (err) {
    container.replaceChildren(); const error = document.createElement('div'); error.className = 'card plan-error'; error.textContent = err.message; container.appendChild(error);
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
  container.replaceChildren();
  const heading = document.createElement('h2'); heading.textContent = 'Skills & Workflows'; container.appendChild(heading);
  try {
    const [skillsData, workflowsData] = await Promise.all([fetchApi('/api/skills'), fetchApi('/api/workflows')]);
    const skills = Array.isArray(skillsData) ? skillsData : [];
    const workflows = Array.isArray(workflowsData) ? workflowsData : [];
    const summary = document.createElement('div'); summary.className = 'card-grid';
    const counts = [
      ['Disponibles', skills.filter(s => s.availability === 'AVAILABLE' && s.enabled).length],
      ['Désactivés', skills.filter(s => !s.enabled || s.availability === 'DISABLED').length],
      ['Internes', skills.filter(s => s.kind === 'INTERNAL' || s.kind === 'SYSTEM').length],
      ['Futurs', skills.filter(s => s.kind === 'FUTURE').length],
      ['Workflows actifs', workflows.filter(w => w.status === 'ACTIVE').length],
    ];
    counts.forEach(([label, value]) => { const card=document.createElement('div');card.className='card';const title=document.createElement('div');title.className='card-title';title.textContent=label;const number=document.createElement('div');number.className='card-value';number.textContent=String(value);card.append(title,number);summary.appendChild(card); });
    container.appendChild(summary);
    const categories=['Contrôle','Recherche','Fichiers','Communication','Technique','Workflows','Interne','Futur'];
    categories.forEach(category => {const items=skills.filter(s=>s.category===category);if(!items.length)return;const title=document.createElement('h3');title.textContent=category;container.appendChild(title);const grid=document.createElement('div');grid.className='card-grid';items.forEach(s=>{const card=document.createElement('div');card.className='card';const name=document.createElement('div');name.className='card-title';name.textContent=s.displayName||s.name;const description=document.createElement('div');description.textContent=s.description;const state=document.createElement('div');state.className='card-subtext';state.textContent=`${s.kind} · ${s.availability} · risque ${s.risk}${s.enabled?'':' · désactivé'}`;card.append(name,description,state);grid.appendChild(card);});container.appendChild(grid);});
    const workflowTitle=document.createElement('h3');workflowTitle.textContent='Workflows réutilisables';container.appendChild(workflowTitle);
    workflows.forEach(w=>{const card=document.createElement('div');card.className='card';const name=document.createElement('div');name.className='card-title';name.textContent=`${w.name} · v${w.version}`;const detail=document.createElement('div');detail.textContent=w.description;const state=document.createElement('div');state.className='card-subtext';state.textContent=`${w.source} · ${w.status} · ${w.successCount} succès${w.createdFromPlanRunId?` · plan ${w.createdFromPlanRunId}`:''}`;card.append(name,detail,state);if(['DRAFT','ACTIVE','DISABLED'].includes(w.status)){const button=document.createElement('button');button.className='btn btn-primary btn-sm';button.textContent=w.status==='ACTIVE'?'Désactiver':'Approuver';button.addEventListener('click',async()=>{await fetchApi(`/api/workflows/${encodeURIComponent(w.id)}/${w.status==='ACTIVE'?'disable':'approve'}`,{method:'POST'});await renderSkillsView();});card.appendChild(button);}container.appendChild(card);});
  } catch (err) { const card=document.createElement('div');card.className='card';const message=document.createElement('div');message.className='card-title';message.textContent=err.message;card.appendChild(message);container.appendChild(card); }
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
  } else if (provider === 'infermatic') {
    if (statusBox) statusBox.innerHTML = '<span style="color: var(--text-muted); font-size: 0.85rem;">Chargement des modèles Infermatic...</span>';
    try {
      const response = await fetchApi(`/api/models/catalog/${provider}`);
      // Pas de repli sur une liste codée en dur : le catalogue Infermatic dépend du
      // compte/abonnement et provient uniquement de GET /models côté serveur.
      state.rawCatalogModels = Array.isArray(response) ? response : [];
      if (statusBox) statusBox.textContent = '';
    } catch (err) {
      state.rawCatalogModels = [];
      if (statusBox) {
        statusBox.innerHTML = `<div style="padding: 10px; background: rgba(239,68,68,0.15); border: 1px solid var(--accent-danger); border-radius: 8px; color: var(--accent-danger);">Impossible de récupérer les modèles Infermatic : ${err.message}</div>`;
      }
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
        const badge = res.compatibility === 'JARVIS_TOOL_COMPATIBLE'
          ? '🛠️ Compatible tool calling Jarvis'
          : '💬 Compatible conversationnel uniquement';
        statusBox.innerHTML = `<div style="padding: 10px; background: rgba(16,185,129,0.15); border: 1px solid var(--accent-success); border-radius: 8px; color: var(--accent-success);">✅ ${res.message}<br/><span style="font-size: 0.8rem; opacity: 0.85;">${badge}</span></div>`;
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
          Version OTA active : <strong style="color: var(--accent-primary);">v${state.ota.activeVersion}</strong>
          ${state.ota.activeBuildId ? `(build <code>${state.ota.activeBuildId.slice(0, 10)}</code>)` : ''}<br/>
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

// 11. PARAMÈTRES VIEW (DOM SAFE, MULTI-LEVEL, SERVICE CONNECTION CENTER)
let currentDisplayLevel = localStorage.getItem('jarvis_interface_level') || 'SIMPLE';
let settingsSearchQuery = '';

async function renderSettingsView() {
  const container = document.getElementById('view-settings');
  container.replaceChildren();

  const title = document.createElement('h2');
  title.textContent = 'PARAMÈTRES JARVIS';
  container.appendChild(title);

  // Connexion Client à Jarvis : toujours rendue en premier, indépendamment
  // de tout appel backend (schema/settings/connections), pour rester
  // accessible même sur une installation neuve ou après une désinstallation
  // ayant vidé le localStorage.
  const clientConnCard = renderClientJarvisConnectionCard();
  container.appendChild(clientConnCard);

  if (!state.backendUrl) {
    const infoCard = document.createElement('div');
    infoCard.className = 'card';
    const infoText = document.createElement('div');
    infoText.className = 'card-subtext';
    infoText.textContent = "Configurez l'URL du backend et le token d'accès pour charger les paramètres Jarvis.";
    infoCard.appendChild(infoText);
    container.appendChild(infoCard);
    return;
  }

  // Top header bar with Level Selector & Actions
  const headerBar = document.createElement('div');
  headerBar.className = 'settings-header-bar';

  const levelSelector = document.createElement('div');
  levelSelector.className = 'settings-level-selector';

  ['SIMPLE', 'ADVANCED', 'EXPERT'].forEach((level) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `settings-level-btn ${currentDisplayLevel === level ? 'active' : ''}`;
    btn.textContent = level === 'SIMPLE' ? 'Simple' : level === 'ADVANCED' ? 'Avancé' : 'Expert';
    btn.addEventListener('click', async () => {
      if (currentDisplayLevel === level) return;
      try {
        await fetchApi('/api/settings', {
          method: 'PATCH',
          body: JSON.stringify({ key: 'settings.interfaceMode', value: level }),
        });
        currentDisplayLevel = level;
        applyLocalSettingCache('settings.interfaceMode', level);
        void renderSettingsView();
      } catch (e) {
        alert(`❌ Erreur lors de la mise à jour du niveau d'interface : ${e.message}`);
      }
    });
    levelSelector.appendChild(btn);
  });

  headerBar.appendChild(levelSelector);

  // Search input in EXPERT mode
  if (currentDisplayLevel === 'EXPERT') {
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'input-field settings-search-input';
    searchInput.placeholder = 'Rechercher un paramètre...';
    searchInput.value = settingsSearchQuery;
    searchInput.addEventListener('input', (e) => {
      settingsSearchQuery = e.target.value.toLowerCase().trim();
      renderSettingsSections(sectionsContainer, schema, effectiveSettings, connectionsData);
    });
    headerBar.appendChild(searchInput);
  }

  container.appendChild(headerBar);

  const sectionsContainer = document.createElement('div');
  sectionsContainer.id = 'settings-sections-container';
  container.appendChild(sectionsContainer);

  const loadingCard = document.createElement('div');
  loadingCard.className = 'card';
  loadingCard.textContent = 'Chargement des paramètres...';
  sectionsContainer.appendChild(loadingCard);

  try {
    const schema = await fetchApi('/api/settings/schema');
    const effectiveSettings = await fetchApi(`/api/settings?level=${currentDisplayLevel}`);
    const connectionsData = await fetchApi('/api/connections');

    // Synchronize local cache with effective settings from backend
    if (Array.isArray(effectiveSettings)) {
      effectiveSettings.forEach((item) => {
        const key = item.definition.key;
        const val = item.effectiveValue;
        if (key === 'settings.interfaceMode' && typeof val === 'string') {
          currentDisplayLevel = val;
          localStorage.setItem('jarvis_interface_level', val);
        } else if (key === 'settings.startupView' && typeof val === 'string') {
          localStorage.setItem('jarvis_startup_view', val);
        } else if (key === 'settings.timelineMode' && typeof val === 'string') {
          localStorage.setItem('jarvis_timeline_mode', val);
        } else if (key === 'settings.expandCompletedMissions') {
          localStorage.setItem('jarvis_expand_completed_missions', String(val));
        } else if (key === 'settings.theme' && typeof val === 'string') {
          localStorage.setItem('jarvis_theme', val);
          applyThemeRuntime(val);
        }
      });
    }

    renderSettingsSections(sectionsContainer, schema, effectiveSettings, connectionsData);
  } catch (err) {
    sectionsContainer.replaceChildren();
    const errCard = document.createElement('div');
    errCard.className = 'card';
    errCard.style.borderColor = 'var(--accent-danger)';

    const errTitle = document.createElement('div');
    errTitle.className = 'card-title';
    errTitle.style.color = 'var(--accent-danger)';
    errTitle.textContent = 'Erreur lors du chargement des paramètres';

    const errText = document.createElement('div');
    errText.className = 'card-subtext';
    errText.textContent = err.message;

    errCard.append(errTitle, errText);
    sectionsContainer.appendChild(errCard);
  }
}

function renderSettingsSections(container, schema, effectiveSettings, connections) {
  container.replaceChildren();

  const sections = Array.isArray(schema.sections) ? schema.sections : [];
  const catalog = Array.isArray(schema.catalog) ? schema.catalog : [];
  const effectiveList = Array.isArray(effectiveSettings) ? effectiveSettings : [];
  const connectionList = Array.isArray(connections) ? connections : [];

  sections.forEach((section) => {
    // Filter settings for this section and current level
    let sectionSettings = effectiveList.filter((item) => {
      const def = item.definition;
      if (def.section !== section.id) return false;
      if (currentDisplayLevel === 'SIMPLE' && def.level !== 'SIMPLE') return false;
      if (currentDisplayLevel === 'ADVANCED' && def.level === 'EXPERT') return false;
      if (settingsSearchQuery && currentDisplayLevel === 'EXPERT') {
        const matchesLabel = def.label.toLowerCase().includes(settingsSearchQuery);
        const matchesKey = def.key.toLowerCase().includes(settingsSearchQuery);
        const matchesDesc = def.description.toLowerCase().includes(settingsSearchQuery);
        return matchesLabel || matchesKey || matchesDesc;
      }
      return true;
    });

    const collapsible = document.createElement('div');
    collapsible.className = 'settings-section-collapsible';

    const header = document.createElement('div');
    header.className = 'settings-section-header';

    const headerTitle = document.createElement('span');
    headerTitle.textContent = `${section.label} (${sectionSettings.length})`;

    const toggleIcon = document.createElement('span');
    toggleIcon.textContent = '▼';

    header.append(headerTitle, toggleIcon);

    const body = document.createElement('div');
    body.className = 'settings-section-body';

    header.addEventListener('click', () => {
      const collapsed = body.classList.toggle('collapsed');
      toggleIcon.textContent = collapsed ? '▲' : '▼';
    });

    collapsible.append(header, body);

    // Special Section : Connexions & Services
    if (section.id === 'connections') {
      const servicesSection = renderServicesConnectionCenter(connectionList);
      body.appendChild(servicesSection);
    }

    // Render setting cards
    sectionSettings.forEach((setting) => {
      const card = renderSettingCard(setting);
      body.appendChild(card);
    });

    // Special Section : System -> Export & Import
    if (section.id === 'system_maintenance') {
      const exportImportCard = renderExportImportCard();
      body.appendChild(exportImportCard);
    }

    container.appendChild(collapsible);
  });

  // EXPERT MODE: Section "CAPACITÉS À VENIR" (Future Map)
  if (currentDisplayLevel === 'EXPERT') {
    const futureMapCard = renderFutureMapCard();
    container.appendChild(futureMapCard);
  }
}

function renderClientJarvisConnectionCard() {
  const card = document.createElement('div');
  card.className = 'card';

  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = 'Connexion Client à Jarvis (localStorage local)';

  const groupUrl = document.createElement('div');
  groupUrl.className = 'form-group';
  const labelUrl = document.createElement('label');
  labelUrl.className = 'form-label';
  labelUrl.textContent = 'Backend URL';
  const inputUrl = document.createElement('input');
  inputUrl.type = 'text';
  inputUrl.className = 'input-field';
  inputUrl.value = state.backendUrl;
  inputUrl.placeholder = 'ex: http://localhost:3000';
  groupUrl.append(labelUrl, inputUrl);

  const groupToken = document.createElement('div');
  groupToken.className = 'form-group';
  const labelToken = document.createElement('label');
  labelToken.className = 'form-label';
  labelToken.textContent = 'API Token (jamais affiché en clair)';
  const inputToken = document.createElement('input');
  inputToken.type = 'password';
  inputToken.className = 'input-field';
  inputToken.value = state.token;
  inputToken.placeholder = 'Token d\'accès secret';
  groupToken.append(labelToken, inputToken);

  const buttonRow = document.createElement('div');
  buttonRow.style.display = 'flex';
  buttonRow.style.gap = '10px';
  buttonRow.style.marginTop = '12px';

  const btnTest = document.createElement('button');
  btnTest.type = 'button';
  btnTest.className = 'btn btn-secondary';
  btnTest.textContent = 'Tester la connexion';
  btnTest.addEventListener('click', async () => {
    const urlVal = inputUrl.value.trim().replace(/\/+$/, '');
    const tokenVal = inputToken.value.trim();
    const testEndpoint = `${urlVal}/api/status`;
    const headers = { 'Content-Type': 'application/json' };
    if (tokenVal) headers['Authorization'] = `Bearer ${tokenVal}`;

    if (!urlVal) {
      alert("❌ Veuillez saisir une Backend URL avant de tester la connexion.");
      return;
    }

    try {
      const res = await fetch(testEndpoint, { headers });
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        throw new Error("Le serveur configuré n'a pas renvoyé une réponse API Jarvis valide.");
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      alert(`✅ Connexion réussie ! Moteur Jarvis v${data.version || '0.1.0'} en ligne.`);
    } catch (e) {
      alert(`❌ Échec de connexion : ${e.message}`);
    }
  });

  const btnSave = document.createElement('button');
  btnSave.type = 'button';
  btnSave.className = 'btn btn-primary';
  btnSave.textContent = 'Sauvegarder';
  btnSave.addEventListener('click', async () => {
    state.backendUrl = inputUrl.value.trim();
    state.token = inputToken.value.trim();
    localStorage.setItem('jarvis_backend_url', state.backendUrl);
    localStorage.setItem('jarvis_token', state.token);
    alert('✅ Paramètres de connexion enregistrés localement !');
    await renderSettingsView();
  });

  buttonRow.append(btnTest, btnSave);
  card.append(title, groupUrl, groupToken, buttonRow);
  return card;
}

function showUserServiceModal() {
  const overlay = document.createElement('div');
  overlay.className = 'sidebar-overlay active';
  overlay.style.display = 'flex';
  overlay.style.alignItems = 'center';
  overlay.style.justifyContent = 'center';
  overlay.style.zIndex = '999';

  const modal = document.createElement('div');
  modal.className = 'card';
  modal.style.maxWidth = '550px';
  modal.style.width = '90%';
  modal.style.maxHeight = '90vh';
  modal.style.overflowY = 'auto';

  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = 'Créer un Service Utilisateur (task_http)';

  const createGroup = (label, placeholder, defaultValue = '', type = 'text') => {
    const group = document.createElement('div');
    group.className = 'form-group';
    const lbl = document.createElement('label');
    lbl.className = 'form-label';
    lbl.textContent = label;
    const input = document.createElement('input');
    input.type = type;
    input.className = 'input-field';
    input.placeholder = placeholder;
    input.value = defaultValue;
    group.append(lbl, input);
    return { group, input };
  };

  const idGroup = createGroup('Service ID', 'ex: my_custom_service', 'my_custom_service');
  const nameGroup = createGroup('Nom du service', 'ex: My Custom Service', 'Mon Service Personnalisé');
  const endpointGroup = createGroup('Endpoint HTTP', 'ex: http://localhost:4000', 'http://localhost:4000');
  const healthPathGroup = createGroup('Health Path', 'ex: /health', '/health');
  const taskPathGroup = createGroup('Task Path', 'ex: /tasks', '/tasks');
  const priorityGroup = createGroup('Priorité (0-100)', 'ex: 10', '10', 'number');
  const reqTimeoutGroup = createGroup('Timeout Tâches HTTP (ms)', 'ex: 120000', '120000', 'number');
  const hlthTimeoutGroup = createGroup('Timeout Health Check (ms)', 'ex: 5000', '5000', 'number');
  const capsGroup = createGroup('Capabilities (séparées par des virgules)', 'ex: software_development, code_generation', 'software_development');
  const parallelCapsGroup = createGroup('Parallel Safe Capabilities (séparées par des virgules)', 'ex: software_development', '');
  const authEnvGroup = createGroup('Variable d\'Env Auth (Optionnel)', 'ex: MY_SERVICE_TOKEN', '');
  const risksGroup = createGroup('Risques par Capability (JSON)', 'ex: {"software_development": "MEDIUM"}', '{}');

  const buttonRow = document.createElement('div');
  buttonRow.style.display = 'flex';
  buttonRow.style.gap = '10px';
  buttonRow.style.marginTop = '16px';

  const btnCancel = document.createElement('button');
  btnCancel.type = 'button';
  btnCancel.className = 'btn btn-secondary';
  btnCancel.textContent = 'Annuler';
  btnCancel.addEventListener('click', () => overlay.remove());

  const btnSubmit = document.createElement('button');
  btnSubmit.type = 'button';
  btnSubmit.className = 'btn btn-primary';
  btnSubmit.textContent = 'Créer le Service';
  btnSubmit.addEventListener('click', async () => {
    try {
      let riskObj = {};
      if (risksGroup.input.value.trim()) {
        try {
          riskObj = JSON.parse(risksGroup.input.value.trim());
        } catch {
          throw new Error('Format JSON invalide pour les risques par capability');
        }
      }

      const caps = capsGroup.input.value.split(',').map((s) => s.trim()).filter(Boolean);
      const parallelCaps = parallelCapsGroup.input.value.split(',').map((s) => s.trim()).filter(Boolean);
      const authEnv = authEnvGroup.input.value.trim();
      const payload = {
        id: idGroup.input.value.trim(),
        name: nameGroup.input.value.trim(),
        transport: 'task_http',
        endpoint: endpointGroup.input.value.trim(),
        healthPath: healthPathGroup.input.value.trim() || '/health',
        taskPath: taskPathGroup.input.value.trim() || '/tasks',
        priority: Number(priorityGroup.input.value) || 10,
        requestTimeoutMs: Number(reqTimeoutGroup.input.value) || 120000,
        healthTimeoutMs: Number(hlthTimeoutGroup.input.value) || 5000,
        capabilities: caps,
        parallelSafeCapabilities: parallelCaps,
        riskByCapability: riskObj,
        auth: authEnv ? { type: 'bearer_env', envVar: authEnv } : { type: 'none' },
      };

      await fetchApi('/api/connections', {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      alert('✅ Service utilisateur créé avec succès !');
      overlay.remove();
      void renderSettingsView();
    } catch (e) {
      alert(`❌ Échec de création : ${e.message}`);
    }
  });

  buttonRow.append(btnCancel, btnSubmit);
  modal.append(
    title,
    idGroup.group,
    nameGroup.group,
    endpointGroup.group,
    healthPathGroup.group,
    taskPathGroup.group,
    priorityGroup.group,
    reqTimeoutGroup.group,
    hlthTimeoutGroup.group,
    capsGroup.group,
    parallelCapsGroup.group,
    authEnvGroup.group,
    risksGroup.group,
    buttonRow,
  );
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

function showEditServiceModal(conn) {
  const overlay = document.createElement('div');
  overlay.className = 'sidebar-overlay active';
  overlay.style.display = 'flex';
  overlay.style.alignItems = 'center';
  overlay.style.justifyContent = 'center';
  overlay.style.zIndex = '999';

  const modal = document.createElement('div');
  modal.className = 'card';
  modal.style.maxWidth = '550px';
  modal.style.width = '90%';
  modal.style.maxHeight = '90vh';
  modal.style.overflowY = 'auto';

  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = `Configurer / Modifier Service : ${conn.name} (${conn.id})`;

  const createGroup = (label, placeholder, defaultValue = '', type = 'text') => {
    const group = document.createElement('div');
    group.className = 'form-group';
    const lbl = document.createElement('label');
    lbl.className = 'form-label';
    lbl.textContent = label;
    const input = document.createElement('input');
    input.type = type;
    input.className = 'input-field';
    input.placeholder = placeholder;
    input.value = defaultValue;
    group.append(lbl, input);
    return { group, input };
  };

  const nameGroup = createGroup('Nom du service', 'ex: My Service', conn.name || conn.id);
  const endpointGroup = createGroup('Endpoint HTTP', 'ex: http://localhost:4000', conn.endpoint || '');
  const healthPathGroup = createGroup('Health Path', 'ex: /health', conn.healthPath || '/health');
  const taskPathGroup = createGroup('Task Path', 'ex: /tasks', conn.taskPath || '/tasks');
  const prioGroup = createGroup('Priorité (0-100)', 'ex: 10', String(conn.priority ?? 10), 'number');
  const reqTimeoutGroup = createGroup('Timeout Tâches HTTP (ms)', 'ex: 120000', String(conn.requestTimeoutMs ?? 120000), 'number');
  const hlthTimeoutGroup = createGroup('Timeout Health Check (ms)', 'ex: 5000', String(conn.healthTimeoutMs ?? 5000), 'number');
  const authEnvGroup = createGroup('Variable d\'Env Auth', 'ex: API_TOKEN', conn.auth?.envVar || '');
  const capsGroup = createGroup('Capabilities (séparées par des virgules)', 'ex: software_development, code_generation', Array.isArray(conn.capabilities) ? conn.capabilities.join(', ') : '');
  const parallelCapsGroup = createGroup('Parallel Safe Capabilities (séparées par des virgules)', 'ex: software_development', Array.isArray(conn.parallelSafeCapabilities) ? conn.parallelSafeCapabilities.join(', ') : '');
  const risksGroup = createGroup('Risques par Capability (JSON)', 'ex: {"software_development": "MEDIUM"}', JSON.stringify(conn.riskByCapability || {}));

  const enabledGroup = document.createElement('div');
  enabledGroup.className = 'form-group';
  const enabledLabel = document.createElement('label');
  enabledLabel.className = 'form-label';
  enabledLabel.style.display = 'flex';
  enabledLabel.style.alignItems = 'center';
  enabledLabel.style.gap = '8px';
  const enabledCheck = document.createElement('input');
  enabledCheck.type = 'checkbox';
  enabledCheck.checked = Boolean(conn.enabled);
  const enabledText = document.createElement('span');
  enabledText.textContent = 'Service Activé';
  enabledLabel.append(enabledCheck, enabledText);
  enabledGroup.appendChild(enabledLabel);

  const buttonRow = document.createElement('div');
  buttonRow.style.display = 'flex';
  buttonRow.style.gap = '10px';
  buttonRow.style.marginTop = '16px';

  const btnCancel = document.createElement('button');
  btnCancel.type = 'button';
  btnCancel.className = 'btn btn-secondary';
  btnCancel.textContent = 'Annuler';
  btnCancel.addEventListener('click', () => overlay.remove());

  const btnSubmit = document.createElement('button');
  btnSubmit.type = 'button';
  btnSubmit.className = 'btn btn-primary';
  btnSubmit.textContent = 'Enregistrer';
  btnSubmit.addEventListener('click', async () => {
    try {
      let riskObj = {};
      if (risksGroup.input.value.trim()) {
        try {
          riskObj = JSON.parse(risksGroup.input.value.trim());
        } catch {
          throw new Error('Format JSON invalide pour les risques par capability');
        }
      }

      const caps = capsGroup.input.value.split(',').map((s) => s.trim()).filter(Boolean);
      const parallelCaps = parallelCapsGroup.input.value.split(',').map((s) => s.trim()).filter(Boolean);
      const authEnv = authEnvGroup.input.value.trim();

      const patchPayload = {
        name: nameGroup.input.value.trim(),
        enabled: enabledCheck.checked,
        endpoint: endpointGroup.input.value.trim(),
        healthPath: healthPathGroup.input.value.trim() || '/health',
        taskPath: taskPathGroup.input.value.trim() || '/tasks',
        priority: Number(prioGroup.input.value) || 10,
        requestTimeoutMs: Number(reqTimeoutGroup.input.value) || 120000,
        healthTimeoutMs: Number(hlthTimeoutGroup.input.value) || 5000,
        auth: authEnv ? { type: 'bearer_env', envVar: authEnv } : { type: 'none' },
        capabilities: caps,
        parallelSafeCapabilities: parallelCaps,
        riskByCapability: riskObj,
      };

      await fetchApi(`/api/connections/${encodeURIComponent(conn.id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patchPayload),
      });

      alert('✅ Service mis à jour avec succès !');
      overlay.remove();
      void renderSettingsView();
    } catch (e) {
      alert(`❌ Échec de la mise à jour : ${e.message}`);
    }
  });

  buttonRow.append(btnCancel, btnSubmit);
  modal.append(
    title,
    nameGroup.group,
    enabledGroup,
    endpointGroup.group,
    healthPathGroup.group,
    taskPathGroup.group,
    prioGroup.group,
    reqTimeoutGroup.group,
    hlthTimeoutGroup.group,
    authEnvGroup.group,
    capsGroup.group,
    parallelCapsGroup.group,
    risksGroup.group,
    buttonRow,
  );
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

function renderServicesConnectionCenter(connections) {
  const container = document.createElement('div');
  container.className = 'card';

  const headerRow = document.createElement('div');
  headerRow.style.display = 'flex';
  headerRow.style.justifyContent = 'space-between';
  headerRow.style.alignItems = 'center';
  headerRow.style.flexWrap = 'wrap';
  headerRow.style.gap = '10px';

  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = 'SERVICES JARVIS (Service Connection Center)';

  const actions = document.createElement('div');
  actions.style.display = 'flex';
  actions.style.gap = '8px';

  const btnAddUserSvc = document.createElement('button');
  btnAddUserSvc.type = 'button';
  btnAddUserSvc.className = 'btn btn-primary btn-sm';
  btnAddUserSvc.textContent = '+ Service Utilisateur';
  btnAddUserSvc.addEventListener('click', () => {
    showUserServiceModal();
  });

  const btnTestAll = document.createElement('button');
  btnTestAll.type = 'button';
  btnTestAll.className = 'btn btn-secondary btn-sm';
  btnTestAll.textContent = 'Tester toutes les connexions';
  btnTestAll.addEventListener('click', async () => {
    btnTestAll.disabled = true;
    btnTestAll.textContent = 'Test en cours...';
    try {
      await fetchApi('/api/connections/test-all', { method: 'POST' });
      alert('✅ Health check global terminé.');
      void renderSettingsView();
    } catch (e) {
      alert(`❌ Erreur test global : ${e.message}`);
    } finally {
      btnTestAll.disabled = false;
      btnTestAll.textContent = 'Tester toutes les connexions';
    }
  });

  actions.append(btnAddUserSvc, btnTestAll);
  headerRow.append(title, actions);
  container.appendChild(headerRow);

  const grid = document.createElement('div');
  grid.className = 'card-grid';
  grid.style.marginTop = '12px';

  connections.forEach((conn) => {
    const card = document.createElement('div');
    card.className = 'service-connection-card';

    const cardHeader = document.createElement('div');
    cardHeader.className = 'service-connection-header';

    const connName = document.createElement('span');
    connName.style.fontWeight = '600';
    connName.textContent = conn.name;

    const statusPill = document.createElement('span');
    const isEnabled = conn.enabled;
    const isReachable = conn.lastError === undefined;
    const isLocal = conn.transport === 'local';
    const statusText = isLocal ? 'LOCAL' : !isEnabled ? 'DISABLED' : isReachable ? 'CONNECTED' : 'ERROR';
    statusPill.className = `service-status-pill ${statusText}`;
    statusPill.textContent = statusText;

    cardHeader.append(connName, statusPill);

    const details = document.createElement('div');
    details.className = 'card-subtext';
    details.style.display = 'flex';
    details.style.flexDirection = 'column';
    details.style.gap = '4px';

    const rowId = document.createElement('span'); rowId.textContent = `ID: ${conn.id}`;
    const rowTransport = document.createElement('span'); rowTransport.textContent = `Transport: ${conn.transport} | Priorité: ${conn.priority}`;
    const rowEndpoint = document.createElement('span'); rowEndpoint.textContent = `Endpoint: ${conn.endpoint} (${conn.source})`;
    const rowCaps = document.createElement('span'); rowCaps.textContent = `Capabilities: ${(conn.capabilities || []).join(', ')}`;
    const rowAuth = document.createElement('span'); rowAuth.textContent = `Auth: ${conn.auth?.type || 'none'} (${conn.secretConfigured ? '✓ Configuré' : '❌ Non configuré'})`;
    const rowMetrics = document.createElement('span');
    rowMetrics.textContent = `Latence: ${conn.lastLatencyMs != null ? conn.lastLatencyMs + ' ms' : '—'} | Erreur: ${conn.lastError || 'aucune'}`;

    details.append(rowId, rowTransport, rowEndpoint, rowCaps, rowAuth, rowMetrics);

    const btnRow = document.createElement('div');
    btnRow.style.display = 'flex';
    btnRow.style.gap = '8px';
    btnRow.style.marginTop = '8px';

    const btnTest = document.createElement('button');
    btnTest.type = 'button';
    btnTest.className = 'btn btn-secondary btn-sm';
    btnTest.textContent = 'Tester';
    btnTest.addEventListener('click', async () => {
      try {
        const res = await fetchApi(`/api/connections/${encodeURIComponent(conn.id)}/test`, { method: 'POST' });
        alert(res.reachable ? `✅ ${conn.name} accessible (${res.latencyMs} ms)` : `❌ ${conn.name} inaccessible (${res.errorCode})`);
        void renderSettingsView();
      } catch (e) {
        alert(`❌ Erreur : ${e.message}`);
      }
    });

    const btnToggle = document.createElement('button');
    btnToggle.type = 'button';
    btnToggle.className = `btn btn-${conn.enabled ? 'danger' : 'success'} btn-sm`;
    btnToggle.textContent = conn.enabled ? 'Désactiver' : 'Activer';
    btnToggle.addEventListener('click', async () => {
      try {
        await fetchApi(`/api/connections/${encodeURIComponent(conn.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ enabled: !conn.enabled }),
        });
        void renderSettingsView();
      } catch (e) {
        alert(`❌ Erreur : ${e.message}`);
      }
    });

    const btnEdit = document.createElement('button');
    btnEdit.type = 'button';
    btnEdit.className = 'btn btn-secondary btn-sm';
    btnEdit.textContent = 'Configurer';
    btnEdit.addEventListener('click', () => {
      showEditServiceModal(conn);
    });

    btnRow.append(btnTest, btnToggle, btnEdit);

    if (conn.source === 'DATABASE' && !conn.userCreated) {
      const btnReset = document.createElement('button');
      btnReset.type = 'button';
      btnReset.className = 'btn btn-secondary btn-sm';
      btnReset.textContent = 'Réinitialiser';
      btnReset.addEventListener('click', async () => {
        try {
          await fetchApi(`/api/connections/${encodeURIComponent(conn.id)}/reset`, { method: 'POST' });
          alert('✅ Override réinitialisé aux valeurs du dépôt.');
          void renderSettingsView();
        } catch (e) {
          alert(`❌ Erreur : ${e.message}`);
        }
      });
      btnRow.appendChild(btnReset);
    }

    if (conn.userCreated) {
      const btnDelete = document.createElement('button');
      btnDelete.type = 'button';
      btnDelete.className = 'btn btn-danger btn-sm';
      btnDelete.textContent = 'Supprimer';
      btnDelete.addEventListener('click', async () => {
        if (!confirm(`Supprimer le service ${conn.name} ?`)) return;
        try {
          await fetchApi(`/api/connections/${encodeURIComponent(conn.id)}`, { method: 'DELETE' });
          void renderSettingsView();
        } catch (e) {
          alert(`❌ Erreur : ${e.message}`);
        }
      });
      btnRow.appendChild(btnDelete);
    }

    card.append(cardHeader, details, btnRow);
    grid.appendChild(card);
  });

  container.appendChild(grid);
  return container;
}

function applyLocalSettingCache(key, value) {
  if (key === 'settings.interfaceMode' && typeof value === 'string') {
    currentDisplayLevel = value;
    localStorage.setItem('jarvis_interface_level', value);
  } else if (key === 'settings.startupView' && typeof value === 'string') {
    localStorage.setItem('jarvis_startup_view', value);
  } else if (key === 'settings.timelineMode' && typeof value === 'string') {
    localStorage.setItem('jarvis_timeline_mode', value);
  } else if (key === 'settings.expandCompletedMissions') {
    localStorage.setItem('jarvis_expand_completed_missions', String(value));
  } else if (key === 'settings.theme' && typeof value === 'string') {
    localStorage.setItem('jarvis_theme', value);
    applyThemeRuntime(value);
  } else if (key === 'settings.language' && typeof value === 'string') {
    document.documentElement.lang = value;
    localStorage.setItem('jarvis_language', value);
  }
}

function renderSettingCard(setting) {
  const def = setting.definition;
  const card = document.createElement('div');
  card.className = 'setting-card';

  const header = document.createElement('div');
  header.className = 'setting-card-header';

  const titleGroup = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'setting-card-title';
  title.textContent = def.label;

  const keyLabel = document.createElement('div');
  keyLabel.className = 'setting-card-key';
  keyLabel.textContent = def.key;
  titleGroup.append(title, keyLabel);

  const badges = document.createElement('div');
  badges.className = 'setting-badges';

  const badgeLevel = document.createElement('span');
  badgeLevel.className = 'badge-level';
  badgeLevel.textContent = def.level;

  const badgeSource = document.createElement('span');
  badgeSource.className = 'badge-source';
  badgeSource.textContent = `Source: ${setting.source}`;

  const badgeAvail = document.createElement('span');
  if (def.availability === 'FUTURE') {
    badgeAvail.className = 'badge badge-future';
    badgeAvail.textContent = 'FUTURE';
  } else if (def.availability === 'SYSTEM_LOCKED') {
    badgeAvail.className = 'badge badge-locked';
    badgeAvail.textContent = 'SYSTEM_LOCKED';
  } else {
    badgeAvail.className = 'badge badge-success';
    badgeAvail.textContent = 'AVAILABLE';
  }

  badges.append(badgeLevel, badgeSource, badgeAvail);
  header.append(titleGroup, badges);

  const desc = document.createElement('div');
  desc.className = 'setting-card-desc';
  desc.textContent = def.description;

  const controlRow = document.createElement('div');
  controlRow.className = 'setting-card-control';

  if (def.type === 'action' && def.availability === 'AVAILABLE') {
    const btnRun = document.createElement('button');
    btnRun.type = 'button';
    btnRun.className = 'btn btn-secondary btn-sm';
    btnRun.textContent = '▶ Lancer le test';
    const resultText = document.createElement('span');
    resultText.style.marginLeft = '10px';
    resultText.style.fontSize = '0.85rem';
    btnRun.addEventListener('click', async () => {
      btnRun.disabled = true;
      resultText.textContent = 'Test en cours…';
      resultText.style.color = 'var(--text-secondary)';
      try {
        const result = await fetchApi('/api/settings/tool-compatibility-test', { method: 'POST' });
        resultText.style.color = result.ok ? 'var(--accent-success)' : 'var(--accent-danger)';
        resultText.textContent = result.ok
          ? `✅ ${result.provider}/${result.model} — ${result.compatibility}`
          : `❌ ${result.error || 'Échec du test'}`;
      } catch (e) {
        resultText.style.color = 'var(--accent-danger)';
        resultText.textContent = `❌ Erreur : ${e.message}`;
      } finally {
        btnRun.disabled = false;
      }
    });
    controlRow.append(btnRun, resultText);
  } else if (!def.editable || def.availability !== 'AVAILABLE') {
    const disabledText = document.createElement('span');
    disabledText.style.color = 'var(--accent-warning)';
    disabledText.style.fontSize = '0.85rem';
    disabledText.textContent = `🔒 ${def.unavailableReason || 'Non modifiable'} ${def.plannedChantier ? `(Chantier ${def.plannedChantier})` : ''}`;
    controlRow.appendChild(disabledText);
  } else {
    if (def.type === 'boolean') {
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = Boolean(setting.effectiveValue);
      checkbox.addEventListener('change', async () => {
        try {
          await fetchApi('/api/settings', {
            method: 'PATCH',
            body: JSON.stringify({ key: def.key, value: checkbox.checked }),
          });
          applyLocalSettingCache(def.key, checkbox.checked);
          void renderSettingsView();
        } catch (e) {
          alert(`❌ Erreur : ${e.message}`);
          checkbox.checked = !checkbox.checked;
        }
      });
      const checkLabel = document.createElement('span');
      checkLabel.textContent = checkbox.checked ? ' Activé' : ' Désactivé';
      controlRow.append(checkbox, checkLabel);
    } else if (def.type === 'enum' && def.validation?.enumValues) {
      const select = document.createElement('select');
      select.className = 'input-field';
      select.style.maxWidth = '240px';
      def.validation.enumValues.forEach((optVal) => {
        const opt = document.createElement('option');
        opt.value = optVal;
        opt.textContent = optVal;
        if (optVal === String(setting.effectiveValue)) opt.selected = true;
        select.appendChild(opt);
      });
      select.addEventListener('change', async () => {
        try {
          await fetchApi('/api/settings', {
            method: 'PATCH',
            body: JSON.stringify({ key: def.key, value: select.value }),
          });
          applyLocalSettingCache(def.key, select.value);
          void renderSettingsView();
        } catch (e) {
          alert(`❌ Erreur : ${e.message}`);
        }
      });
      controlRow.appendChild(select);
    } else if (def.type === 'number') {
      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'input-field';
      input.style.maxWidth = '180px';
      input.value = String(setting.effectiveValue);
      if (def.validation?.min !== undefined) input.min = String(def.validation.min);
      if (def.validation?.max !== undefined) input.max = String(def.validation.max);

      const btnSave = document.createElement('button');
      btnSave.type = 'button';
      btnSave.className = 'btn btn-secondary btn-sm';
      btnSave.textContent = 'Appliquer';
      btnSave.addEventListener('click', async () => {
        const val = Number(input.value);
        try {
          await fetchApi('/api/settings', {
            method: 'PATCH',
            body: JSON.stringify({ key: def.key, value: val }),
          });
          void renderSettingsView();
        } catch (e) {
          alert(`❌ Erreur : ${e.message}`);
        }
      });
      controlRow.append(input, btnSave);
    } else {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'input-field';
      input.style.maxWidth = '280px';
      input.value = String(setting.effectiveValue || '');

      const btnSave = document.createElement('button');
      btnSave.type = 'button';
      btnSave.className = 'btn btn-secondary btn-sm';
      btnSave.textContent = 'Appliquer';
      btnSave.addEventListener('click', async () => {
        try {
          await fetchApi('/api/settings', {
            method: 'PATCH',
            body: JSON.stringify({ key: def.key, value: input.value }),
          });
          void renderSettingsView();
        } catch (e) {
          alert(`❌ Erreur : ${e.message}`);
        }
      });
      controlRow.append(input, btnSave);
    }
  }

  card.append(header, desc, controlRow);
  return card;
}

function renderExportImportCard() {
  const card = document.createElement('div');
  card.className = 'card';

  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = 'Export / Import de Configuration';

  const desc = document.createElement('div');
  desc.className = 'card-subtext';
  desc.textContent = 'Exporte la configuration courante (sans aucun secret/token) ou importe une configuration JSON atomique.';

  const btnRow = document.createElement('div');
  btnRow.style.display = 'flex';
  btnRow.style.gap = '10px';
  btnRow.style.marginTop = '10px';

  const btnExport = document.createElement('button');
  btnExport.type = 'button';
  btnExport.className = 'btn btn-secondary btn-sm';
  btnExport.textContent = 'Export JSON';
  btnExport.addEventListener('click', async () => {
    try {
      const data = await fetchApi('/api/settings/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `jarvis-settings-export-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(`❌ Erreur export : ${e.message}`);
    }
  });

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.json';
  fileInput.style.display = 'none';

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      await fetchApi('/api/settings/import', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      alert('✅ Importation réalisée avec succès !');
      void renderSettingsView();
    } catch (e) {
      alert(`❌ Échec import (SETTINGS_IMPORT_INVALID) : ${e.message}`);
    }
  });

  const btnImport = document.createElement('button');
  btnImport.type = 'button';
  btnImport.className = 'btn btn-secondary btn-sm';
  btnImport.textContent = 'Import JSON';
  btnImport.addEventListener('click', () => fileInput.click());

  btnRow.append(btnExport, btnImport, fileInput);
  card.append(title, desc, btnRow);
  return card;
}

function renderFutureMapCard() {
  const card = document.createElement('div');
  card.className = 'future-map-card';

  const title = document.createElement('div');
  title.className = 'card-title';
  title.style.color = 'var(--accent-primary)';
  title.textContent = '🚀 CAPACITÉS À VENIR (FEUILLE DE ROUTE JARVIS)';

  const body = document.createElement('div');
  body.style.display = 'flex';
  body.style.flexDirection = 'column';
  body.style.gap = '12px';
  body.style.marginTop = '10px';
  body.style.fontSize = '0.9rem';

  const c8 = document.createElement('div');
  const c8Title = document.createElement('strong');
  c8Title.textContent = 'CHANTIER 8 — AUTONOMOUS WORKBENCH';
  const c8List = document.createElement('div');
  c8List.className = 'card-subtext';
  c8List.textContent = 'Repository Inspection, Repository Search, Knowledge Search / RAG, Documents / PDF, Spreadsheets, Data Analysis, Database Query, Reports, Structured Browser Research, Controlled Self-Improvement.';
  c8.append(c8Title, c8List);

  const c9 = document.createElement('div');
  const c9Title = document.createElement('strong');
  c9Title.textContent = 'CHANTIER 9 — JARVIS BUSINESS OS';
  const c9List = document.createElement('div');
  c9List.className = 'card-subtext';
  c9List.textContent = 'Product Studio, Creative Studio, Commercial Office, Marketing Office, Email, Calendar, Contacts, Messaging, CRM.';
  c9.append(c9Title, c9List);

  const c10 = document.createElement('div');
  const c10Title = document.createElement('strong');
  c10Title.textContent = 'CHANTIER 10 — FULL INDEPENDENCE';
  const c10List = document.createElement('div');
  c10List.className = 'card-subtext';
  c10List.textContent = 'Computer Use, Interactive Browser, Voice, Wake Word, Local Models, Offline RAG, Local Software Control.';
  c10.append(c10Title, c10List);

  body.append(c8, c9, c10);
  card.append(title, body);
  return card;
}

// --- INITIALIZATION ---
let jarvisInitialized = false;

function bootstrapJarvis() {
  if (jarvisInitialized) return;
  jarvisInitialized = true;

  initNavigation();

  // Apply general settings saved in localStorage for instant initial rendering
  const savedTheme = localStorage.getItem('jarvis_theme') || 'SYSTEM';
  applyThemeRuntime(savedTheme);

  const startupViewSetting = localStorage.getItem('jarvis_startup_view') || 'CHAT';
  let initialView = 'chat';
  if (startupViewSetting === 'COMMAND_CENTER') {
    initialView = 'accueil';
  } else if (startupViewSetting === 'LAST_VIEW') {
    initialView = localStorage.getItem('jarvis_last_view') || 'accueil';
  }

  switchView(initialView);

  // Asynchronously sync backend authority settings when accessible
  setTimeout(async () => {
    try {
      const effectiveSettings = await fetchApi('/api/settings');
      if (Array.isArray(effectiveSettings)) {
        effectiveSettings.forEach((item) => {
          const key = item.definition?.key;
          const val = item.effectiveValue;
          if (key && val !== undefined) {
            applyLocalSettingCache(key, val);
          }
        });
      }
    } catch {
      // Backend offline: retain local cache gracefully
    }
  }, 100);

  migrateLegacyOtaState().finally(() => {
    if (state.ota && state.ota.autoCheck) {
      setTimeout(() => checkOtaUpdates(false), 2000);
    }
  });
}

if (typeof window !== 'undefined') {
  window.bootstrapJarvis = bootstrapJarvis;
  window.jarvisInitialized = () => jarvisInitialized;
  window.serviceEventToTimelineEntry = serviceEventToTimelineEntry;
  window.timelineMarkerForEntry = timelineMarkerForEntry;
  window.copyPlainText = copyPlainText;
  window.isNearChatBottom = isNearChatBottom;
  window.checkOtaUpdates = checkOtaUpdates;
  window.applyOtaUpdate = applyOtaUpdate;
  window.rollbackOtaUpdate = rollbackOtaUpdate;
  window.migrateLegacyOtaState = migrateLegacyOtaState;
  window.computeSha256 = computeSha256;
  window.compareVersions = compareVersions;
  window.getOtaManifestIdentity = getOtaManifestIdentity;
  window.getActiveOtaIdentity = getActiveOtaIdentity;
  window.fetchAndVerifyOtaBundle = fetchAndVerifyOtaBundle;
  window.persistOtaInstall = persistOtaInstall;
  window.reloadJarvisApp = reloadJarvisApp;
  window.OTA_KEYS = OTA_KEYS;
  window.OTA_LEGACY_KEYS = OTA_LEGACY_KEYS;
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrapJarvis, { once: true });
  } else {
    bootstrapJarvis();
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    bootstrapJarvis,
    state,
    switchView,
    serviceEventToTimelineEntry,
    timelineMarkerForEntry,
    copyPlainText,
    isNearChatBottom,
    checkOtaUpdates,
    applyOtaUpdate,
    rollbackOtaUpdate,
    migrateLegacyOtaState,
    computeSha256,
    compareVersions,
    getOtaManifestIdentity,
    getActiveOtaIdentity,
    fetchAndVerifyOtaBundle,
    persistOtaInstall,
    reloadJarvisApp,
    OTA_KEYS,
    OTA_LEGACY_KEYS,
  };
}
