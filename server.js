require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { Server: SocketIOServer } = require('socket.io');
const { WorldView } = require('prismarine-viewer').viewer;
const { createBotController } = require('./bot');

const PORT = Number(process.env.PORT) || 3000;
const CONTROLLER_SECRET = process.env.CONTROLLER_SECRET || '';
const MAX_LOGS = 200;
const SESSION_COOKIE = 'controller_session';
const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;
const VIEWER_DISTANCE = Math.min(6, Math.max(2, Number(process.env.VIEWER_DISTANCE) || 4));
const VIEWER_PUBLIC_DIR = path.join(__dirname, 'node_modules', 'prismarine-viewer', 'public');

let statusMessage = 'Panel działa. Bot jeszcze nie został uruchomiony.';
let viewerBot = null;
const logs = [];
const viewerSockets = new Set();

function appendLog(message) {
  const text = String(message || '').trim();
  if (!text) return;

  const timestamp = new Date().toLocaleTimeString('pl-PL', { hour12: false });
  logs.push(`[${timestamp}] ${text}`);
  if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function requestHasValidControllerKey(req) {
  const supplied = req.headers['x-controller-key'];
  return Boolean(CONTROLLER_SECRET && typeof supplied === 'string' && safeEqual(supplied, CONTROLLER_SECRET));
}

function makeSessionToken(expiresAt) {
  const payload = String(expiresAt);
  const signature = crypto.createHmac('sha256', CONTROLLER_SECRET).update(payload).digest('hex');
  return `${payload}.${signature}`;
}

function isValidSessionToken(token) {
  if (!CONTROLLER_SECRET || typeof token !== 'string') return false;
  const match = token.match(/^(\d{10,})\.([a-f0-9]{64})$/);
  if (!match) return false;

  const expiresAt = Number(match[1]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) return false;
  return safeEqual(makeSessionToken(expiresAt), token);
}

function getCookie(req, name) {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return '';
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = header.match(new RegExp(`(?:^|;\\s*)${escapedName}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : '';
}

function hasValidSession(req) {
  try {
    return isValidSessionToken(getCookie(req, SESSION_COOKIE));
  } catch {
    return false;
  }
}

function isAuthorized(req) {
  return requestHasValidControllerKey(req) || hasValidSession(req);
}

function setSessionCookie(req, res) {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS;
  const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
  const secureAttribute = secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${makeSessionToken(expiresAt)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE_SECONDS}${secureAttribute}`);
}

function clearSessionCookie(req, res) {
  const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(payload));
}

function attachViewerToBot(bot) {
  viewerBot = bot;
  appendLog('Podgląd 3D jest gotowy.');
}

function closeViewerForBot(bot) {
  if (viewerBot === bot) viewerBot = null;
  for (const socket of viewerSockets) socket.disconnect(true);
  viewerSockets.clear();
  appendLog('Połączenia podglądu 3D zostały zamknięte.');
}

const botController = createBotController({
  onLog: appendLog,
  onStateChange: ({ message }) => {
    if (message) statusMessage = message;
  },
  onSpawn: attachViewerToBot,
  onVerification: message => {
    statusMessage = 'Wykryto weryfikację pozycji. Wymagane jest ręczne działanie użytkownika.';
    appendLog(`WERYFIKACJA: ${message}`);
  },
  onEnd: closeViewerForBot
});

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    res.writeHead(400);
    return res.end('Bad request');
  }

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    });
    return res.end(html);
  }

  if (req.method === 'POST' && url.pathname === '/api/session') {
    if (!CONTROLLER_SECRET) {
      return sendJson(res, 503, { message: 'Sterowanie wyłączone: administrator musi ustawić CONTROLLER_SECRET.' });
    }
    if (!requestHasValidControllerKey(req)) {
      return sendJson(res, 401, { message: 'Brak autoryzacji. Sprawdź klucz dostępu.' });
    }
    setSessionCookie(req, res);
    return sendJson(res, 200, { message: 'Dostęp przyznany.' });
  }

  if (req.method === 'POST' && url.pathname === '/api/logout') {
    clearSessionCookie(req, res);
    return sendJson(res, 200, { message: 'Wylogowano.' });
  }

  if (url.pathname === '/viewer' || url.pathname.startsWith('/viewer/')) {
    if (!CONTROLLER_SECRET) {
      return sendJson(res, 503, { message: 'Podgląd wyłączony: administrator musi ustawić CONTROLLER_SECRET.' });
    }
    if (!hasValidSession(req)) {
      return sendJson(res, 401, { message: 'Zaloguj się do panelu, aby otworzyć podgląd.' });
    }
    if (!viewerBot || !botController.getStatus().online) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end('Podgląd jest dostępny po połączeniu bota.');
    }

    const relativeFile = url.pathname === '/viewer' || url.pathname === '/viewer/'
      ? 'index.html'
      : decodeURIComponent(url.pathname.slice('/viewer/'.length));
    const targetPath = path.resolve(VIEWER_PUBLIC_DIR, relativeFile);
    if (!targetPath.startsWith(`${path.resolve(VIEWER_PUBLIC_DIR)}${path.sep}`)) {
      res.writeHead(400);
      return res.end('Bad request');
    }

    fs.readFile(targetPath, (error, contents) => {
      if (error) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Viewer asset not found');
      }
      const extension = path.extname(targetPath).toLowerCase();
      const contentTypes = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon'
      };
      res.writeHead(200, {
        'Content-Type': contentTypes[extension] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer'
      });
      res.end(contents);
    });
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    if (!CONTROLLER_SECRET) {
      return sendJson(res, 503, { message: 'Sterowanie wyłączone: administrator musi ustawić CONTROLLER_SECRET.' });
    }
    if (!isAuthorized(req)) {
      return sendJson(res, 401, { message: 'Brak autoryzacji. Sprawdź klucz dostępu.' });
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      const botStatus = botController.getStatus();
      return sendJson(res, 200, {
        message: statusMessage,
        state: botStatus.state,
        viewer: botStatus.online && viewerBot ? 'active' : 'inactive',
        verificationRequired: botStatus.verificationRequired
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/logs') {
      return sendJson(res, 200, { logs });
    }

    if (req.method === 'POST' && url.pathname === '/api/start') {
      try {
        const result = await botController.start();
        return sendJson(res, result.ok ? 200 : 409, { message: result.message });
      } catch (error) {
        appendLog(`START: ${error.message || error}`);
        return sendJson(res, 500, { message: 'Nie udało się uruchomić bota.' });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/stop') {
      try {
        const result = await botController.stop();
        return sendJson(res, result.ok ? 200 : 409, { message: result.message });
      } catch (error) {
        appendLog(`STOP: ${error.message || error}`);
        return sendJson(res, 500, { message: 'Nie udało się zatrzymać bota.' });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/manual') {
      return sendJson(res, 200, { message: 'Tryb MANUAL nie jest jeszcze zaimplementowany.' });
    }

    if (req.method === 'POST' && url.pathname === '/api/auto') {
      return sendJson(res, 200, { message: 'Tryb AUTO nie jest jeszcze zaimplementowany.' });
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

const io = new SocketIOServer(server, {
  path: '/viewer/socket.io',
  serveClient: false,
  maxHttpBufferSize: 1e6,
  cors: { origin: false }
});

io.use((socket, next) => {
  if (!CONTROLLER_SECRET || !isValidSessionToken(getCookie(socket.request, SESSION_COOKIE))) {
    return next(new Error('Unauthorized'));
  }
  next();
});

io.on('connection', socket => {
  const bot = viewerBot;
  if (!bot || !bot.entity || !bot.world || !botController.getStatus().online) {
    socket.disconnect(true);
    return;
  }

  viewerSockets.add(socket);
  socket.emit('version', bot.version);

  const worldView = new WorldView(bot.world, VIEWER_DISTANCE, bot.entity.position, socket);
  const sendPosition = () => {
    if (!bot.entity) return;
    socket.emit('position', {
      pos: bot.entity.position,
      yaw: bot.entity.yaw,
      addMesh: true
    });
    worldView.updatePosition(bot.entity.position).catch(error => {
      appendLog(`Nie udało się odświeżyć pozycji podglądu: ${error.message || error}`);
    });
  };

  worldView.listenToBot(bot);
  bot.on('move', sendPosition);
  worldView.init(bot.entity.position).then(sendPosition).catch(error => {
    appendLog(`Nie udało się załadować świata do podglądu: ${error.message || error}`);
  });

  socket.once('disconnect', () => {
    viewerSockets.delete(socket);
    bot.removeListener('move', sendPosition);
    worldView.removeListenersFromBot(bot);
  });
});

const html = `<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OneBlock Controller</title>
  <style>
    :root { --bg:#17251c; --panel:#263a2d; --dark:#0e1713; --green:#72d58b; --border:#52735d; }
    * { box-sizing: border-box; }
    body { margin:0; background:var(--bg); color:#fff; font-family:Arial,sans-serif; padding:16px; }
    .container { max-width:1200px; margin:0 auto; }
    header { text-align:center; }
    h1 { color:var(--green); margin-bottom:6px; }
    button { min-width:140px; padding:18px 14px; margin:5px; border:0; border-radius:12px; color:#fff; font-size:17px; font-weight:bold; cursor:pointer; }
    .start { background:#278344; } .stop { background:#a43d3d; } .manual { background:#326da0; } .auto { background:#a4772d; }
    .buttons { display:flex; flex-wrap:wrap; justify-content:center; gap:4px; }
    #auth { margin:16px auto; padding:14px; max-width:620px; text-align:center; background:var(--panel); border-radius:12px; }
    #controller-key { width:min(100%,420px); padding:12px; border:1px solid var(--border); border-radius:8px; background:var(--bg); color:white; }
    .layout { display:grid; grid-template-columns:minmax(0,1.3fr) minmax(280px,.7fr); gap:14px; margin-top:14px; }
    .card { min-width:0; padding:12px; background:var(--panel); border-radius:12px; }
    #viewer-frame { display:none; width:100%; height:min(62vh,600px); min-height:300px; border:0; border-radius:8px; background:#000; }
    #verification-alert { display:none; margin:0 0 10px; padding:12px; border:1px solid #d5a43b; border-radius:8px; background:#493a1d; color:#ffe4a3; font-weight:bold; }
    #viewer-placeholder { display:flex; min-height:300px; height:min(62vh,600px); align-items:center; justify-content:center; padding:20px; border-radius:8px; background:var(--dark); color:#dfeedd; text-align:center; }
    #status { margin:0 0 12px; padding:16px; background:var(--panel); border-radius:10px; white-space:pre-wrap; }
    #console { min-height:160px; max-height:260px; overflow:auto; padding:12px; background:var(--dark); border:1px solid var(--border); border-radius:10px; color:#dfeedd; text-align:left; white-space:pre-wrap; overflow-wrap:anywhere; font:13px/1.5 Consolas,monospace; }
    @media(max-width:850px) { .layout { grid-template-columns:1fr; } #viewer-frame,#viewer-placeholder { height:56vh; min-height:280px; } }
    @media(max-width:520px) { body { padding:10px; } button { flex:1 1 calc(50% - 12px); min-width:calc(50% - 12px); padding:16px 6px; font-size:16px; } #viewer-frame,#viewer-placeholder { height:50vh; min-height:240px; } }
  </style>
</head>
<body>
  <main class="container">
    <header><h1>⛏️ ONEBLOCK CONTROLLER</h1><p>ANARCHIA.GG</p></header>
    <section id="auth">
      <label for="controller-key">Klucz dostępu do panelu</label><br><br>
      <input id="controller-key" type="password" autocomplete="current-password" placeholder="Wpisz CONTROLLER_SECRET">
      <button id="unlock" type="button">Zaloguj</button>
      <p id="auth-message" role="status">Sterowanie i podgląd wymagają klucza skonfigurowanego w hostingu.</p>
    </section>
    <div class="buttons">
      <button class="start" onclick="send('start')">▶ START</button>
      <button class="stop" onclick="send('stop')">■ STOP</button>
      <button class="manual" onclick="send('manual')">🎮 MANUAL</button>
      <button class="auto" onclick="send('auto')">🤖 AUTO</button>
    </div>
    <section class="layout">
      <div class="card">
        <div id="verification-alert" role="alert">⚠️ Wykryto weryfikację pozycji. Wykonaj ją ręcznie w dozwolonym kliencie gry.</div>
        <div id="viewer-placeholder">Zaloguj się i uruchom bota, aby zobaczyć podgląd 3D świata.</div>
        <iframe id="viewer-frame" title="Podgląd 3D Minecrafta" allow="fullscreen" loading="lazy"></iframe>
      </div>
      <div class="card">
        <div id="status">Zaloguj się, aby zobaczyć status bota.</div>
        <h3>Logi</h3>
        <div id="console" aria-live="polite">Zaloguj się, aby zobaczyć logi.</div>
      </div>
    </section>
  </main>
  <script>
    const keyInput = document.getElementById('controller-key');
    const authMessage = document.getElementById('auth-message');
    const viewerFrame = document.getElementById('viewer-frame');
    const viewerPlaceholder = document.getElementById('viewer-placeholder');
    let controllerKey = '';
    let hasSession = false;

    function setViewerVisible(visible) {
      if (visible && hasSession) {
        if (viewerFrame.getAttribute('src') !== '/viewer/') viewerFrame.src = '/viewer/';
        viewerFrame.style.display = 'block';
        viewerPlaceholder.style.display = 'none';
      } else {
        viewerFrame.style.display = 'none';
        viewerFrame.removeAttribute('src');
        viewerPlaceholder.style.display = 'flex';
      }
    }

    async function api(path, options = {}) {
      const response = await fetch(path, {
        ...options,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { ...(options.headers || {}), ...(controllerKey ? { 'X-Controller-Key': controllerKey } : {}) }
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || 'Żądanie nie powiodło się.');
      return data;
    }

    async function unlock() {
      controllerKey = keyInput.value.trim();
      try {
        await api('/api/session', { method: 'POST' });
        hasSession = true;
        keyInput.value = '';
        authMessage.textContent = 'Dostęp przyznany.';
        await refresh();
      } catch (error) {
        controllerKey = '';
        hasSession = false;
        authMessage.textContent = error.message;
      }
    }

    async function send(action) {
      try {
        const data = await api('/api/' + action, { method: 'POST' });
        document.getElementById('status').textContent = data.message;
        await refresh();
      } catch (error) {
        document.getElementById('status').textContent = error.message;
      }
    }

    async function refresh() {
      if (!hasSession && !controllerKey) return;
      try {
        const [status, logData] = await Promise.all([api('/api/status'), api('/api/logs')]);
        document.getElementById('status').textContent = status.message;
        setViewerVisible(status.state === 'online' && status.viewer === 'active');
        document.getElementById('verification-alert').style.display = status.verificationRequired ? 'block' : 'none';
        const consoleElement = document.getElementById('console');
        const atBottom = consoleElement.scrollTop + consoleElement.clientHeight >= consoleElement.scrollHeight - 10;
        consoleElement.textContent = logData.logs.join('\\n');
        if (atBottom) consoleElement.scrollTop = consoleElement.scrollHeight;
      } catch (error) {
        document.getElementById('status').textContent = error.message;
        setViewerVisible(false);
        if (error.message.includes('autoryz')) {
          hasSession = false;
          controllerKey = '';
        }
      }
    }

    document.getElementById('unlock').addEventListener('click', unlock);
    keyInput.addEventListener('keydown', event => { if (event.key === 'Enter') unlock(); });
    setInterval(refresh, 2000);
    window.send = send;
  </script>
</body>
</html>`;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`OneBlock Controller działa na porcie ${PORT}`);
  appendLog('Panel uruchomiony.');
  if (!CONTROLLER_SECRET) {
    console.error('CONTROLLER_SECRET nie jest ustawiony; endpointy API i podgląd pozostają wyłączone.');
    appendLog('Brak CONTROLLER_SECRET: sterowanie i podgląd API są wyłączone.');
  } else if (CONTROLLER_SECRET.length < 32) {
    console.warn('CONTROLLER_SECRET powinien mieć co najmniej 32 znaki.');
    appendLog('Ostrzeżenie: CONTROLLER_SECRET powinien mieć co najmniej 32 znaki.');
  }
});
