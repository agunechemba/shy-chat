// ════════════════════════════════════════════════════════
//  shy-chat — front-end
//  Set API_URL to the /exec URL of your Apps Script deployment.
//  If POST throws CORS errors on some networks, flip USE_JSONP = true.
// ════════════════════════════════════════════════════════

const API_URL   = 'https://script.google.com/macros/s/AKfycbxaAkjnh6F554_7CLLmIaDQzX978Y9rXZ6YyP4-a3NaYdlHRO_TexxaMnHC4Pn1F11w/exec';
const USE_JSONP = false; // ← true if POST fails with a CORS error

const POLL_INTERVAL      = 3000;
const HEARTBEAT_INTERVAL = 10000;

let state = {
  room: '',
  user: '',
  pollTimer: null,
  heartbeatTimer: null,
  sending: false,
};

let lastSignature = '';

// ── TRANSPORT: POST text/plain (default) ────────────────
async function fetchRequest(payload) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  if (data && data.error) throw new Error(data.error);
  return data;
}

// ── TRANSPORT: JSONP (fallback) ─────────────────────────
function jsonpRequest(payload) {
  return new Promise(function (resolve, reject) {
    const cbName = 'shychat_cb_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
    const params = new URLSearchParams();
    Object.keys(payload).forEach(function (k) {
      if (payload[k] !== undefined && payload[k] !== null) params.set(k, payload[k]);
    });
    params.set('callback', cbName);
    params.set('_t', Date.now()); // cache-buster

    const script = document.createElement('script');
    let done = false;

    function cleanup() {
      if (done) return;
      done = true;
      try { delete window[cbName]; } catch (_) { window[cbName] = undefined; }
      if (script.parentNode) script.parentNode.removeChild(script);
    }

    window[cbName] = function (data) {
      cleanup();
      if (data && data.error) reject(new Error(data.error));
      else resolve(data);
    };

    script.onerror = function () {
      cleanup();
      reject(new Error('JSONP request failed'));
    };

    script.src = API_URL + '?' + params.toString();
    document.body.appendChild(script);

    // Safety timeout
    setTimeout(function () {
      if (!done) { cleanup(); reject(new Error('JSONP timeout')); }
    }, 20000);
  });
}

// ── API WRAPPER ─────────────────────────────────────────
function api(action, extra) {
  extra = extra || {};
  const payload = Object.assign(
    { action: action, room: state.room, user: state.user },
    extra
  );
  return USE_JSONP ? jsonpRequest(payload) : fetchRequest(payload);
}

// ── UI ELEMENTS ─────────────────────────────────────────
const joinScreen   = document.getElementById('join-screen');
const chatScreen   = document.getElementById('chat-screen');
const roomInput    = document.getElementById('room-input');
const userInput    = document.getElementById('user-input');
const joinBtn      = document.getElementById('join-btn');
const joinError    = document.getElementById('join-error');
const messagesEl   = document.getElementById('messages');
const inputForm    = document.getElementById('input-area');
const messageInput = document.getElementById('message-input');
const sendBtn      = document.getElementById('send-btn');
const leaveBtn     = document.getElementById('leave-btn');
const roomLabel    = document.getElementById('room-label');

// ── VIEWPORT (fixes iOS keyboard overlap) ───────────────
(function setupViewport() {
  if (!window.visualViewport) return;
  const update = () => {
    document.documentElement.style.setProperty(
      '--app-height',
      window.visualViewport.height + 'px'
    );
  };
  window.visualViewport.addEventListener('resize', update);
  window.visualViewport.addEventListener('scroll', update);
  update();
})();

// ── JOIN ────────────────────────────────────────────────
joinBtn.addEventListener('click', async () => {
  const room = roomInput.value.trim();
  const user = userInput.value.trim();
  joinError.hidden = true;

  if (!room || !user) {
    joinError.textContent = 'Please enter both a room name and your name.';
    joinError.hidden = false;
    return;
  }

  state.room = room;
  state.user = user;
  joinBtn.disabled = true;

  try {
    await api('join');
    joinScreen.style.display = 'none';
    chatScreen.classList.add('active');
    roomLabel.textContent = 'Room: ' + room;
    lastSignature = '';
    startPolling();
    startHeartbeat();
    await loadMessages();
  } catch (err) {
    state.room = '';
    state.user = '';
    joinError.textContent = 'Could not join: ' + err.message;
    joinError.hidden = false;
  } finally {
    joinBtn.disabled = false;
  }
});

// ── LEAVE ───────────────────────────────────────────────
leaveBtn.addEventListener('click', async () => {
  stopTimers();
  try { await api('leave'); } catch (_) { /* ignore */ }

  chatScreen.classList.remove('active');
  joinScreen.style.display = '';
  messagesEl.innerHTML = '';
  lastSignature = '';
  state.room = '';
  state.user = '';
});

// ── SEND ────────────────────────────────────────────────
inputForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text || state.sending) return;

  state.sending = true;
  sendBtn.disabled = true;
  messageInput.value = '';

  try {
    await api('send', { text: text });
    await loadMessages();
  } catch (err) {
    // Restore the text so the user can retry.
    messageInput.value = text;
    alert('Send failed: ' + err.message);
  } finally {
    state.sending = false;
    sendBtn.disabled = false;
    messageInput.focus();
  }
});

// ── POLLING ─────────────────────────────────────────────
function startPolling() {
  state.pollTimer = setInterval(loadMessages, POLL_INTERVAL);
}

function stopTimers() {
  clearInterval(state.pollTimer);
  clearInterval(state.heartbeatTimer);
  state.pollTimer = null;
  state.heartbeatTimer = null;
}

async function loadMessages() {
  try {
    const data = await api('messages');
    renderMessages(data.messages || []);
  } catch (_) {
    // Silent — transient failures are fine.
  }
}

function renderMessages(messages) {
  const sig = messages.length + '|' +
              (messages.length ? messages[messages.length - 1].timestamp : 0);
  if (sig === lastSignature) return;
  lastSignature = sig;

  const frag = document.createDocumentFragment();

  messages.forEach(function (m) {
    const div = document.createElement('div');
    div.className = 'msg ' + (m.user === state.user ? 'self' : 'other');

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = m.user + ' · ' + new Date(m.timestamp).toLocaleTimeString();

    const body = document.createElement('div');
    body.textContent = m.text; // textContent — no XSS

    div.appendChild(meta);
    div.appendChild(body);
    frag.appendChild(div);
  });

  messagesEl.innerHTML = '';
  messagesEl.appendChild(frag);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ── HEARTBEAT ───────────────────────────────────────────
function startHeartbeat() {
  state.heartbeatTimer = setInterval(async () => {
    try { await api('heartbeat'); } catch (_) { /* ignore */ }
  }, HEARTBEAT_INTERVAL);
}

// ── BEST-EFFORT LEAVE ON UNLOAD ─────────────────────────
// sendBeacon sends text/plain by default — exactly what doPost expects.
window.addEventListener('beforeunload', function () {
  if (!state.room || !state.user) return;
  const body = JSON.stringify({
    action: 'leave',
    room: state.room,
    user: state.user,
  });
  if (navigator.sendBeacon) {
    navigator.sendBeacon(API_URL, body);
  } else {
    // Fallback: keepalive fetch
    fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: body,
      keepalive: true,
    });
  }
});