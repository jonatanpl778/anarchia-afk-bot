
const http = require('http');

const PORT = process.env.PORT || 3000;

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
}
</style>
</head>
<body>
<h1>⛏️ ONEBLOCK CONTROLLER</h1>
<p>ANARCHIA.GG</p>
<button class="start" onclick="send('start')">▶ START</button>
<button class="stop" onclick="send('stop')">■ STOP</button>
<button class="manual" onclick="send('manual')">🎮 MANUAL</button>
<button class="auto" onclick="send('auto')">🤖 AUTO</button>
<div id="status">Łączenie z panelem...</div>
<script>
async function send(action) {
  const result = await fetch('/api/' + action, {method:'POST'});
  const data = await result.json();
  document.getElementById('status').textContent = data.message;
}
async function refresh() {
  const result = await fetch('/api/status');
  const data = await result.json();
  document.getElementById('status').textContent = data.message;
}
refresh();
</script>
</body>
</html>`;

let status = 'Panel działa. Bot jeszcze nie został uruchomiony.';

const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
    return res.end(html);
  }

  if (req.url === '/api/status') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    return res.end(JSON.stringify({message: status}));
  }

  if (req.method === 'POST' && req.url.startsWith('/api/')) {
    const action = req.url.split('/').pop();

    if (['start', 'stop', 'manual', 'auto'].includes(action)) {
      status = 'Odebrano polecenie: ' + action.toUpperCase() +
        '. Sterowanie botem dodamy w następnym kroku.';
      res.writeHead(200, {'Content-Type': 'application/json'});
      return res.end(JSON.stringify({message: status}));
    }
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('OneBlock Controller działa na porcie ' + PORT);
});
