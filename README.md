# anarchia-afk-bot

OneBlock Controller: panel WWW do ręcznego uruchamiania i zatrzymywania bota Mineflayer na `anarchia.gg`.

## Uruchomienie

```sh
npm install
npm start
```

W środowisku hostingu skonfiguruj:

- `BOT_USERNAME` — nazwa użytkownika bota.
- `BOT_PASSWORD` — opcjonalne hasło używane przez istniejący mechanizm logowania komendą `/l` po dołączeniu.
- `CONTROLLER_SECRET` — wymagany, losowy klucz dostępu do panelu, najlepiej o długości co najmniej 32 znaków.
- `PORT` — opcjonalny port HTTP (domyślnie `3000`).

Nie wpisuj żadnych sekretów do plików repozytorium. Po otwarciu panelu wpisz `CONTROLLER_SECRET`; klucz jest przechowywany tylko w `sessionStorage` bieżącej karty. Nie udostępniaj panelu przez niezabezpieczone HTTP w publicznej sieci — używaj HTTPS/proxy TLS.

Endpointy API (w tym status i logi) wymagają nagłówka `X-Controller-Key`. Gdy `CONTROLLER_SECRET` nie jest ustawiony, API pozostaje wyłączone.

Przyciski MANUAL i AUTO pozostają widoczne, ale informują, że te tryby nie są jeszcze zaimplementowane.
