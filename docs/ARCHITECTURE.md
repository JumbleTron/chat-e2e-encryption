# Architektura

## Komponenty

```text
Przeglądarka
  React + Web Crypto + IndexedDB
        | HTTPS / WSS
        v
Nginx
  statyczny frontend + reverse proxy
        | HTTP / WebSocket, sieć Docker
        v
Node.js + Express + Socket.IO
        | mysql2, pula połączeń
        v
MySQL 8 / InnoDB
```

Frontend wykonuje wszystkie operacje na plaintextach i surowych kluczach pokojów. Backend odpowiada za uwierzytelnianie urządzeń, autoryzację członkostwa, przechowywanie ciphertextów, routing zdarzeń i transakcje. MySQL nie otrzymuje plaintextu wiadomości ani prywatnych kluczy urządzeń.

## Granice zaufania

### Klient

Klient jest punktem końcowym E2EE. Prywatny klucz RSA jest generowany jako nieeksportowalny `CryptoKey` i przechowywany w IndexedDB. Surowe klucze epok pokojów są potrzebne do szyfrowania, odszyfrowywania, zapraszania i tworzenia backupu.

Kod uruchomiony w tym samym origin może używać kluczy Web Crypto. Dlatego CSP, brak skryptów zewnętrznych, ochrona przed XSS i bezpieczny proces dostaw są częścią modelu bezpieczeństwa.

### Backend

Backend ufa tokenowi urządzenia dopiero po porównaniu jego hasha z `user_devices.auth_token_hash`. Dane tożsamości przesyłane przez zdarzenia Socket.IO nie są uznawane za wiarygodne; `senderId`, `senderDeviceId` i nazwa nadawcy pochodzą z uwierzytelnionej sesji serwera.

### Baza

Wyciek MySQL ujawnia metadane: użytkowników, urządzenia, członkostwa, czas wiadomości, potwierdzenia odczytu oraz ciphertexty. Nie powinien ujawnić treści bez kompromitacji urządzenia lub kodu odzyskiwania.

## Kryptografia

| Zastosowanie | Algorytm | Parametry |
|---|---|---|
| klucz urządzenia | RSA-OAEP | 2048 bit, SHA-256 |
| klucz pokoju | AES-GCM | 256 bit |
| IV wiadomości | losowy | 96 bit |
| token urządzenia | losowy | 256 bit, hash SHA-256 na serwerze |
| vault odzyskiwania | AES-GCM | klucz odzyskiwania 256 bit |

Projekt nie implementuje Double Ratchet ani MLS. Jedna epoka AES obejmuje wiele wiadomości. Rotacja następuje przy wycofaniu urządzenia, zapewniając odcięcie od przyszłych epok, ale nie pełną forward secrecy per wiadomość.

## Cykl życia urządzenia

### Rejestracja

1. Przeglądarka generuje parę RSA i losowy token.
2. Backend tworzy `users` oraz `user_devices`.
3. Serwer zapisuje klucz publiczny i hash tokenu.
4. Prywatny `CryptoKey` pozostaje w IndexedDB.

### Parowanie

1. Nowe urządzenie generuje własne RSA i token.
2. Serwer tworzy urządzenie `pending` i kod ważny 10 minut.
3. Aktywne urządzenie porównuje kod.
4. Odszyfrowuje posiadane klucze epok i szyfruje je RSA nowego urządzenia.
5. Backend aktywuje urządzenie po zapisaniu kopii kluczy.

### Wycofanie

1. Aktywne urządzenie oznacza inne urządzenie jako `revoked`.
2. Wszystkie dotknięte pokoje otrzymują `rotation_required`.
3. Wysyłanie jest blokowane do zakończenia rotacji.
4. Klient tworzy nowy AES i kopie dla pozostałych aktywnych urządzeń.
5. Transakcja zwiększa `current_epoch` i odblokowuje pokój.

## Pokój i historia

Wiadomość wskazuje `key_epoch`. Klient przechowuje lokalny zestaw kluczy epok i wybiera odpowiedni podczas odszyfrowania historii. Zaproszenie do istniejącego pokoju jest transakcją obejmującą członkostwo oraz kopię każdego historycznego klucza dla każdego urządzenia zaproszonej osoby.

## Odzyskiwanie

Vault zawiera surowe klucze epok i losowy sekret autoryzujący restore. Jest lokalnie szyfrowany losowym kodem odzyskiwania. MySQL przechowuje ciphertext, IV oraz hash niezależnego sekretu. Kod odzyskiwania nie trafia na backend.

Backup jest migawką. Po zmianie kluczy trzeba utworzyć nową kopię; zastępuje ona poprzednią.

## Obecność

Obecność i mapowanie socketów są w pamięci procesu Node.js. Uruchomienie wielu replik backendu wymaga adaptera Socket.IO opartego np. na Redisie oraz współdzielonego mechanizmu obecności.
