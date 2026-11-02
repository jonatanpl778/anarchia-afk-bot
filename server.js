require('dotenv').config();

const crypto = require('crypto');
const http = require('http');
const { createBotController } = require('./bot');

const PORT = Number(process.env.PORT) || 3000;
const CONTROLLER_SECRET = process.env.CONTROLLER_SECRET || '';
const MAX_LOGS = 200;

let statusMessage = 'Panel działa. Bot jeszcze nie został uruchomiony.';
const logs = [];

function appendLog(message) {
  const text = String(message || '').trim();
  if (!text) return;

  const timestamp = new Date().toLocaleTimeString('pl-PL', { hour12: false });
  logs.push(`[${timestamp}] ${text}`);
  if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
}

const botController = createBotController({
  onLog: appendLog,
  onStateChange: ({ message }) => {
    if (message) statusMessage = message;
  }
});

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

function authorized(req) {
  if (!CONTROLLER_SECRET) return false;

  const supplied = req.headers['x-controller-key'];
  if (typeof supplied !== 'string') return false;

  const expectedBuffer = Buffer.from(CONTROLLER_SECRET);
  const suppliedBuffer = Buffer.from(supplied);
  return suppliedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(suppliedBuffer, expectedBuffer);
}

const html = `<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OneBlock Controller</title>
  <style>
    body {
      background: #17251c;
      color: white;
      font-family: Arial, sans-serif;
      text-align: center;
      padding: 20px;
    }
    h1 { color: #72d58b; }
    button {
      width: 42%;
      padding: 20px 5px;
      margin: 8px;
      border: 0;
      border-radius: 12px;
      color: white;
      font-size: 18px;
      font-weight: bold;
      cursor: pointer;
    }
    .start { background: #278344; }
    .stop { background: #a43d3d; }
    .manual { background: #326da0; }
    .auto { background: #a4772d; }
    #status {
      margin-top: 25px;
      padding: 18px;
      background: #263a2d;
      border-radius: 12px;
      white-space: pre-wrap;
    }
    #auth {
      margin: 18px auto;
      padding: 14px;
      max-width: 520px;
      background: #263a2d;
      border-radius: 12px;
    }
    #controller-key {
      box-sizing: border-box;
      width: min(100%, 420px);
      padding: 12px;
      border: 1px solid #52735d;
      border-radius: 8px;
      background: #17251c;
      color: white;
    }
    #console {
      margin-top: 18px;
      padding: 12px;
      min-height: 140px;
      max-height: 260px;
      overflow-y: auto;
      background: #0e1713;
      border: 1px solid #2d4938;
      border-radius: 10px;
      color: #dfeedd;
      text-align: left;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font: 13px/1.5 Consolas, monospace;
    }
  </style>
</head>
<body>
  <h1>⛏️ ONEBLOCK CONTROLLER</h1>
  <p>ANARCHIA.GG</p>

  <div id="auth">
    <label for="controller-key">Klucz dostępu do panelu</label><br><br>
    <input id="controller-key" type="password" autocomplete="current-password" placeholder="Wpisz CONTROLLER_SECRET">
    <button id="unlock" type="button">Zaloguj</button>
    <p id="auth-message" role="status">Sterowanie wymaga klucza skonfigurowanego w hostingu.</p>
  </div>

  <button class="start" onclick="send('start')">▶ START</button>
  <button class="stop" onclick="send('stop')">■ STOP</button>
  <button class="manual" onclick="send('manual')">🎮 MANUAL</button>
  <button class="auto" onclick="send('auto')">🤖 AUTO</button>

  <div id="status">Zaloguj się, aby zobaczyć status bota.</div>
  <div id="console" aria-live="polite">Zaloguj się, aby zobaczyć logi.</div>

  <script>
    const keyInput = document.getElementById('controller-key');
    const authMessage = document.getElementById('auth-message');
    let controllerKey = sessionStorage.getItem('controllerKey') || '';

    async function api(path, options = {}) {
      const response = await fetch(path, {
        ...options,
        cache: 'no-store',
        headers: {
          ...(options.headers || {}),
          'X-Controller-Key': controllerKey
        }
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || 'Żądanie nie powiodło się.');
      return data;
    }

    async function unlock() {
      controllerKey = keyInput.value.trim();
      try {
        await api('/api/status');
        sessionStorage.setItem('controllerKey', controllerKey);
        keyInput.value = '';
        authMessage.textContent = 'Dostęp przyznany.';
        await refresh();
      } catch (error) {
        controllerKey = '';
        sessionStorage.removeItem('controllerKey');
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
      if (!controllerKey) return;
      try {
        const [status, logData] = await Promise.all([
          api('/api/status'),
          api('/api/logs')
        ]);
        document.getElementById('status').textContent = status.message;
        const consoleElement = document.getElementById('console');
        const wasAtBottom = consoleElement.scrollTop + consoleElement.clientHeight >= consoleElement.scrollHeight - 10;
        consoleElement.textContent = logData.logs.join('\\n');
        if (wasAtBottom) consoleElement.scrollTop = consoleElement.scrollHeight;
      } catch (error) {
        document.getElementById('status').textContent = error.message;
        if (error.message.includes('autoryz')) {
          controllerKey = '';
          sessionStorage.removeItem('controllerKey');
        }
      }
    }

    document.getElementById('unlock').addEventListener('click', unlock);
    keyInput.addEventListener('keydown', event => {
      if (event.key === 'Enter') unlock();
    });

    if (controllerKey) {
      keyInput.value = '';
      authMessage.textContent = 'Sprawdzanie dostępu...';
      refresh();
    }
    setInterval(refresh, 2000);

    window.send = send;
  </script>
</body>
</html>`;

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

  if (url.pathname.startsWith('/api/')) {
    if (!CONTROLLER_SECRET) {
      return sendJson(res, 503, {
        message: 'Sterowanie wyłączone: administrator musi ustawić CONTROLLER_SECRET.'
      });
    }
    if (!authorized(req)) {
      return sendJson(res, 401, { message: 'Brak autoryzacji. Sprawdź klucz dostępu.' });
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      return sendJson(res, 200, {
        message: statusMessage,
        state: botController.getStatus().state
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`OneBlock Controller działa na porcie ${PORT}`);
  appendLog('Panel uruchomiony.');
  if (!CONTROLLER_SECRET) {
    console.error('CONTROLLER_SECRET nie jest ustawiony; endpointy API pozostają wyłączone.');
    appendLog('Brak CONTROLLER_SECRET: sterowanie API jest wyłączone.');
  } else if (CONTROLLER_SECRET.length < 32) {
    console.warn('CONTROLLER_SECRET powinien mieć co najmniej 32 znaki.');
    appendLog('Ostrzeżenie: CONTROLLER_SECRET powinien mieć co najmniej 32 znaki.');
  }
});
