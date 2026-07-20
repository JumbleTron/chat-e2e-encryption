# Wdrożenie

## Minimalny model

`docker-compose.yml` uruchamia jedną replikę backendu, Nginx i MySQL. Publiczny jest wyłącznie port klienta. MySQL oraz Node działają w prywatnej sieci Compose.

## Przed uruchomieniem publicznym

1. Ustaw losowe, niezależne `MYSQL_PASSWORD` i `MYSQL_ROOT_PASSWORD`.
2. Ustaw `PUBLIC_ORIGIN` na dokładny origin HTTPS, bez końcowego ukośnika.
3. Umieść stos za terminatorem TLS albo rozszerz Nginx o certyfikat.
4. Nie publikuj portu MySQL i nie używaj `docker-compose.dev.yml` na serwerze.
5. Skonfiguruj zaszyfrowane backupy wolumenu i przetestuj restore.
6. Włącz centralne logi bez payloadów wiadomości, tokenów i kluczy.
7. Dodaj rate limiting na rejestrację, parowanie i restore.
8. Przeprowadź audyt aplikacji i konfiguracji hosta.

## Aktualizacja

```bash
git pull --ff-only
docker compose build --pull
docker compose up -d
docker compose ps
curl --fail https://chat.example.com/api/health
```

Backend stosuje wyłącznie idempotentne tworzenie brakujących tabel. Zmiana istniejących kolumn powinna w przyszłości korzystać z wersjonowanych migracji wykonywanych przed wdrożeniem nowego kodu.

## Skalowanie

Nie uruchamiaj wielu replik backendu bez adaptera Socket.IO i współdzielonej obecności. MySQL może być usługą zarządzaną, jeśli:

- wymusza TLS między backendem i bazą,
- konto aplikacji ma minimalne uprawnienia,
- backup i point-in-time recovery są skonfigurowane,
- region i retencja odpowiadają wymaganiom prywatności.

Aktualna konfiguracja `mysql2` nie wymusza certyfikatu CA. Dla zdalnego MySQL należy rozszerzyć konfigurację puli o `ssl` i przekazać zaufany CA jako sekret wdrożeniowy.

## Monitoring

`GET /api/health` wykonuje `SELECT 1`, więc sygnalizuje gotowość HTTP i bazy. Produkcja powinna dodatkowo monitorować:

- opóźnienie i liczbę błędów API,
- wykorzystanie puli MySQL,
- liczbę reconnectów Socket.IO,
- pokoje pozostające w `rotation_required`,
- wygasłe `device_link_requests`,
- rozmiar `messages` i `recovery_backups`,
- powodzenie backupu i okresowego testu restore.

## Incydent

Kompromitacja backendu lub MySQL wymaga rotacji tokenów urządzeń i przeglądu metadanych. Kompromitacja origin frontendu jest poważniejsza: złośliwy JavaScript może użyć kluczy Web Crypto na aktywnych urządzeniach. W takim przypadku należy zatrzymać dystrybucję, przywrócić zaufany frontend, wycofać urządzenia i obrócić klucze pokojów.
