# Secure Group Chat

Eksperymentalny komunikator grupowy z szyfrowaniem end-to-end opartym na Messaging Layer Security (MLS, RFC 9420), obsługą wielu urządzeń i serwerem MySQL działającym jako Delivery Service.

> Projekt nie przeszedł niezależnego audytu kryptograficznego. Nie należy traktować go jako gotowego systemu do komunikacji wysokiego ryzyka.

## Właściwości

- grupy MLS z forward secrecy i post-compromise security,
- osobny credential i KeyPackage dla każdego urządzenia,
- zaproszenia przez `Add + Commit + Welcome`,
- brak dostępu nowego członka do wiadomości sprzed zaproszenia,
- wiadomości aplikacyjne jako MLS `PrivateMessage`,
- Worker WebAssembly oparty na OpenMLS,
- zaszyfrowany lokalny stan MLS oraz cache wiadomości w IndexedDB,
- uwierzytelnione sesje urządzeń i kontrola identyfikatora nadawcy po stronie serwera,
- MySQL 8.4, Socket.IO, React, Nginx i Docker Compose,
- test przeglądarkowy dwóch niezależnych klientów MLS.

## Szybki start

```bash
cp .env.example .env
# ustaw silne hasła w .env
docker compose up -d --build
```

Aplikacja jest domyślnie dostępna pod `http://localhost:8080`, a healthcheck pod `http://localhost:8080/api/health`.

```bash
docker compose ps
docker compose logs -f
docker compose down
```

## Architektura

```text
React
  |
  | MessagingClient -> Web Worker -> OpenMLS/WASM
  | zaszyfrowany IndexedDB
  |
Nginx :8080
  |-- /api        -> Node.js/Express
  `-- /socket.io  -> Socket.IO
                         |
                       MySQL
```

Klient jest końcem E2EE. Serwer przechowuje publiczne KeyPackage, członkostwo aplikacyjne, zaszyfrowane koperty MLS i adresowanie Welcome. Nie otrzymuje plaintextu ani sekretów grup.

Szczegóły znajdują się w [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), a opis tabel w [docs/DATABASE.md](docs/DATABASE.md).

## Przepływ MLS

1. Urządzenie inicjalizuje credential MLS i publikuje pulę jednorazowych KeyPackage.
2. Twórca pokoju tworzy lokalną grupę MLS.
3. Urządzenia uczestników są dodawane przez Commit.
4. Każde zaproszone urządzenie otrzymuje adresowany Welcome.
5. Wiadomość jest szyfrowana przez ratchet MLS i zapisywana jako nieprzezroczysta koperta.
6. Po zmianie członkostwa powstaje nowa epoka; stare sekrety są usuwane przez magazyn SDK.

Dołączający użytkownik widzi wiadomości od momentu dołączenia. Historia odszyfrowana wcześniej przez dane urządzenie jest przechowywana wyłącznie w jego szyfrowanym cache’u IndexedDB.

## Wiele urządzeń

RSA-OAEP jest używany tylko jako kanał bootstrapu podczas zatwierdzania nowego urządzenia. Istniejące urządzenie przesyła nim eksport tożsamości konta. Nowe urządzenie:

1. publikuje własny KeyPackage,
2. jest dodawane jako osobny liść do każdej grupy,
3. otrzymuje osobny Welcome,
4. nie dostaje historycznych sekretów grup.

Wycofanie urządzenia generuje Commit usuwający jego liść. Dopiero poprawnie dostarczony Commit odcina urządzenie kryptograficznie; samo unieważnienie sesji HTTP nie zastępuje operacji MLS.

## Odzyskiwanie

Kopia odzyskiwania zawiera zaszyfrowaną tożsamość konta, ale nie historyczne stany grup. To celowy wybór na rzecz forward secrecy. Odzyskane urządzenie potrzebuje ponownego dodania do pokojów i nie odzyska wcześniejszej lokalnej historii.

## Development

Wymagania: Node.js 22+, Docker i Docker Compose.

```bash
npm run install:all
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d mysql
npm run dev
```

Frontend działa domyślnie na `http://localhost:5173`, backend na `http://localhost:3001`, a deweloperski MySQL na `localhost:3306`.

## Testy

```bash
npm run check
npm run test:integration
TEST_ORIGIN=http://127.0.0.1:8080 npm run test:mls
```

`test:integration` sprawdza kontrakt Delivery Service, MySQL, routing Welcome i powiązanie nadawcy z uwierzytelnionym urządzeniem. `test:mls` uruchamia dwa izolowane konteksty Chrome i wykonuje prawdziwy przepływ OpenMLS: utworzenie grupy, Commit, Welcome oraz PrivateMessage.

## Najważniejsze tabele

| Tabela | Rola |
| --- | --- |
| `users`, `user_devices` | konto, sesje i status urządzeń |
| `room_members`, `room_pending_members` | aktywne członkostwo i zaproszenia oczekujące na Welcome |
| `mls_user_profiles` | powiązanie konta z credentialem MLS |
| `mls_device_profiles` | powiązanie sesji z urządzeniem MLS |
| `mls_key_packages` | jednorazowe i last-resort KeyPackage |
| `mls_conversations` | mapowanie pokoju na GroupId MLS |
| `mls_envelopes` | Commit, Welcome, Proposal i PrivateMessage |
| `mls_envelope_recipients` | adresowanie oraz ACK dla Welcome |
| `mls_message_reads` | metadane potwierdzeń odczytu |

Pełny DDL: [database/schema.sql](database/schema.sql).

## Konfiguracja

| Zmienna | Domyślna wartość | Znaczenie |
| --- | --- | --- |
| `APP_PORT` | `8080` | publiczny port Nginx |
| `PUBLIC_ORIGIN` | `http://localhost:8080` | dozwolony origin klienta |
| `PORT` | `3001` | port backendu w kontenerze |
| `MYSQL_DATABASE` | `message_app` | baza MySQL |
| `MYSQL_USER` | `message_app` | użytkownik aplikacyjny |
| `MYSQL_PASSWORD` | wymagane produkcyjnie | hasło użytkownika |
| `MYSQL_ROOT_PASSWORD` | wymagane produkcyjnie | hasło administratora |
| `DB_CONNECTION_LIMIT` | `10` | limit połączeń backendu |
| `JSON_BODY_LIMIT` | `2mb` | maksymalna koperta API |

## Model zaufania i ograniczenia

- Serwer widzi konta, urządzenia, członkostwo, czas, wielkość i kierunek ruchu.
- Authentication Service jest zaufany w zakresie mapowania credentialu MLS do konta.
- XSS działający w originie aplikacji może korzystać z aktywnego klienta i odszyfrować bieżące dane.
- Szyfrowanie IndexedDB chroni dane spoczynkowe, ale nie zastępuje bezpiecznego systemu operacyjnego.
- Wrapper `ping-openmls-sdk` jest zależnością eksperymentalną opartą na OpenMLS i wymaga osobnego audytu przed produkcją.
- Migracja starych pokojów AES nie jest automatyczna; należy utworzyć nowe pokoje MLS.
- Serwer nie zapewnia ukrywania metadanych ani key transparency.

## Open source

Projekt jest udostępniony na licencji [MIT](LICENSE). Licencje kluczowych zależności opisuje [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Zgłoszenia i pull requesty opisują [CONTRIBUTING.md](CONTRIBUTING.md), a prywatne zgłoszenia bezpieczeństwa [SECURITY.md](SECURITY.md).
