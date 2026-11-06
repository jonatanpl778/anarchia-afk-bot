require('dotenv').config();
const mineflayer = require('mineflayer');

const SERVER_HOST = 'anarchia.gg';
const SERVER_PORT = 25565;

function createBotController(options = {}) {
  const onLog = options.onLog || (() => {});
  const onStateChange = options.onStateChange || (() => {});
  const onSpawn = options.onSpawn || (() => {});
  const onVerification = options.onVerification || (() => {});
  const onEnd = options.onEnd || (() => {});

  let bot = null;
  let state = 'offline';
  let loggedIn = false;
  let spawned = false;
  let loginSent = false;
  let islandSent = false;
  let verificationRequired = false;
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
    return { state, online: state === 'online', verificationRequired };
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
    verificationRequired = false;

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
      // Anarchia wysyła paczkę przez surowy pakiet protokołu.
      // Nie używamy acceptResourcePack(), bo w części wersji Mineflayer
      // odpowiedź może zawierać nieprawidłowe UUID paczki.
      const sendPackStatus = (packet, modern) => {
        if (bot !== instance) return;

        try {
          if (modern) {
            const uuid = typeof packet?.uuid === 'string'
              ? packet.uuid
              : (packet?.uuid?.toString?.() || '');

            if (!uuid) {
              log('Żądanie paczki nie zawiera poprawnego UUID.');
              return;
            }

            log(`Serwer wysłał paczkę zasobów (UUID: ${uuid}).`);
            instance._client.write('resource_pack_receive', {
              uuid,
              result: 3
            });
            log('Wysłano odpowiedź ACCEPTED (3) dla paczki zasobów.');

            setTimeout(() => {
              if (bot !== instance) return;
              try {
                instance._client.write('resource_pack_receive', {
                  uuid,
                  result: 0
                });
                log('Wysłano odpowiedź SUCCESSFULLY_LOADED (0) dla paczki zasobów.');
              } catch (error) {
                log(`Błąd potwierdzenia załadowania paczki: ${error.message || error}`);
              }
            }, 1000);
          } else {
            const hash = packet?.hash;
            if (typeof hash !== 'string') {
              log('Starsze żądanie paczki nie zawiera poprawnego hash.');
              return;
            }

            log('Serwer wysłał starsze żądanie paczki zasobów.');
            instance._client.write('resource_pack_receive', {
              hash,
              result: 3
            });
            log('Wysłano odpowiedź ACCEPTED (3) dla starszej paczki.');

            setTimeout(() => {
              if (bot !== instance) return;
              try {
                instance._client.write('resource_pack_receive', {
                  hash,
                  result: 0
                });
                log('Wysłano odpowiedź SUCCESSFULLY_LOADED (0) dla starszej paczki.');
              } catch (error) {
                log(`Błąd potwierdzenia starszej paczki: ${error.message || error}`);
              }
            }, 1000);
          }
        } catch (error) {
          log(`Nie udało się odpowiedzieć na żądanie paczki: ${error.message || error}`);
        }
      };

      instance._client.on('add_resource_pack', packet => {
        sendPackStatus(packet, true);
      });

      instance._client.on('resource_pack_send', packet => {
        sendPackStatus(packet, false);
      });

      // Nowsze serwery mogą wymagać potwierdzenia listy znanych paczek.
      instance._client.on('select_known_packs', packet => {
        if (bot !== instance) return;
        try {
          const packs = Array.isArray(packet?.packs) ? packet.packs : [];
          instance._client.write('select_known_packs', { packs });
          log(`Potwierdzono listę znanych paczek (${packs.length}).`);
        } catch (error) {
          log(`Błąd potwierdzania znanych paczek: ${error.message || error}`);
        }
      });
    } catch (error) {
      const message = error.message || String(error);
      setState('error', message);
      log(`Błąd tworzenia bota: ${message}`);
      return Promise.resolve({ ok: false, message });
    }

    // Awaryjna obsługa komunikatów komponentowych. Niektóre serwery
    // wysyłają prompt logowania jako chat component zamiast messagestr.
    instance.on('message', component => {
      if (bot !== instance || loginSent || loggedIn || state === 'stopping') return;

      const text = String(component?.toString?.() || component || '').trim();
      if (!text) return;

      const loginPrompt =
        /\/login\b|\/l\b|zaloguj(?: się| sie)?|komendą\s+\/login|komenda\s+\/login|wpisz (?:swoje )?hasło|wpisz (?:swoje )?haslo|podaj (?:swoje )?hasło|podaj (?:swoje )?haslo|enter password|please log ?in|password:/i.test(text);

      if (!loginPrompt) return;

      log('Wykryto prośbę o logowanie (zdarzenie message).');

      if (!process.env.BOT_PASSWORD) {
        const message = 'Serwer wymaga logowania, ale brakuje BOT_PASSWORD.';
        log(message);
        setState('error', 'Brak hasła BOT_PASSWORD.');
        return;
      }

      loginSent = true;
      log('Wysyłanie komendy logowania za 1,5 sekundy...');

      loginTimer = setTimeout(() => {
        if (bot !== instance || state === 'stopping' || loggedIn) return;

        try {
          instance.chat('/login ' + process.env.BOT_PASSWORD);
          log('Wysłano komendę logowania (/login).');
        } catch (error) {
          loginSent = false;
          log(`Błąd wysyłania logowania: ${error.message || error}`);
          setState('error', 'Nie udało się wysłać logowania.');
        }
      }, 1500);
    });

    // Odbieranie czytelnego tekstu z serwera (bez surowego JSON-a).
    instance.on('messagestr', message => {
      if (bot !== instance) return;

      const text = String(message || '').trim();
      if (!text) return;

      const lower = text.toLowerCase();
      log(`SERWER: ${text}`);

      // Wykrywamy prośbę o ręczną weryfikację i pokazujemy ją w panelu.
      // Nie wykonujemy za użytkownika żadnych ruchów ani odpowiedzi.
      if (!verificationRequired && /weryfikacja pozycji|verification position/i.test(text)) {
        verificationRequired = true;
        log('Wykryto weryfikację pozycji — wymagane jest ręczne działanie użytkownika.');
        try {
          onVerification(text);
        } catch (error) {
          log(`Błąd powiadomienia o weryfikacji: ${error.message || error}`);
        }
      }

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
      verificationRequired = false;

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
