/**
 * Interface de chat minimale servie directement par le serveur — pas de
 * build front-end séparé, pas de framework : un fichier HTML autonome qui
 * parle à l'API /chat du même Agent que la CLI (brique 8, encore une façade).
 */
export function getChatPageHtml(): string {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Jarvis</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f4f5f7;
    --card: #ffffff;
    --ink: #1b2430;
    --muted: #6b7280;
    --accent: #1f6f8b;
    --bubble-user: #1f6f8b;
    --bubble-user-ink: #ffffff;
    --bubble-agent: #eef1f6;
    --bubble-agent-ink: #1b2430;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #10161f;
      --card: #161d29;
      --ink: #e7ebf2;
      --muted: #8f9ab0;
      --accent: #69bcd4;
      --bubble-user: #1f6f8b;
      --bubble-user-ink: #ffffff;
      --bubble-agent: #232c3a;
      --bubble-agent-ink: #e7ebf2;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    height: 100vh;
    display: flex;
    flex-direction: column;
  }
  header {
    padding: 16px 20px;
    font-weight: 600;
    font-size: 1.1rem;
    border-bottom: 1px solid rgba(128,128,128,0.2);
    background: var(--card);
  }
  #messages {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .msg {
    max-width: 80%;
    padding: 10px 14px;
    border-radius: 14px;
    line-height: 1.4;
    white-space: pre-wrap;
    word-wrap: break-word;
  }
  .msg.user {
    align-self: flex-end;
    background: var(--bubble-user);
    color: var(--bubble-user-ink);
    border-bottom-right-radius: 4px;
  }
  .msg.agent {
    align-self: flex-start;
    background: var(--bubble-agent);
    color: var(--bubble-agent-ink);
    border-bottom-left-radius: 4px;
  }
  .msg.pending { opacity: 0.6; font-style: italic; }
  form {
    display: flex;
    gap: 8px;
    padding: 12px;
    border-top: 1px solid rgba(128,128,128,0.2);
    background: var(--card);
  }
  textarea {
    flex: 1;
    resize: none;
    border-radius: 10px;
    border: 1px solid rgba(128,128,128,0.3);
    padding: 10px 12px;
    font-size: 1rem;
    font-family: inherit;
    background: var(--bg);
    color: var(--ink);
    max-height: 120px;
  }
  button {
    border: none;
    border-radius: 10px;
    padding: 0 18px;
    background: var(--accent);
    color: white;
    font-size: 1rem;
    cursor: pointer;
  }
  button:disabled { opacity: 0.5; cursor: default; }
  #error {
    color: #c0392b;
    padding: 0 16px;
    font-size: 0.9rem;
  }
</style>
</head>
<body>
<header>🤖 Jarvis</header>
<div id="messages"></div>
<div id="error" hidden></div>
<form id="form">
  <textarea id="input" rows="1" placeholder="Écris un message..." autofocus></textarea>
  <button id="send" type="submit">Envoyer</button>
</form>
<script>
  const messagesEl = document.getElementById('messages');
  const formEl = document.getElementById('form');
  const inputEl = document.getElementById('input');
  const sendEl = document.getElementById('send');
  const errorEl = document.getElementById('error');

  function getToken() {
    return localStorage.getItem('jarvis_token') || '';
  }

  function addMessage(role, text) {
    const div = document.createElement('div');
    div.className = 'msg ' + role;
    div.textContent = text;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  async function send(message) {
    errorEl.hidden = true;
    addMessage('user', message);
    const pending = addMessage('agent pending', '...');
    sendEl.disabled = true;

    try {
      const headers = { 'content-type': 'application/json' };
      const token = getToken();
      if (token) headers['authorization'] = 'Bearer ' + token;

      const res = await fetch('/chat', {
        method: 'POST',
        headers,
        body: JSON.stringify({ message }),
      });

      if (res.status === 401) {
        const entered = prompt('Ce Jarvis est protégé par un token. Colle-le ici :');
        if (entered) {
          localStorage.setItem('jarvis_token', entered);
          pending.remove();
          return send(message);
        }
        pending.textContent = 'Non autorisé.';
        pending.classList.remove('pending');
        return;
      }

      const data = await res.json();
      pending.textContent = data.response ?? ('Erreur: ' + (data.error || 'réponse invalide'));
      pending.classList.remove('pending');
    } catch (err) {
      pending.remove();
      errorEl.hidden = false;
      errorEl.textContent = 'Erreur réseau : ' + err.message;
    } finally {
      sendEl.disabled = false;
    }
  }

  formEl.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = '';
    send(text);
  });

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      formEl.requestSubmit();
    }
  });
</script>
</body>
</html>`;
}
