-- ════════════════════════════════════════════════════════════════════
-- 005 — HOTFIX VINCOLI (eseguiti in produzione l'11/06/2026)
-- Due vincoli CHECK storici non prevedevano valori che l'app usa da
-- sempre: gli inserimenti fallivano in silenzio (registro azioni mai
-- scritto, presenze Lab mai registrate) e, con le funzioni server,
-- bloccavano +XP manuale e check-in Lab. Idempotente.
-- ════════════════════════════════════════════════════════════════════

-- Hotfix 1: tipi di notifica usati dall'app ma non previsti dal vincolo
ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check
CHECK (type = ANY (ARRAY[
  'new_activity','booking_confirmed','booking_rejected','badge_assigned',
  'level_up','week_bonus','new_message',
  'log_action','educator_msg','xp_gain'
]));

-- Hotfix 2: il check-in Lab inserisce check_type 'lab', non previsto
ALTER TABLE public.attendances DROP CONSTRAINT IF EXISTS attendances_check_type_check;
ALTER TABLE public.attendances ADD CONSTRAINT attendances_check_type_check
CHECK (check_type = ANY (ARRAY['daily','activity','lab']));
