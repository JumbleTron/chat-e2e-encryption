# Architektura MLS

## Granice systemu

Frontend React jest klientem MLS i jedynym miejscem, w którym powstaje plaintext. `ping-openmls-sdk` uruchamia rdzeń OpenMLS w Web Workerze. Backend Express pełni role Authentication Service oraz Delivery Service, natomiast MySQL przechowuje wyłącznie dane publiczne, metadane i zaszyfrowane koperty.

## Tożsamości

- Konto ma stabilny `mls_user_id` wynikający z eksportu tożsamości SDK.
- Każda sesja urządzenia ma osobny `mls_device_id` i credential.
- Backend wiąże `sender_device` koperty z uwierzytelnioną sesją HTTP.
- Urządzenie publikuje pulę jednorazowych KeyPackage oraz jeden pakiet last-resort.

Prywatne klucze, stan grup oraz lokalny cache wiadomości są szyfrowane AES-GCM przez nieeksportowalny klucz Web Crypto zapisany w IndexedDB.

## Utworzenie grupy

1. Inicjator tworzy `MlsGroup` w Workerze.
2. Backend zapisuje mapowanie pokoju na 16-bajtowy GroupId.
3. Klient pobiera po jednym KeyPackage aktywnych urządzeń.
4. `addMembers` generuje Commit oraz Welcome.
5. Delivery Service porządkuje koperty i adresuje Welcome.

## Wiadomości

Payload aplikacyjny zawiera identyfikator wiadomości, autora, czas i tekst. Całość jest przekazywana do `Conversation.send`, więc wszystkie pola payloadu są objęte szyfrowaniem i uwierzytelnieniem MLS. Serwer zapisuje zewnętrzną kopertę, epokę, identyfikator urządzenia i HLC potrzebne do routingu.

Po odszyfrowaniu payload jest zapisywany w lokalnym szyfrowanym cache’u. Cache zapewnia UX historii bez archiwizowania dawnych sekretów grupy na serwerze.

## Zaproszenie i usunięcie

Zaproszenie jest zmianą członkostwa `Add + Commit + Welcome`. Nowy członek rozpoczyna od nowej epoki i nie dostaje poprzedniej historii.

Wycofanie urządzenia wywołuje `revokeDevice`, które tworzy Commit dla grup znanych bieżącemu klientowi. Następnie backend unieważnia token sesji. Jeżeli Commit nie może zostać utworzony, klient nie powinien traktować samego unieważnienia tokenu jako kryptograficznego usunięcia.

## Wiele urządzeń

Podczas linkowania nowe urządzenie generuje tymczasową parę RSA-OAEP. Zatwierdzające urządzenie szyfruje do niej eksport tożsamości konta. RSA nie służy do szyfrowania wiadomości ani sekretów pokojów. Po inicjalizacji MLS nowe urządzenie publikuje KeyPackage i jest dodawane do grup jako osobny liść.

## Forward secrecy

Forward secrecy zależy od poprawnego postępu ratchetów i trwałego usuwania poprzednich sekretów przez StorageProvider. Projekt nie eksportuje sekretów grup do backupu i nie przekazuje historii nowym członkom. Post-compromise security jest uzyskiwane przez zmiany członkostwa i aktualizacje epok MLS.

## Konflikty Commit

Delivery Service dopuszcza jeden Commit dla danej grupy i epoki. Drugi zapis zwraca `409 EpochOccupied`; klient powinien zsynchronizować grupę przed ponowieniem operacji. Wszystkie koperty mają dodatkową unikalność `(conversation, sender_device, sequence, kind)`.

## Model zagrożeń

Chronione są treść i integralność wiadomości wobec serwera Delivery Service oraz późniejszego przejęcia aktualnych sekretów. Poza zakresem pozostają:

- złośliwy kod działający w originie aplikacji,
- przejęty endpoint w czasie aktywnej sesji,
- analiza metadanych,
- złośliwy Authentication Service,
- brak key transparency,
- bezpieczeństwo zależności bez niezależnego audytu.
