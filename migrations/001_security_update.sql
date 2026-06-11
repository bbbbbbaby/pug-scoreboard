-- ════════════════════════════════════════════════════════════════════
-- PUG SCOREBOARD — AGGIORNAMENTO SICUREZZA
-- Da eseguire nel SQL Editor di Supabase (progetto pkbahkxivoygnzwdnfci)
-- Eseguibile più volte senza danni (idempotente).
--
-- Cosa fa:
--  1. verify_pin  → il PIN viene verificato NEL database, mai inviato al browser
--                   + rate limiting: max 5 tentativi errati in 10 min per giocatore
--  2. change_pin  → cambio PIN del giocatore lato server
--  3. La colonna profiles.pin diventa invisibile/non scrivibile per la anon key
--     (gli educatori autenticati continuano a vederla e modificarla come oggi)
--  4. award_xp    → assegnazione XP/coin atomica, solo per educatori autenticati
--  5. Indici per le query più frequenti
-- ════════════════════════════════════════════════════════════════════


-- ─── 1a. Tabella tentativi PIN (per il rate limiting) ─────────────────
CREATE TABLE IF NOT EXISTS public.pin_attempts (
  id           bigserial PRIMARY KEY,
  player_id    uuid        NOT NULL,
  success      boolean     NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pin_attempts_lookup
  ON public.pin_attempts (player_id, attempted_at);

-- Inaccessibile ai client: RLS attiva senza policy + revoca dei grant.
-- Solo le funzioni SECURITY DEFINER qui sotto possono scriverci.
ALTER TABLE public.pin_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.pin_attempts FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.pin_attempts_id_seq FROM anon, authenticated;


-- ─── 1b. verify_pin: login giocatore lato server ──────────────────────
CREATE OR REPLACE FUNCTION public.verify_pin(p_player_id uuid, p_pin text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile profiles%ROWTYPE;
  v_fails   int;
  v_squad   text;
  v_out     jsonb;
BEGIN
  -- Pulizia automatica dei tentativi vecchi (tiene la tabella piccola)
  DELETE FROM pin_attempts WHERE attempted_at < now() - interval '1 day';

  -- Rate limiting: max 5 tentativi errati in 10 minuti per giocatore
  SELECT count(*) INTO v_fails
    FROM pin_attempts
   WHERE player_id = p_player_id
     AND success = false
     AND attempted_at > now() - interval '10 minutes';
  IF v_fails >= 5 THEN
    RETURN jsonb_build_object('error', 'rate_limited');
  END IF;

  SELECT * INTO v_profile FROM profiles
   WHERE id = p_player_id AND role = 'player';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  IF v_profile.pin IS DISTINCT FROM p_pin THEN
    INSERT INTO pin_attempts (player_id, success) VALUES (p_player_id, false);
    RETURN jsonb_build_object('error', 'wrong_pin');
  END IF;

  INSERT INTO pin_attempts (player_id, success) VALUES (p_player_id, true);

  SELECT name INTO v_squad FROM squads WHERE id = v_profile.squad_id;

  -- Profilo SENZA il pin + squadra nello stesso formato usato dall'app
  v_out := to_jsonb(v_profile) - 'pin';
  v_out := v_out || jsonb_build_object(
    'squads',
    CASE WHEN v_squad IS NULL THEN NULL
         ELSE jsonb_build_object('name', v_squad) END
  );

  RETURN jsonb_build_object(
    'ok', true,
    'must_change_pin', v_profile.pin = '1234',
    'profile', v_out
  );
END;
$$;

REVOKE ALL ON FUNCTION public.verify_pin(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_pin(uuid, text) TO anon, authenticated;


-- ─── 2. change_pin: primo cambio PIN del giocatore, lato server ───────
-- Consentito se: il PIN attuale è quello di default ('1234'),
-- oppure viene fornito il vecchio PIN corretto.
CREATE OR REPLACE FUNCTION public.change_pin(
  p_player_id uuid,
  p_new_pin   text,
  p_old_pin   text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cur text;
BEGIN
  IF p_new_pin !~ '^[0-9]{4}$' THEN
    RETURN jsonb_build_object('error', 'invalid_pin');
  END IF;
  IF p_new_pin = '1234' THEN
    RETURN jsonb_build_object('error', 'default_pin');
  END IF;

  SELECT pin INTO v_cur FROM profiles
   WHERE id = p_player_id AND role = 'player';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  IF v_cur <> '1234' AND (p_old_pin IS NULL OR p_old_pin IS DISTINCT FROM v_cur) THEN
    RETURN jsonb_build_object('error', 'wrong_old_pin');
  END IF;

  UPDATE profiles SET pin = p_new_pin WHERE id = p_player_id;
  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.change_pin(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.change_pin(uuid, text, text) TO anon, authenticated;


-- ─── 3. La colonna pin sparisce per la anon key ────────────────────────
-- Revoca i grant tabella-interi di anon su profiles e li ri-concede
-- colonna per colonna, ESCLUDENDO pin. Gli educatori (authenticated)
-- non vengono toccati: continuano a vedere e gestire i PIN come oggi.
-- INSERT e DELETE su profiles vengono tolti del tutto ad anon
-- (i giocatori non creano né cancellano profili — solo gli educatori).
DO $$
DECLARE
  cols text;
BEGIN
  SELECT string_agg(quote_ident(column_name), ', ')
    INTO cols
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name   = 'profiles'
     AND column_name <> 'pin';

  REVOKE SELECT, UPDATE, INSERT, DELETE ON public.profiles FROM anon;
  EXECUTE format('GRANT SELECT (%s) ON public.profiles TO anon', cols);
  EXECUTE format('GRANT UPDATE (%s) ON public.profiles TO anon', cols);
END $$;


-- ─── 4. award_xp: XP/coin atomici, solo educatori autenticati ──────────
-- Sostituisce il giro leggi→calcola→scrivi del client: niente più
-- aggiornamenti persi se due educatori premono insieme, e una sola
-- query al posto di 3-4 (update + xp_history + log).
CREATE OR REPLACE FUNCTION public.award_xp(
  p_player_id uuid,
  p_xp        int,
  p_coin      int,
  p_reason    text DEFAULT 'manuale',
  p_log_title text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_xp   int;
  v_coin int;
BEGIN
  -- Solo utenti con sessione Supabase Auth (educatori/admin)
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  UPDATE profiles
     SET xp   = GREATEST(0, xp   + p_xp),
         coin = GREATEST(0, coin + p_coin)
   WHERE id = p_player_id
   RETURNING xp, coin INTO v_xp, v_coin;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'player_not_found';
  END IF;

  IF p_xp <> 0 THEN
    INSERT INTO xp_history (player_id, xp_gained, xp_total, reason)
    VALUES (p_player_id, p_xp, v_xp, p_reason);
  END IF;

  IF p_log_title IS NOT NULL THEN
    INSERT INTO notifications (user_id, type, title, body)
    VALUES (
      p_player_id, 'log_action', p_log_title,
      concat_ws(' · ',
        CASE WHEN p_xp   <> 0 THEN '+' || p_xp   || ' XP'   END,
        CASE WHEN p_coin <> 0 THEN '+' || p_coin || ' Coin' END
      )
    );
  END IF;

  RETURN jsonb_build_object('xp', v_xp, 'coin', v_coin);
END;
$$;

REVOKE ALL ON FUNCTION public.award_xp(uuid, int, int, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.award_xp(uuid, int, int, text, text) TO authenticated;


-- ─── 5. Indici per le query più frequenti ──────────────────────────────
CREATE INDEX IF NOT EXISTS idx_xp_history_player_created ON public.xp_history (player_id, created_at);
CREATE INDEX IF NOT EXISTS idx_xp_history_created        ON public.xp_history (created_at);
CREATE INDEX IF NOT EXISTS idx_attendances_date          ON public.attendances (date);
CREATE INDEX IF NOT EXISTS idx_attendances_player_date   ON public.attendances (player_id, date);
CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON public.notifications (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_recipient        ON public.messages (recipient_id);
CREATE INDEX IF NOT EXISTS idx_bookings_status           ON public.bookings (status);
CREATE INDEX IF NOT EXISTS idx_bookings_activity         ON public.bookings (activity_id);
CREATE INDEX IF NOT EXISTS idx_push_subs_player          ON public.push_subscriptions (player_id);


-- ─── VERIFICA (opzionale, esegui dopo per controllare) ─────────────────
-- I grant di anon su profiles NON devono includere 'pin':
-- SELECT privilege_type, string_agg(column_name, ', ')
--   FROM information_schema.column_privileges
--  WHERE table_name='profiles' AND grantee='anon'
--  GROUP BY privilege_type;
--
-- Test rapido della verify_pin (sostituisci id e pin reali):
-- SELECT public.verify_pin('<player-uuid>', '0000');  -- atteso: wrong_pin
