require('dotenv').config();
const mineflayer = require('mineflayer');

const SERVER_HOST = 'anarchia.gg';
const SERVER_PORT = 25565;

function createBotController(options = {}) {
  const onLog = options.onLog || (() => {});
  const onStateChange = options.onStateChange || (() => {});
  const onSpawn = options.onSpawn || (() => {});
  const onEnd = options.onEnd || (() => {});

  let bot = null;
  let state = 'offline';
  let loggedIn = false;
  let spawned = false;
  let loginSent = false;
  let islandSent = false;
  let stopPromise = null;
  let loginTimer = null;
  let islandTimer = null;

  function log(message) {
    try {
      onLog(String(message));
    } catch (error) {
      console.error('Błąd logowania:', error.message);
    }
  }

  function setState(nextState, message) {
    state = nextState;
    try {
      onStateChange({ state, message });
    } catch (error) {
      console.error('Błąd statusu:', error.message);
    }
  }

  function getStatus() {
    return { state, online: state === 'online' };
  }

  function clearTimers() {
    clearTimeout(loginTimer);
    clearTimeout(islandTimer);
    loginTimer = null;
    islandTimer = null;
  }

  function notifyEnd(instance) {
    try {
      onEnd(instance);
    } catch (error) {
      log(`Błąd zamykania podglądu: ${error.message}`);
    }
  }

  function sendIslandCommand(instance) {
    if (
      bot !== instance ||
      !spawned ||
      !loggedIn ||
      islandSent ||
      state === 'stopping'
    ) return;

    islandSent = true;

    try {
      instance.chat('/is');
      log('Wysłano komendę /is.');
    } catch (error) {
      islandSent = false;
      log(`Nie udało się wysłać /is: ${error.message}`);
    }
  }

  function start() {
    if (bot) {
      return Promise.resolve({
        ok: false,
        message: 'Bot jest już uruchomiony lub łączy się.'
      });
    }

    if (!process.env.BOT_USERNAME) {
      const message = 'Brak BOT_USERNAME w zmiennych środowiskowych.';
      setState('error', message);
      log(message);
      return Promise.resolve({ ok: false, message });
    }

    loggedIn = false;
    spawned = false;
    loginSent = false;
    islandSent = false;

    setState('starting', 'Łączenie z serwerem...');
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
      instance.on('resourcePack', (...details) => {
        if (bot !== instance) return;

        log('Serwer wysłał żądanie paczki zasobów.');

        try {
          if (typeof instance.acceptResourcePack !== 'function') {
            log('Ta wersja Mineflayer nie udostępnia acceptResourcePack().');
            return;
          }

          instance.acceptResourcePack();
          log('Wysłano potwierdzenie akceptacji paczki zasobów.');
        } catch (error) {
          log(`Nie udało się zaakceptować paczki zasobów: ${error.message || error}`);
        }
      });
    } catch (error) {
      const message = error.message || String(error);
      setState('error', message);
      log(`Błąd tworzenia bota: ${message}`);
      return Promise.resolve({ ok: false, message });
    }

    // Odbieranie czytelnego tekstu z serwera (bez surowego JSON-a).
    instance.on('messagestr', message => {
      if (bot !== instance) return;

      const text = String(message || '').trim();
      if (!text) return;

      const lower = text.toLowerCase();
      log(`SERWER: ${text}`);

      // Rozpoznawanie prośby o zalogowanie na serwerze.
      const loginPrompt =
        /\/login\b|\/l\b|zaloguj(?: się| sie)?|wpisz (?:swoje )?hasło|wpisz (?:swoje )?haslo|podaj (?:swoje )?hasło|podaj (?:swoje )?haslo|enter password|please log ?in|password:/i.test(lower);

      if (loginPrompt && !loginSent && !loggedIn) {
        if (!process.env.BOT_PASSWORD) {
          const message = 'Serwer wymaga logowania, ale brakuje BOT_PASSWORD.';
          log(message);
          setState('error', 'Brak hasła BOT_PASSWORD.');
          return;
        }

        loginSent = true;
        log('Wykryto prośbę o logowanie. Wysyłanie komendy za 1,5 sekundy...');

        loginTimer = setTimeout(() => {
          if (
            bot !== instance ||
            state === 'stopping' ||
            loggedIn ||
            !process.env.BOT_PASSWORD
          ) return;

          try {
            instance.chat('/l ' + process.env.BOT_PASSWORD);
            log('Wysłano komendę logowania (/l).');
          } catch (error) {
            loginSent = false;
            log(`Błąd wysyłania logowania: ${error.message}`);
            setState('error', 'Nie udało się wysłać logowania.');
          }
        }, 1500);
      }

      // Potwierdzenie udanego logowania — obsługuje typowe polskie i angielskie komunikaty.
      const loginConfirmation =
        /zalogowano|zostałeś zalogowany|zostales zalogowany|zostałaś zalogowana|zostalas zalogowana|pomyślnie zalogowano|pomyslnie zalogowano|logowanie zakończone|logowanie zakonczone|logged in|successfully logged in|login successful|already logged in/i.test(lower);

      if (loginConfirmation && !loggedIn) {
        loggedIn = true;
        clearTimeout(loginTimer);
        loginTimer = null;
        log('Serwer potwierdził zalogowanie.');

        if (spawned) {
          setState('online', 'Bot jest połączony i zalogowany.');
          islandTimer = setTimeout(
            () => sendIslandCommand(instance),
            2000
          );
        }
      }
    });

    instance.once('spawn', () => {
      if (bot !== instance) return;

      spawned = true;
      log('Postać pojawiła się w świecie.');

      try {
        onSpawn(instance);
      } catch (error) {
        log(`Błąd podglądu: ${error.message}`);
      }

      if (loggedIn) {
        setState('online', 'Bot jest połączony i zalogowany.');
        sendIslandCommand(instance);
      } else {
        setState(
          'starting',
          'Postać pojawiła się w świecie. Oczekiwanie na logowanie.'
        );
      }
    });

    instance.on('kicked', reason => {
      log(`Serwer rozłączył bota: ${
        typeof reason === 'string' ? reason : JSON.stringify(reason)
      }`);
    });

    instance.on('error', error => {
      const message = error?.message || String(error);
      log(`Błąd bota: ${message}`);

      if (bot === instance && state !== 'stopping') {
        setState('error', `Błąd połączenia: ${message}`);
      }
    });

    instance.once('end', reason => {
      log(`Połączenie zakończone: ${reason || 'brak szczegółów'}`);

      clearTimers();
      notifyEnd(instance);

      if (bot !== instance) return;

      bot = null;
      loggedIn = false;
      spawned = false;

      if (state === 'stopping') {
        setState('offline', 'Bot został rozłączony.');
      } else if (state !== 'error') {
        setState('offline', 'Bot jest rozłączony.');
      }
    });

    return Promise.resolve({
      ok: true,
      message: 'Bot rozpoczął łączenie z serwerem.'
    });
  }

  function stop() {
    if (stopPromise) {
      return Promise.resolve({
        ok: false,
        message: 'Zatrzymywanie jest już w toku.'
      });
    }

    const instance = bot;

    if (!instance) {
      if (state !== 'error') {
        setState('offline', 'Bot nie jest uruchomiony.');
      }

      return Promise.resolve({
        ok: true,
        message: 'Bot nie jest uruchomiony.'
      });
    }

    setState('stopping', 'Rozłączanie bota...');
    clearTimers();

    stopPromise = new Promise(resolve => {
      let finished = false;
      let timeout;

      const finish = () => {
        if (finished) return;
        finished = true;

        clearTimeout(timeout);
        clearTimers();
        notifyEnd(instance);

        if (bot === instance) bot = null;

        loggedIn = false;
        spawned = false;

        setState('offline', 'Bot został rozłączony.');
        log('Bot został bezpiecznie rozłączony.');

        resolve({
          ok: true,
          message: 'Bot został rozłączony.'
        });
      };

      instance.once('end', finish);

      timeout = setTimeout(() => {
        try {
          if (typeof instance.end === 'function') {
            instance.end();
          }
        } catch (error) {
          log(`Błąd rozłączania: ${error.message}`);
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
        log(`Błąd STOP: ${error.message}`);
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
