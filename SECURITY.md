# Security Policy

## Status projektu

Projekt jest eksperymentalną implementacją edukacyjną. Nie przeszedł niezależnego audytu kryptograficznego i nie powinien być używany do ochrony komunikacji wysokiego ryzyka bez dodatkowego przeglądu, hardeningu infrastruktury oraz testów penetracyjnych.

## Zgłaszanie podatności

Nie publikuj podatności ani działającego exploita w publicznym issue. Użyj prywatnego zgłoszenia przez GitHub Security Advisories:

`Security` -> `Advisories` -> `Report a vulnerability`

W zgłoszeniu podaj:

- wersję lub commit,
- scenariusz ataku i wymagane uprawnienia,
- wpływ na poufność, integralność lub dostępność,
- minimalny sposób reprodukcji,
- proponowane ograniczenie ryzyka, jeśli jest znane.

Maintainerzy powinni potwierdzić odbiór w ciągu 7 dni. Termin poprawki zależy od wpływu i złożoności. Informacja publiczna powinna pojawić się dopiero po udostępnieniu poprawki użytkownikom.

## Zakres szczególnego zainteresowania

- podstawianie kluczy publicznych urządzeń,
- nieautoryzowane dołączanie do pokojów,
- ponowne użycie IV w AES-GCM,
- odzyskiwanie konta bez znajomości sekretu,
- obejście rotacji po wycofaniu urządzenia,
- XSS prowadzący do użycia klucza z IndexedDB,
- wycieki tokenów sesji lub metadanych z MySQL i logów.
