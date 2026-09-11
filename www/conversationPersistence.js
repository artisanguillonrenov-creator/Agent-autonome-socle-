// Chantier 11B — persistent multi-conversation manager for the Web/Android UI.
(function () {
  'use strict';

  if (window.__JARVIS_CONVERSATION_MANAGER_LOADED__) return;
  window.__JARVIS_CONVERSATION_MANAGER_LOADED__ = true;

  const ACTIVE_KEY = 'jarvis_active_conversation_id';
  const originalFetch = window.fetch.bind(window);
  let ensurePromise = null;
  let hydratedConversationId = null;
  let managerRefreshPromise = null;

  function backendBase() {
    return (localStorage.getItem('jarvis_backend_url') || '').trim().replace(/\/+$/, '');
  }

  function apiUrl(path) {
    return backendBase() + path;
  }

  function authHeaders(extra) {
    const token = localStorage.getItem('jarvis_token') || '';
    return Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}, extra || {});
  }

  function newRequestId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return 'web-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }

  async function rawJson(path, options) {
    const response = await originalFetch(apiUrl(path), Object.assign({}, options || {}, {
      headers: authHeaders(options && options.headers),
    }));
    let data = {};
    try { data = await response.clone().json(); } catch (_) {}
    if (!response.ok) {
      const error = new Error(data.error || ('HTTP_' + response.status));
      error.status = response.status;
      throw error;
    }
    return data;
  }

  async function listConversations() {
    const data = await rawJson('/api/conversations');
    return Array.isArray(data.items) ? data.items : [];
  }

  async function getConversation(conversationId) {
    return rawJson('/api/conversations/' + encodeURIComponent(conversationId));
  }

  async function createConversation() {
    const created = await rawJson('/api/conversations', { method: 'POST', body: '{}' });
    if (!created || !created.conversationId) throw new Error('CONVERSATION_CREATE_INVALID_RESPONSE');
    localStorage.setItem(ACTIVE_KEY, created.conversationId);
    hydratedConversationId = null;
    return created.conversationId;
  }

  async function ensureConversation() {
    if (ensurePromise) return ensurePromise;
    ensurePromise = (async function () {
      let id = localStorage.getItem(ACTIVE_KEY) || '';
      if (id) {
        try {
          const session = await getConversation(id);
          if (session && session.status === 'ACTIVE') return id;
          localStorage.removeItem(ACTIVE_KEY);
        } catch (error) {
          if (error.status !== 404 && error.status !== 409) throw error;
          localStorage.removeItem(ACTIVE_KEY);
        }
      }

      // Critical reinstall/restart recovery: the server is authoritative. If localStorage
      // was wiped, resume the most recently active durable conversation instead of silently
      // starting an empty one.
      const sessions = await listConversations();
      if (sessions.length && sessions[0].conversationId) {
        id = sessions[0].conversationId;
        localStorage.setItem(ACTIVE_KEY, id);
        hydratedConversationId = null;
        return id;
      }
      return createConversation();
    })();
    try { return await ensurePromise; }
    finally { ensurePromise = null; }
  }

  function parseBody(init) {
    if (!init || typeof init.body !== 'string' || !init.body) return {};
    try { return JSON.parse(init.body); } catch (_) { return {}; }
  }

  function deriveTitle(message) {
    const clean = String(message || '').replace(/\s+/g, ' ').trim();
    if (!clean) return 'Nouvelle conversation';
    return clean.length > 64 ? clean.slice(0, 61).trimEnd() + '…' : clean;
  }

  async function maybeAutoTitle(conversationId, message) {
    try {
      const session = await getConversation(conversationId);
      if (!session || session.title !== 'Nouvelle conversation') return;
      const title = deriveTitle(message);
      if (title === 'Nouvelle conversation') return;
      await rawJson('/api/conversations/' + encodeURIComponent(conversationId), {
        method: 'PATCH',
        body: JSON.stringify({ title: title }),
      });
      await refreshConversationManager();
    } catch (_) {}
  }

  async function latestRegeneratableMessageId(conversationId) {
    const page = await rawJson('/api/conversations/' + encodeURIComponent(conversationId) + '/messages?limit=100');
    const items = Array.isArray(page.items) ? page.items : [];
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i];
      const message = item && item.message;
      if (item.status === 'ACTIVE' && message && message.role === 'assistant' && !(message.toolCalls && message.toolCalls.length)) {
        return item.messageId || '';
      }
    }
    return '';
  }

  window.fetch = async function (input, init) {
    const requestUrl = new URL(typeof input === 'string' ? input : input.url, window.location.href);
    const method = String((init && init.method) || (typeof input !== 'string' && input.method) || 'GET').toUpperCase();
    const path = requestUrl.pathname;

    if ((path === '/api/chat' || path === '/chat') && method === 'POST') {
      const conversationId = await ensureConversation();
      const body = parseBody(init);
      body.conversationId = conversationId;
      if (!body.clientRequestId) body.clientRequestId = newRequestId();
      const response = await originalFetch(input, Object.assign({}, init || {}, { body: JSON.stringify(body) }));
      try {
        const clone = response.clone();
        const data = await clone.json();
        if (data && data.conversationId) {
          localStorage.setItem(ACTIVE_KEY, data.conversationId);
          if (response.ok && body.message) void maybeAutoTitle(data.conversationId, body.message);
        }
      } catch (_) {}
      return response;
    }

    if (path === '/api/chat/regenerate' && method === 'POST') {
      const conversationId = await ensureConversation();
      const body = parseBody(init);
      body.conversationId = conversationId;
      body.clientRequestId = body.clientRequestId || newRequestId();
      if (!body.targetMessageId) body.targetMessageId = await latestRegeneratableMessageId(conversationId);
      return originalFetch(input, Object.assign({}, init || {}, { body: JSON.stringify(body) }));
    }

    if (path === '/api/chat/stream' && method === 'GET') {
      const conversationId = await ensureConversation();
      requestUrl.searchParams.set('conversationId', conversationId);
      if (!requestUrl.searchParams.get('clientRequestId')) requestUrl.searchParams.set('clientRequestId', newRequestId());
      return originalFetch(requestUrl.toString(), init);
    }

    return originalFetch(input, init);
  };

  function visibleHistory(items) {
    return items.filter(function (item) {
      if (!item || item.status !== 'ACTIVE' || !item.message) return false;
      if (item.message.role === 'user') return true;
      return item.message.role === 'assistant' && !(item.message.toolCalls && item.message.toolCalls.length) && item.message.content;
    });
  }

  async function loadHistory(conversationId) {
    // Load enough history for normal UI use while keeping rendering bounded on very long threads.
    // WorkingMemory remains independently bounded server-side; this is display history only.
    const page = await rawJson('/api/conversations/' + encodeURIComponent(conversationId) + '/messages?limit=500');
    return visibleHistory(Array.isArray(page.items) ? page.items : []);
  }

  function renderGreeting(box) {
    if (typeof window.appendChatMessage === 'function') {
      window.appendChatMessage('agent', "Bonjour, je suis Jarvis Command Center. Comment puis-je vous aider aujourd'hui ?", { regeneratable: false });
    } else {
      box.textContent = '';
    }
  }

  async function hydrateConversation(conversationId, force) {
    const box = document.getElementById('chat-messages');
    if (!box || typeof window.appendChatMessage !== 'function') return;
    if (!force && hydratedConversationId === conversationId && box.dataset.conversationHydrated === conversationId) return;

    const items = await loadHistory(conversationId);
    box.replaceChildren();
    if (items.length) {
      items.forEach(function (item) {
        const role = item.message.role === 'user' ? 'user' : 'agent';
        window.appendChatMessage(role, item.message.content || '', {
          regeneratable: role === 'agent',
          messageId: item.messageId,
        });
      });
    } else {
      renderGreeting(box);
    }
    hydratedConversationId = conversationId;
    box.dataset.conversationHydrated = conversationId;
  }

  async function hydrateChatIfReady(force) {
    const box = document.getElementById('chat-messages');
    if (!box || typeof window.appendChatMessage !== 'function') return;
    let conversationId;
    try { conversationId = await ensureConversation(); }
    catch (error) { console.warn('[Conversation] restore unavailable:', error.message); return; }
    try {
      await hydrateConversation(conversationId, Boolean(force));
      await refreshConversationManager();
    } catch (error) {
      console.warn('[Conversation] history restore failed:', error.message);
    }
  }

  function injectConversationStyles() {
    if (document.getElementById('jarvis-conversation-manager-style')) return;
    const style = document.createElement('style');
    style.id = 'jarvis-conversation-manager-style';
    style.textContent = [
      '.conversation-manager{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:10px 12px;border-bottom:1px solid rgba(148,163,184,.2);background:rgba(15,23,42,.55)}',
      '.conversation-manager-label{font-size:.78rem;color:var(--text-muted,#94a3b8);font-weight:700;letter-spacing:.02em}',
      '.conversation-manager-select{min-width:190px;max-width:360px;flex:1;padding:9px 10px;border-radius:10px;border:1px solid rgba(148,163,184,.3);background:rgba(15,23,42,.75);color:inherit}',
      '.conversation-manager .btn{white-space:nowrap}',
      '@media(max-width:640px){.conversation-manager-select{min-width:100%;max-width:none;order:2}.conversation-manager-label{width:100%}}'
    ].join('');
    document.head.appendChild(style);
  }

  function formatSessionLabel(session) {
    const title = session && session.title ? session.title : 'Nouvelle conversation';
    const when = session && session.lastInteractionAt ? new Date(session.lastInteractionAt) : null;
    const date = when && !Number.isNaN(when.getTime()) ? when.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }) : '';
    return date ? title + ' · ' + date : title;
  }

  function ensureManagerUi() {
    injectConversationStyles();
    const form = document.getElementById('chat-form');
    if (!form || !form.parentElement) return null;
    let manager = document.getElementById('conversation-manager');
    if (manager) return manager;

    manager = document.createElement('div');
    manager.id = 'conversation-manager';
    manager.className = 'conversation-manager';

    const label = document.createElement('span');
    label.className = 'conversation-manager-label';
    label.textContent = 'Conversation';

    const select = document.createElement('select');
    select.id = 'conversation-manager-select';
    select.className = 'conversation-manager-select';
    select.setAttribute('aria-label', 'Choisir une conversation');
    select.addEventListener('change', function () {
      if (select.value) void selectConversation(select.value);
    });

    const createButton = document.createElement('button');
    createButton.type = 'button';
    createButton.className = 'btn btn-primary';
    createButton.textContent = '+ Nouvelle';
    createButton.addEventListener('click', async function () {
      createButton.disabled = true;
      try {
        const id = await createConversation();
        await hydrateConversation(id, true);
        await refreshConversationManager();
      } catch (error) {
        console.warn('[Conversation] new conversation failed:', error.message);
      } finally {
        createButton.disabled = false;
      }
    });

    const renameButton = document.createElement('button');
    renameButton.type = 'button';
    renameButton.className = 'btn btn-secondary';
    renameButton.textContent = 'Renommer';
    renameButton.addEventListener('click', async function () {
      const id = localStorage.getItem(ACTIVE_KEY) || '';
      if (!id) return;
      try {
        const session = await getConversation(id);
        const title = window.prompt('Nom de la conversation :', session.title || 'Nouvelle conversation');
        if (title == null) return;
        const clean = title.replace(/\s+/g, ' ').trim();
        if (!clean) return;
        await rawJson('/api/conversations/' + encodeURIComponent(id), {
          method: 'PATCH',
          body: JSON.stringify({ title: clean }),
        });
        await refreshConversationManager();
      } catch (error) {
        console.warn('[Conversation] rename failed:', error.message);
      }
    });

    const archiveButton = document.createElement('button');
    archiveButton.type = 'button';
    archiveButton.className = 'btn btn-secondary';
    archiveButton.textContent = 'Archiver';
    archiveButton.addEventListener('click', async function () {
      const id = localStorage.getItem(ACTIVE_KEY) || '';
      if (!id || !window.confirm('Archiver cette conversation ? Elle ne sera plus affichée dans la liste active.')) return;
      archiveButton.disabled = true;
      try {
        await rawJson('/api/conversations/' + encodeURIComponent(id), { method: 'DELETE' });
        localStorage.removeItem(ACTIVE_KEY);
        hydratedConversationId = null;
        const nextId = await ensureConversation();
        await hydrateConversation(nextId, true);
        await refreshConversationManager();
      } catch (error) {
        console.warn('[Conversation] archive failed:', error.message);
      } finally {
        archiveButton.disabled = false;
      }
    });

    manager.append(label, select, createButton, renameButton, archiveButton);
    form.parentElement.insertBefore(manager, form.parentElement.firstChild);
    return manager;
  }

  async function refreshConversationManager() {
    if (managerRefreshPromise) return managerRefreshPromise;
    managerRefreshPromise = (async function () {
      const manager = ensureManagerUi();
      if (!manager) return;
      const select = document.getElementById('conversation-manager-select');
      if (!select) return;
      const sessions = await listConversations();
      const active = localStorage.getItem(ACTIVE_KEY) || '';
      select.replaceChildren();
      sessions.forEach(function (session) {
        const option = document.createElement('option');
        option.value = session.conversationId;
        option.textContent = formatSessionLabel(session);
        if (session.conversationId === active) option.selected = true;
        select.appendChild(option);
      });
      if (!sessions.length) {
        const option = document.createElement('option');
        option.value = active;
        option.textContent = 'Nouvelle conversation';
        option.selected = true;
        select.appendChild(option);
      }
    })();
    try { return await managerRefreshPromise; }
    finally { managerRefreshPromise = null; }
  }

  async function selectConversation(conversationId) {
    if (!conversationId) return;
    try {
      const session = await getConversation(conversationId);
      if (!session || session.status !== 'ACTIVE') throw new Error('CONVERSATION_NOT_ACTIVE');
      localStorage.setItem(ACTIVE_KEY, conversationId);
      hydratedConversationId = null;
      await hydrateConversation(conversationId, true);
      await refreshConversationManager();
      const input = document.getElementById('chat-input');
      if (input) input.focus();
    } catch (error) {
      console.warn('[Conversation] switch failed:', error.message);
    }
  }

  async function boot() {
    try { await ensureConversation(); } catch (_) {}
    const timer = window.setInterval(function () { void hydrateChatIfReady(false); }, 500);
    window.addEventListener('beforeunload', function () { window.clearInterval(timer); }, { once: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else void boot();

  window.JarvisConversationPersistence = {
    ensureConversation: ensureConversation,
    newConversation: createConversation,
    selectConversation: selectConversation,
    refresh: refreshConversationManager,
    getActiveConversationId: function () { return localStorage.getItem(ACTIVE_KEY) || ''; },
  };
})();
