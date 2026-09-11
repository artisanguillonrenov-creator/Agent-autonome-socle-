// Chantier 11A — Web conversation continuity shim.
// Loaded by the server wrapper without coupling durable state to the main UI bundle.
(function () {
  'use strict';

  const ACTIVE_KEY = 'jarvis_active_conversation_id';
  const originalFetch = window.fetch.bind(window);
  let ensurePromise = null;
  let hydratedConversationId = null;

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
          await rawJson('/api/conversations/' + encodeURIComponent(id) + '/messages?limit=1');
          return id;
        } catch (error) {
          if (error.status !== 404) throw error;
          localStorage.removeItem(ACTIVE_KEY);
        }
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
        if (data && data.conversationId) localStorage.setItem(ACTIVE_KEY, data.conversationId);
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

  async function hydrateChatIfReady() {
    const box = document.getElementById('chat-messages');
    if (!box || typeof window.appendChatMessage !== 'function') return;
    let conversationId;
    try { conversationId = await ensureConversation(); }
    catch (error) { console.warn('[Conversation] restore unavailable:', error.message); return; }
    if (hydratedConversationId === conversationId && box.dataset.conversationHydrated === conversationId) return;

    try {
      const page = await rawJson('/api/conversations/' + encodeURIComponent(conversationId) + '/messages?limit=100');
      const items = visibleHistory(Array.isArray(page.items) ? page.items : []);
      if (items.length) {
        box.replaceChildren();
        items.forEach(function (item) {
          const role = item.message.role === 'user' ? 'user' : 'agent';
          window.appendChatMessage(role, item.message.content || '', {
            regeneratable: role === 'agent',
            messageId: item.messageId,
          });
        });
      }
      hydratedConversationId = conversationId;
      box.dataset.conversationHydrated = conversationId;
      ensureNewConversationButton();
    } catch (error) {
      console.warn('[Conversation] history restore failed:', error.message);
    }
  }

  function ensureNewConversationButton() {
    const form = document.getElementById('chat-form');
    if (!form || document.getElementById('chat-new-conversation')) return;
    const button = document.createElement('button');
    button.id = 'chat-new-conversation';
    button.type = 'button';
    button.className = 'btn btn-secondary';
    button.textContent = 'Nouvelle conversation';
    button.addEventListener('click', async function () {
      button.disabled = true;
      try {
        const id = await createConversation();
        const box = document.getElementById('chat-messages');
        if (box) {
          box.replaceChildren();
          box.dataset.conversationHydrated = id;
          hydratedConversationId = id;
          if (typeof window.appendChatMessage === 'function') {
            window.appendChatMessage('agent', "Bonjour, je suis Jarvis Command Center. Comment puis-je vous aider aujourd'hui ?", { regeneratable: false });
          }
        }
      } catch (error) {
        console.warn('[Conversation] new conversation failed:', error.message);
      } finally {
        button.disabled = false;
      }
    });
    form.insertBefore(button, form.firstChild);
  }

  async function boot() {
    try { await ensureConversation(); } catch (_) {}
    const timer = window.setInterval(function () { void hydrateChatIfReady(); }, 500);
    window.addEventListener('beforeunload', function () { window.clearInterval(timer); }, { once: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else void boot();

  window.JarvisConversationPersistence = {
    ensureConversation: ensureConversation,
    newConversation: createConversation,
    getActiveConversationId: function () { return localStorage.getItem(ACTIVE_KEY) || ''; },
  };
})();
