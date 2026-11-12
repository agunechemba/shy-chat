// ════════════════════════════════════════════════════════
//  shy-chat — front-end
//  1. Set API_URL to your Apps Script /exec URL.
//  2. Flip USE_JSONP = true if POST hits a CORS error.
// ════════════════════════════════════════════════════════

const API_URL   = 'https://script.google.com/macros/s/AKfycbxaAkjnh6F554_7CLLmIaDQzX978Y9rXZ6YyP4-a3NaYdlHRO_TexxaMnHC4Pn1F11w/exec';
const USE_JSONP = false;

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

// ── NOTIFICATIONS ───────────────────────────────────────
const BASE_TITLE       = document.title;
const seenMessages     = new Set();
let   unreadCount      = 0;
let   notificationsOn  = false;   // becomes true after the first render

function requestNotificationPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'default') return;
  try {
    const r = Notification.requestPermission();
    if (r && typeof r.catch === 'function') r.catch(function () {});
  } catch (_) {}
}

async function notifyNewMessage(m) {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  if (!document.hidden) return;

  const title    = 'shy-chat · ' + m.user;
  const bodyText = m.text.length > 140 ? m.text.slice(0, 140) + '…' : m.text;
  const opts     = {
    body:      bodyText,
    icon:      'icon-192.png',
    badge:     'icon-192.png',
    tag:       'shychat-' + state.room,
    renotify:  true,
  };

  // Prefer the service worker (required on Android Chrome).
  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg && typeof reg.showNotification === 'function') {
        await reg.showNotification(title, opts);
        return;
      }
    }
  } catch (_) {}

  try { new Notification(title, opts); } catch (_) {}
}

function updateTitle() {
  document.title = (unreadCount > 0 && document.hidden)
    ? '(' + unreadCount + ') ' + BASE_TITLE
    : BASE_TITLE;
}

function clearUnread() {
  if (unreadCount !== 0 || document.title !== BASE_TITLE) {
    unreadCount = 0;
    updateTitle();
  }
}

document.addEventListener('visibilitychange', function () {
  if (!document.hidden) clearUnread();
  else updateTitle();
});
window.addEventListener('focus', clearUnread);

// ── TRANSPORT: POST text/plain ──────────────────────────
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

// ── TRANSPORT: JSONP fallback ───────────────────────────
function jsonpRequest(payload) {
  return new Promise(function (resolve, reject) {
    const cbName = 'shychat_cb_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
    const params = new URLSearchParams();
    Object.keys(payload).forEach(function (k) {
      if (payload[k] !== undefined && payload[k] !== null) params.set(k, payload[k]);
    });
    params.set('callback', cbName);
    params.set('_t', Date.now());

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
const joinScreen    = document.getElementById('join-screen');
const chatScreen    = document.getElementById('chat-screen');
const roomInput     = document.getElementById('room-input');
const userInput     = document.getElementById('user-input');
const joinBtn       = document.getElementById('join-btn');
const joinError     = document.getElementById('join-error');
const messagesEl    = document.getElementById('messages');
const inputForm     = document.getElementById('input-area');
const messageInput  = document.getElementById('message-input');
const sendBtn       = document.getElementById('send-btn');
const leaveBtn      = document.getElementById('leave-btn');
const roomLabel     = document.getElementById('room-label');
const installBtn    = document.getElementById('install-btn');
const iosHint       = document.getElementById('ios-hint');
const updateBanner  = document.getElementById('update-banner');
const updateBtn     = document.getElementById('update-btn');
const updateDismiss = document.getElementById('update-dismiss');

// ── VIEWPORT (iOS keyboard fix) ─────────────────────────
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

// ════════════════════════════════════════════════════════
//  PWA — SERVICE WORKER + INSTALL + UPDATE
// ════════════════════════════════════════════════════════

// ── Service worker registration ─────────────────────────
let refreshing = false;

if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const newWorker = reg.installing;
      if (!newWorker) return;
      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          showUpdateBanner(newWorker);
        }
      });
    });
  }).catch((err) => {
    console.warn('[pwa] SW registration failed:', err);
  });
}

function showUpdateBanner(worker) {
  updateBanner.hidden = false;
  updateBtn.onclick = () => {
    updateBanner.hidden = true;
    worker.postMessage({ type: 'SKIP_WAITING' });
  };
  updateDismiss.onclick = () => { updateBanner.hidden = true; };
}

// ── Install prompt (Android/Chrome/Edge) ────────────────
let deferredPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  if (!isStandalone()) installBtn.hidden = false;
});

installBtn.addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  try {
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') installBtn.hidden = true;
  } catch (_) {}
  deferredPrompt = null;
});

window.addEventListener('appinstalled', () => {
  installBtn.hidden = true;
  iosHint.hidden = true;
  deferredPrompt = null;
});

// ── iOS install hint ────────────────────────────────────
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
              (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches ||
         window.navigator.standalone === true;
}

if (isIOS && !isStandalone()) {
  iosHint.hidden = false;
}

window.matchMedia('(display-mode: standalone)').addEventListener?.('change', () => {
  if (isStandalone()) {
    installBtn.hidden = true;
    iosHint.hidden = true;
  }
});

// ════════════════════════════════════════════════════════
//  CHAT LOGIC
// ════════════════════════════════════════════════════════

// ── JOIN ────────────────────────────────────────────────
async function doJoin(room, user) {
  joinError.hidden = true;

  if (!room || !user) {
    joinError.textContent = 'Please enter both a room name and your name.';
    joinError.hidden = false;
    return;
  }
  if (!navigator.onLine) {
    joinError.textContent = 'You are offline. Please reconnect.';
    joinError.hidden = false;
    return;
  }

  // Ask for notification permission while still inside the user gesture.
  requestNotificationPermission();

  state.room = room;
  state.user = user;
  joinBtn.disabled = true;

  try {
    await api('join');
    sessionStorage.setItem('shychat.room', room);
    sessionStorage.setItem('shychat.user', user);
    joinScreen.style.display = 'none';
    chatScreen.classList.add('active');
    roomLabel.textContent = 'Room: ' + room;

    // Reset message-tracking + notification state for the new room.
    lastSignature      = '';
    seenMessages.clear();
    unreadCount        = 0;
    notificationsOn    = false;
    updateTitle();

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
}

joinBtn.addEventListener('click', () => {
  doJoin(roomInput.value.trim(), userInput.value.trim());
});

// ── LEAVE ───────────────────────────────────────────────
leaveBtn.addEventListener('click', async () => {
  stopTimers();
  try { await api('leave'); } catch (_) {}
  sessionStorage.removeItem('shychat.room');
  sessionStorage.removeItem('shychat.user');
  chatScreen.classList.remove('active');
  joinScreen.style.display = '';
  messagesEl.innerHTML = '';
  lastSignature = '';
  state.room = '';
  state.user = '';

  seenMessages.clear();
  unreadCount     = 0;
  notificationsOn = false;
  updateTitle();
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
  } catch (_) {}
}

function renderMessages(messages) {
  const sig = messages.length + '|' +
              (messages.length ? messages[messages.length - 1].timestamp : 0);
  if (sig === lastSignature) return;
  lastSignature = sig;

  // ── Detect new messages from other users ─────────────
  let latestFromOther = null;
  messages.forEach(function (m) {
    const key = m.user + '|' + m.timestamp;
    if (seenMessages.has(key)) return;
    seenMessages.add(key);
    if (notificationsOn && m.user !== state.user && document.hidden) {
      unreadCount++;
      latestFromOther = m;
    }
  });
  if (notificationsOn) {
    if (latestFromOther) notifyNewMessage(latestFromOther);
    updateTitle();
  }
  notificationsOn = true;

  // ── Render ───────────────────────────────────────────
  const frag = document.createDocumentFragment();
  messages.forEach(function (m) {
    const div = document.createElement('div');
    div.className = 'msg ' + (m.user === state.user ? 'self' : 'other');
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = m.user + ' · ' + new Date(m.timestamp).toLocaleTimeString();
    const body = document.createElement('div');
    body.textContent = m.text;
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
    try { await api('heartbeat'); } catch (_) {}
  }, HEARTBEAT_INTERVAL);
}

// ── BEST-EFFORT LEAVE ON UNLOAD ─────────────────────────
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
    fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: body,
      keepalive: true,
    });
  }
});

// ── SESSION RESTORE ─────────────────────────────────────
(function restoreSession() {
  const r = sessionStorage.getItem('shychat.room');
  const u = sessionStorage.getItem('shychat.user');
  if (r && u) {
    roomInput.value = r;
    userInput.value = u;
    doJoin(r, u);
  }
})();