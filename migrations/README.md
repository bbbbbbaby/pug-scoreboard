# Migrations PUG Scoreboard

SQL eseguiti sul database, in ordine. Tutti idempotenti (rieseguibili senza danni).

| File | Cosa fa | Eseguito in produzione |
|---|---|---|
| 001_security_update.sql | PIN server-side + rate limiting, award_xp, indici | 11/06/2026 |
| 002_security_fase15.sql | check-in/badge/prenotazioni server-side, revoche anon | 11/06/2026 |
| 003_storage_foto.sql | bucket Storage per le foto dei messaggi | 11/06/2026 |
| 004_consolidamento.sql | awarded_by su xp_history, award_xp traccia l'autore | 11/06/2026 |
| 005_hotfix_vincoli.sql | vincoli notifications e attendances allargati | 11/06/2026 |

Regola: ogni nuova migration va eseguita PRIMA sullo staging, poi in produzione,
e committata qui col numero successivo.
