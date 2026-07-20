# Changelog

Projekt stosuje konwencję [Keep a Changelog](https://keepachangelog.com/) i wersjonowanie semantyczne.

## [Unreleased]

### Added

- grupy MLS oparte na OpenMLS/WASM,
- jednorazowe i last-resort KeyPackage dla urządzeń,
- Delivery Service przechowujący Commit, Welcome, Proposal i PrivateMessage,
- szyfrowany magazyn stanu MLS i lokalnej historii w IndexedDB,
- test dwóch izolowanych klientów przeglądarkowych.

### Changed

- zastąpiono współdzielone klucze AES pokojów protokołem MLS,
- zaproszeni użytkownicy otrzymują dostęp od nowej epoki, bez starej historii,
- backup odzyskiwania nie zawiera historycznych sekretów grup.

### Removed

- `room_device_keys`, ręczna rotacja kluczy i endpointy przekazywania kluczy,
- serwerowa ścieżka wiadomości AES-GCM.

## [1.0.0] - 2026-07-20

Pierwsza publiczna wersja projektu.
