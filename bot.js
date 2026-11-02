require('dotenv').config();
const mineflayer = require('mineflayer');

const SERVER_HOST = 'anarchia.gg';
const SERVER_PORT = 25565;

function createBotController(options = {}) {
  const onLog = typeof options.onLog === 'function' ? options.onLog : () => {};
  const onStateChange = typeof options.onStateChange === 'function' ? options.onStateChange : () => {};

  let bot = null;
  let state = 'offline';
  let loggedIn = false;
  let stopPromise = null;

  function log(message) {
    try {
      onLog(String(message));
    } catch (error) {
      console.error('Nie udało się zapisać logu bota:', error.message);
    }
  }

  function setState(nextState, message) {
    state = nextState;
    try {
      onStateChange({ state, message });
    } catch (error) {
      console.error('Nie udało się zaktualizować statusu bota:', error.message);
    }
  }

  function getStatus() {
    return { state, online: state === 'online' };
  }

  function start() {
    if (bot) {
      const message = state === 'starting'
        ? 'Bot już się łączy.'
        : state === 'online'
          ? 'Bot już działa.'
          : 'Instancja bota jest nadal aktywna; poczekaj na jej rozłączenie przed ponownym START.';
      return Promise.resolve({ ok: false, message });
    }

    if (!process.env.BOT_USERNAME) {
      const message = 'Brak zmiennej BOT_USERNAME w środowisku.';
      setState('error', message);
      log(message);
      return Promise.resolve({ ok: false, message });
    }

    loggedIn = false;
    setState('starting', 'Bot łączy się z serwerem...');
    log(`Łączenie z ${SERVER_HOST}:${SERVER_PORT}...`);

    let instance;
    try {
      instance = mineflayer.createBot({
        host: SERVER_HOST,
        port: SERVER_PORT,
        username: process.env.BOT_USERNAME,
        auth: 'offline',
        version: '1.20'
      });
      bot = instance;
    } catch (error) {
      const message = error.message || String(error);
      setState('error', `Nie udało się utworzyć bota: ${message}`);
      log(`Błąd tworzenia bota: ${message}`);
      return Promise.resolve({ ok: false, message: 'Nie udało się utworzyć instancji bota.' });
    }

    instance.once('spawn', () => {
      if (bot !== instance) return;
      log('Bot połączył się z serwerem.');
      setState('online', 'Bot połączył się z serwerem.');

      const loginTimer = setTimeout(() => {
        if (bot !== instance || state === 'stopping' || !process.env.BOT_PASSWORD) return;
        try {
          instance.chat('/l ' + process.env.BOT_PASSWORD);
          log('Wysłano komendę logowania do serwera.');
        } catch (error) {
          log(`Nie udało się wysłać komendy logowania: ${error.message || error}`);
        }
      }, 3000);
      if (typeof loginTimer.unref === 'function') loginTimer.unref();
    });

    instance.on('message', message => {
      const text = message.toString();
      if (text) log(text);

      if (!loggedIn && text.toLowerCase().includes('zalogowano')) {
        loggedIn = true;
        const islandTimer = setTimeout(() => {
          if (bot !== instance || state === 'stopping') return;
          try {
            instance.chat('/is');
          } catch (error) {
            log(`Nie udało się wysłać komendy /is: ${error.message || error}`);
          }
        }, 2000);
        if (typeof islandTimer.unref === 'function') islandTimer.unref();
      }
    });

    instance.on('kicked', reason => {
      const detail = typeof reason === 'string' ? reason : JSON.stringify(reason);
      log(`Bot został rozłączony przez serwer${detail ? `: ${detail}` : '.'}`);
    });

    instance.on('error', error => {
      const message = error && error.message ? error.message : String(error);
      log(`Błąd bota: ${message}`);
      if (bot === instance && state !== 'stopping') {
        setState('error', `Błąd połączenia bota: ${message}`);
      }
    });

    instance.once('end', reason => {
      const detail = reason ? String(reason) : '';
      log(`Połączenie bota zakończone${detail ? `: ${detail}` : '.'}`);
      if (bot !== instance) return;
      bot = null;
      loggedIn = false;

      if (state === 'stopping') {
        setState('offline', 'Bot został bezpiecznie rozłączony.');
      } else if (state !== 'error') {
        setState('offline', 'Bot jest rozłączony.');
      }
    });

    return Promise.resolve({ ok: true, message: 'Bot uruchomiony i łączy się z serwerem.' });
  }

  function stop() {
    if (stopPromise) {
      return Promise.resolve({ ok: false, message: 'Zatrzymywanie bota jest już w toku.' });
    }

    const instance = bot;
    if (!instance) {
      if (state !== 'error') setState('offline', 'Bot nie jest uruchomiony.');
      return Promise.resolve({ ok: true, message: state === 'error' ? 'Bot jest zatrzymany po błędzie; można spróbować ponownie.' : 'Bot nie jest uruchomiony.' });
    }

    setState('stopping', 'Bot jest rozłączany...');
    stopPromise = new Promise(resolve => {
      let settled = false;
      let timeout;

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (bot === instance) {
          bot = null;
          loggedIn = false;
        }
        setState('offline', 'Bot został bezpiecznie rozłączony.');
        log('Bot został bezpiecznie rozłączony.');
        resolve({ ok: true, message: 'Bot został bezpiecznie rozłączony.' });
      };

      instance.once('end', finish);
      timeout = setTimeout(() => {
        try {
          if (typeof instance.end === 'function') instance.end();
        } catch (error) {
          log(`Błąd wymuszonego rozłączenia: ${error.message || error}`);
        }
        finish();
      }, 5000);

      try {
        if (typeof instance.quit === 'function') {
          instance.quit('Stopped from OneBlock Controller');
        } else if (typeof instance.end === 'function') {
          instance.end();
        } else {
          finish();
        }
      } catch (error) {
        log(`Błąd podczas rozłączania: ${error.message || error}`);
        try {
          if (typeof instance.end === 'function') instance.end();
        } catch (endError) {
          log(`Błąd wymuszonego rozłączenia: ${endError.message || endError}`);
        }
        finish();
      }
    }).finally(() => {
      stopPromise = null;
    });

    return stopPromise;
  }

  return { start, stop, getStatus };
}

module.exports = { createBotController };
