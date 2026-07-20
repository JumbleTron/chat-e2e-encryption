# Secure Group Chat

[![CI](https://github.com/JumbleTron/chat-e2e-encryption/actions/workflows/ci.yml/badge.svg)](https://github.com/JumbleTron/chat-e2e-encryption/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Eksperymentalny czat grupowy z szyfrowaniem end-to-end, obsługą wielu urządzeń, historią zaszyfrowaną per epoka, odzyskiwaniem kluczy oraz backendem MySQL.

> **Status bezpieczeństwa:** projekt nie przeszedł niezależnego audytu kryptograficznego. Jest przeznaczony do nauki, prototypowania i dalszego hardeningu. Nie używaj go do komunikacji wysokiego ryzyka w obecnej postaci.

## Najważniejsze funkcje

- szyfrowanie wiadomości AES-256-GCM wykonywane w przeglądarce,
- osobna para RSA-OAEP i token dla każdego urządzenia,
- parowanie nowego urządzenia kodem weryfikacyjnym,
- dostęp zatwierdzonego urządzenia do zaszyfrowanej historii,
- wycofywanie urządzeń i obowiązkowa rotacja klucza pokoju,
- zapraszanie do istniejącego pokoju wraz z kluczami wszystkich epok,
- opcjonalny vault odzyskiwania chroniony losowym kluczem 256-bitowym,
- uwierzytelnione REST API i Socket.IO,
- obecność, pisanie oraz potwierdzenia odczytu,
- MySQL 8 / InnoDB z transakcjami i kluczami obcymi,
- Docker Compose, Nginx, healthchecki i CI.

## Architektura

```text
┌────────────────────────────────────────────┐
│ Przeglądarka                               │
│ React + Web Crypto + IndexedDB             │
│ plaintext i prywatny klucz pozostają tutaj │
└──────────────────────┬─────────────────────┘
                       │ HTTPS / WSS
┌──────────────────────▼─────────────────────┐
│ Nginx                                      │
│ frontend SPA + reverse proxy               │
└──────────────────────┬─────────────────────┘
                       │ HTTP / WebSocket
┌──────────────────────▼─────────────────────┐
│ Node.js + Express + Socket.IO              │
│ auth urządzeń, autoryzacja, routing         │
└──────────────────────┬─────────────────────┘
                       │ mysql2 / pool
┌──────────────────────▼─────────────────────┐
│ MySQL 8 / InnoDB                           │
│ ciphertexty, klucze opakowane, metadane    │
└────────────────────────────────────────────┘
```

Szczegółowe granice zaufania i przepływy opisuje [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Model MySQL znajduje się w [docs/DATABASE.md](docs/DATABASE.md), a referencyjny DDL w [database/schema.sql](database/schema.sql).

Zalecenia operacyjne i checklista produkcyjna są w [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Model kryptograficzny

### Urządzenie

Każde urządzenie generuje własną parę RSA-OAEP 2048/SHA-256. Klucz prywatny jest nieeksportowalnym `CryptoKey` w IndexedDB. Serwer przechowuje klucz publiczny i SHA-256 losowego tokenu sesji.

### Pokój

Pokój używa AES-256-GCM. Klucz danej epoki jest szyfrowany RSA osobno dla każdego aktywnego urządzenia i zapisywany w `room_device_keys`:

```text
(room_id, device_id, key_epoch) -> encrypted_group_key
```

Wiadomość zawiera ciphertext, losowy 96-bitowy IV oraz numer epoki. Backend nie otrzymuje plaintextu ani surowego klucza AES.

### Rotacja

Wycofanie urządzenia oznacza związane pokoje jako `rotation_required`. Backend odrzuca nowe wiadomości, dopóki klient nie utworzy kolejnej epoki dla pozostałych urządzeń. Wycofane urządzenie zachowuje wiedzę o wcześniej udostępnionych treściach, ale nie otrzymuje przyszłych kluczy.

### Odzyskiwanie

Vault zawiera historyczne klucze pokojów i niezależny sekret restore. Jest szyfrowany lokalnie AES-GCM losowym kodem odzyskiwania. Kod nie trafia na serwer. Backup jest migawką i powinien zostać odnowiony po utworzeniu pokoju lub rotacji.

## Szybki start: Docker

Wymagane są Docker Engine i Docker Compose.

```bash
cp .env.example .env
```

Zmień oba hasła MySQL w `.env`, następnie:

```bash
docker compose up -d --build
docker compose ps
```

Aplikacja będzie dostępna pod `http://localhost:8080`. Jeśli port jest zajęty, ustaw np. `APP_PORT=8081` i dopasuj `PUBLIC_ORIGIN`:

```env
APP_PORT=8081
PUBLIC_ORIGIN=http://localhost:8081
```

Logi i zatrzymanie:

```bash
docker compose logs -f
docker compose down
```

`docker compose down` nie usuwa danych. Usunięcie wolumenu MySQL wymaga jawnego `docker compose down -v` i bezpowrotnie kasuje dane serwera.

## Rozwój lokalny

Wymagany Node.js 22+.

```bash
cp .env.example .env
npm run install:all
npm run docker:infra
npm run dev
```

Override [docker-compose.dev.yml](docker-compose.dev.yml) publikuje MySQL na `3306`. Frontend Vite działa domyślnie na `5173`, a API i Socket.IO na `3001`.

Zmiana portów:

```env
MYSQL_PORT=3307
API_PORT=3002
```

Przy niestandardowym porcie MySQL ustaw również `DB_PORT` dla procesu Node. Konfigurację proxy Vite można zmienić przez `VITE_BACKEND_URL`.

## Konfiguracja

| Zmienna | Domyślna | Znaczenie |
|---|---:|---|
| `APP_PORT` | `8080` | publiczny port Nginx |
| `PUBLIC_ORIGIN` | `http://localhost:8080` | dozwolony origin CORS/Socket.IO |
| `MYSQL_DATABASE` | `message_app` | nazwa bazy |
| `MYSQL_USER` | `message_app` | użytkownik aplikacyjny |
| `MYSQL_PASSWORD` | brak bezpiecznej wartości | hasło aplikacyjne |
| `MYSQL_ROOT_PASSWORD` | brak bezpiecznej wartości | hasło administratora kontenera |
| `DB_HOST` | `127.0.0.1` | host MySQL dla backendu |
| `DB_PORT` | `3306` | port MySQL dla backendu |
| `DB_CONNECTION_LIMIT` | `10` | rozmiar puli `mysql2` |
| `JSON_BODY_LIMIT` | `2mb` | limit requestów, w tym vaultu |

Wartości `change-me-*` w Compose służą wyłącznie jako zabezpieczenie przed brakiem konfiguracji. Publiczne wdrożenie musi używać unikalnych sekretów i nie powinno publikować portu MySQL.

## Baza danych

Backend przy starcie czeka na MySQL i idempotentnie tworzy dziewięć tabel:

| Tabela | Dane |
|---|---|
| `users` | logiczne konta |
| `user_devices` | klucze publiczne, hash tokenu i status urządzeń |
| `rooms` | twórca, aktywna epoka i stan rotacji |
| `room_members` | członkostwo użytkowników |
| `room_device_keys` | opakowany AES per urządzenie i epoka |
| `messages` | ciphertext, IV, epoka i urządzenie nadawcy |
| `message_reads` | potwierdzenia odczytu |
| `device_link_requests` | krótkotrwałe parowanie |
| `recovery_backups` | zaszyfrowany vault |

Poprzednia baza SQLite nie jest automatycznie importowana. Zobacz sekcję migracji w [docs/DATABASE.md](docs/DATABASE.md).

## Testy

Kontrola składni i build klienta:

```bash
npm run check
```

Test integracyjny wymaga działającego backendu z pustą lub testową bazą:

```bash
TEST_ORIGIN=http://127.0.0.1:8080 npm run test:integration
```

Test generuje prawdziwe klucze Web Crypto, tworzy konto i pokój, wykonuje handshake WebSocket, przekazuje RSA klucz AES, zapisuje ciphertext do MySQL i odszyfrowuje odebraną wiadomość.

GitHub Actions uruchamia build oraz test integracyjny z usługą MySQL 8.4 dla każdego pull requestu do `main`.

## Endpointy

Najważniejsze grupy API:

- `POST /api/users` - rejestracja konta i pierwszego urządzenia,
- `/api/device-links` - rozpoczęcie, sprawdzenie i zatwierdzenie parowania,
- `/api/devices` - lista oraz wycofywanie urządzeń,
- `/api/rooms` - lista i tworzenie pokojów,
- `/api/rooms/:id/members` - atomowe zaproszenie z kluczami historii,
- `/api/rooms/:id/rotate-key` - nowa epoka,
- `/api/recovery-backup` i `/api/recovery-restore` - vault,
- `/api/health` - zdrowie backendu i MySQL.

Wiadomości, obecność, pisanie, historia i dystrybucja kluczy online korzystają z Socket.IO.

## Ograniczenia

- brak Double Ratchet i MLS, więc nie ma pełnej forward secrecy per wiadomość,
- brak safety numbers dla kontaktów i trwałego logu przejrzystości kluczy,
- token sesji jest przechowywany w `localStorage`,
- XSS w origin aplikacji może użyć klucza z IndexedDB i odczytać plaintext,
- obecność Socket.IO jest lokalna dla jednego procesu; skalowanie wymaga adaptera Redis,
- wygasłe żądania parowania wymagają okresowego czyszczenia,
- brak automatycznej migracji danych z wcześniejszej wersji SQLite,
- brak niezależnego audytu bezpieczeństwa.

## Roadmap

- protokół grupowy MLS albo dojrzała implementacja Signal Protocol,
- podpisy urządzeń, safety numbers i historia zmian kluczy,
- Redis adapter dla wielu replik backendu,
- rate limiting, monitoring i metryki,
- migracje wersjonowane zamiast samego `CREATE TABLE IF NOT EXISTS`,
- automatyczne odświeżanie vaultu po zmianach kluczy,
- pełne testy przeglądarkowe i testy negatywne autoryzacji.

## Open source

Zasady współpracy opisuje [CONTRIBUTING.md](CONTRIBUTING.md), prywatne zgłaszanie podatności [SECURITY.md](SECURITY.md), a zasady społeczności [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

Projekt jest udostępniany na licencji [MIT](LICENSE).
