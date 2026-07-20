# Model danych MySQL

## Relacje

```text
users 1---N user_devices
users N---N rooms                 przez room_members
users N---N rooms                 przez room_pending_members do czasu Welcome
users 1---1 mls_user_profiles
user_devices 1---1 mls_device_profiles
user_devices 1---N mls_key_packages
rooms 1---1 mls_conversations
mls_conversations 1---N mls_envelopes
mls_envelopes 1---N mls_envelope_recipients
```

## Tabele aplikacyjne

`users` i `user_devices` przechowują nazwę konta, sesje, status urządzenia i publiczny klucz RSA używany wyłącznie przy bootstrapie nowego urządzenia. Token uwierzytelniający jest przechowywany jako SHA-256.

`rooms` oraz `room_members` opisują autoryzację aplikacyjną. `room_pending_members` przechowuje zaproszenie do chwili zapisania adresowanego Welcome; dopiero wtedy użytkownik zostaje aktywnym członkiem. `current_epoch` jest kopią pomocniczą najwyższej zapisanej epoki Commit, a nie sekretem kryptograficznym.

## Tabele MLS

### `mls_user_profiles`

Wiąże konto aplikacyjne ze stabilnym identyfikatorem użytkownika MLS. Raz ustawionego identyfikatora nie można zmienić przez inną sesję.

### `mls_device_profiles`

Wiąże uwierzytelnioną sesję z identyfikatorem urządzenia umieszczanym w kopertach MLS. Backend odrzuca niezgodnego nadawcę.

### `mls_key_packages`

Przechowuje publiczne KeyPackage. Pakiet zwykły jest atomowo oznaczany jako wykorzystany podczas pobrania. Pakiet last-resort może być pobierany ponownie.

### `mls_conversations`

Mapuje wewnętrzny UUID pokoju na binarny GroupId protokołu MLS.

### `mls_envelopes`

Zawiera zaszyfrowane lub publiczne komunikaty protokołu: `Application`, `Commit`, `Welcome`, `Proposal` i `KeyPackage`. Payload jest nieprzezroczysty dla backendu. Indeksy wymuszają kolejność i deduplikację.

### `mls_envelope_recipients`

Adresuje Welcome do konkretnych urządzeń i przechowuje potwierdzenie odbioru. Welcome pozostaje dostępny do ACK.

### `mls_message_reads`

Potwierdzenia odczytu są metadanymi aplikacyjnymi. Nie zawierają treści wiadomości, ale ujawniają serwerowi aktywność użytkowników.

### `mls_device_link_secrets`

Tymczasowo przechowuje zaszyfrowany eksport tożsamości konta przekazywany zatwierdzonemu urządzeniu.

## Migracje

Backend wykonuje idempotentne `CREATE TABLE IF NOT EXISTS`. Plik `database/schema.sql` jest referencyjnym DDL dla świeżej instalacji. Stare tabele AES mogą pozostać w istniejącej bazie po aktualizacji, lecz kod ich nie odczytuje. Automatyczna migracja ciphertextów i kluczy AES do MLS nie istnieje.
