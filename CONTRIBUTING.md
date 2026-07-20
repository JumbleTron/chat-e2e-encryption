# Contributing

Dziękujemy za zainteresowanie projektem. Zmiany związane z kryptografią, autoryzacją i cyklem życia kluczy wymagają szczególnie dokładnego uzasadnienia oraz testów.

## Środowisko

- Node.js 22+
- Docker Engine z Docker Compose
- Git

```bash
cp .env.example .env
docker compose up -d --build
npm run check
TEST_ORIGIN=http://127.0.0.1:8080 npm run test:integration
```

## Pull request

1. Utwórz małą, tematyczną gałąź.
2. Opisz problem, rozwiązanie, kompromisy bezpieczeństwa i sposób weryfikacji.
3. Dodaj test dla zmienionego zachowania.
4. Uruchom `npm run check` i test integracyjny.
5. Nie dołączaj `.env`, baz danych, kluczy, tokenów, kopii odzyskiwania ani danych użytkowników.

## Zmiany kryptograficzne

Nie dodawaj własnych prymitywów kryptograficznych. Korzystaj z Web Crypto lub dojrzałych, audytowanych bibliotek. Pull request zmieniający format ciphertextu, sposób dystrybucji kluczy, uwierzytelnianie urządzeń albo odzyskiwanie musi zawierać:

- model zagrożeń,
- zgodność wsteczną lub plan migracji,
- przypadki awarii i odtwarzania,
- test negatywny potwierdzający odrzucanie niepoprawnych danych.

## Styl

- JavaScript ESM,
- małe funkcje i jawne granice odpowiedzialności,
- komentarze tylko tam, gdzie kod nie wyjaśnia intencji,
- tekst interfejsu w języku polskim, dopóki projekt nie otrzyma warstwy i18n.

Zgłoszenia bezpieczeństwa obsługiwane są zgodnie z [SECURITY.md](SECURITY.md), a nie w publicznych issues.
