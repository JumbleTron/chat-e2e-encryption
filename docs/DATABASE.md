# MySQL

## Wymagania

- MySQL 8.4 lub zgodny MySQL 8.x,
- silnik InnoDB,
- `utf8mb4` oraz kolacja niewrażliwa na wielkość liter dla nazw użytkowników,
- osobny użytkownik bazy z dostępem wyłącznie do schematu aplikacji.

Backend tworzy brakujące tabele idempotentnie podczas startu. Kontener MySQL tworzy samą bazę i użytkownika na podstawie zmiennych `MYSQL_*`.

## Relacje

```text
users 1---N user_devices
users N---N rooms           przez room_members
rooms 1---N messages
messages 1---N message_reads
rooms N---N user_devices    przez room_device_keys + key_epoch
users 1---0..1 recovery_backups
user_devices 1---0..1 device_link_requests
```

## Tabele

### `users`

Logiczne konto. `public_key` jest zachowane dla zgodności z pierwszym urządzeniem; operacje wielourządzeniowe korzystają z `user_devices.public_key`.

### `user_devices`

Jednostka uwierzytelniania i dystrybucji kluczy. `auth_token_hash` zawiera SHA-256 losowego tokenu, a `status` kontroluje możliwość logowania i otrzymywania nowych kluczy.

### `rooms` i `room_members`

`rooms.current_epoch` wskazuje aktywny AES. `rotation_required` blokuje wysyłanie, jeśli wycofanie urządzenia nie zostało jeszcze domknięte. `room_members` przechowuje członkostwo użytkownika, nie urządzenia.

### `room_device_keys`

Zawiera zaszyfrowaną RSA kopię AES dla konkretnego pokoju, urządzenia i epoki. Klucz główny `(room_id, device_id, key_epoch)` zapobiega duplikatom.

### `messages`

Przechowuje ciphertext AES-GCM, IV, epokę i uwierzytelnione urządzenie nadawcy. `sender_username` jest migawką nazwy używaną przy renderowaniu historii.

### `message_reads`

Jedno potwierdzenie na wiadomość i użytkownika.

### `device_link_requests`

Tymczasowy kod parowania i urządzenie `pending`. Wdrożenie produkcyjne powinno cyklicznie usuwać wygasłe rekordy.

### `recovery_backups`

Nieprzezroczysty vault E2EE. `recovery_auth_hash` służy do autoryzowania utworzenia nowego urządzenia po lokalnym odszyfrowaniu vaultu.

## Backup operacyjny

Backup MySQL chroni ciphertexty i metadane, ale sam nie wystarcza do odzyskania plaintextu. Użytkownik nadal potrzebuje swoich kluczy urządzeń albo kodu odzyskiwania.

```bash
docker compose exec -T mysql sh -c \
  'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction "$MYSQL_DATABASE"' \
  > message-app.sql
```

Odtworzenie do pustego wolumenu:

```bash
docker compose up -d mysql
docker compose exec -T mysql sh -c \
  'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"' \
  < message-app.sql
```

Regularnie testuj restore. Przechowuj dump zaszyfrowany i ogranicz dostęp, ponieważ zawiera wrażliwe metadane.

## Migracja z poprzedniego SQLite

Nowy backend nie odczytuje `server/data/chat.db`. Migracja danych nie jest automatyczna ze względu na zmianę modelu urządzeń i kluczy. Przed przełączeniem istniejącego wdrożenia należy przygotować migrację dostosowaną do wersji jego schematu, zachować identyfikatory UUID i zweryfikować liczbę rekordów oraz możliwość odszyfrowania historii na aktywnym urządzeniu.
