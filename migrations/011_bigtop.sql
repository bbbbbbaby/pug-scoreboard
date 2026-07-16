-- ════════════════════════════════════════════════════════════════════
-- 011 — BIG TOP 🎪 (fondamento: tabelle + regole + funzioni server)
-- Eseguire in STAGING, testare, poi in PRODUZIONE (col pacchetto di agosto).
-- Idempotente.
--
-- Il sistema: turni fissi mar/gio 16-17 e 17-18 (modificabili), gratis,
-- prenotazione a calendario multipla (mese corrente + successivo),
-- disdetta fino alle 22:00 del giorno prima, QR presenze con punti extra,
-- walk-in ammessi se c'è posto, multa 2 coin agli assenti CONFERMATA
-- dall'educatore.
-- ════════════════════════════════════════════════════════════════════

-- ─── TABELLE ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.bigtop_slots (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date             date NOT NULL,
  start_time       time NOT NULL,
  end_time         time NOT NULL,
  max_participants integer NOT NULL DEFAULT 10,
  xp_checkin       integer NOT NULL DEFAULT 0,
  coin_checkin     integer NOT NULL DEFAULT 0,
  qr_code          text,
  cancelled_at     timestamptz,
  created_at       timestamptz DEFAULT now(),
  CONSTRAINT bigtop_slots_date_start_key UNIQUE (date, start_time)
);

CREATE TABLE IF NOT EXISTS public.bigtop_bookings (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id    uuid NOT NULL REFERENCES public.bigtop_slots(id) ON DELETE CASCADE,
  player_id  uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status     text NOT NULL DEFAULT 'booked'
             CHECK (status = ANY (ARRAY['booked','present','absent','cancelled'])),
  booked_by  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT bigtop_bookings_slot_player_key UNIQUE (slot_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_bigtop_bookings_player ON public.bigtop_bookings(player_id);
CREATE INDEX IF NOT EXISTS idx_bigtop_slots_date ON public.bigtop_slots(date);

-- Tipo di notifica dedicato
ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check
CHECK (type = ANY (ARRAY[
  'new_activity','booking_confirmed','booking_rejected','badge_assigned',
  'level_up','week_bonus','new_message','log_action','educator_msg','xp_gain','bigtop'
]));

-- ─── RLS ────────────────────────────────────────────────────────────────
ALTER TABLE public.bigtop_slots    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bigtop_bookings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bigtop_slots_select ON public.bigtop_slots;
DROP POLICY IF EXISTS bigtop_slots_write  ON public.bigtop_slots;
DROP POLICY IF EXISTS bigtop_bookings_select ON public.bigtop_bookings;
DROP POLICY IF EXISTS bigtop_bookings_write  ON public.bigtop_bookings;

CREATE POLICY bigtop_slots_select ON public.bigtop_slots FOR SELECT TO public USING (true);
CREATE POLICY bigtop_slots_write  ON public.bigtop_slots FOR ALL TO authenticated
  USING (is_educator()) WITH CHECK (is_educator());

CREATE POLICY bigtop_bookings_select ON public.bigtop_bookings FOR SELECT TO public USING (true);
CREATE POLICY bigtop_bookings_write  ON public.bigtop_bookings FOR ALL TO authenticated
  USING (is_educator()) WITH CHECK (is_educator());
-- Le azioni dei ragazzi (prenota/disdici/check-in) passano dalle funzioni sotto.

GRANT SELECT ON public.bigtop_slots, public.bigtop_bookings TO anon, authenticated;
GRANT ALL ON public.bigtop_slots, public.bigtop_bookings TO authenticated, service_role;

-- ─── FUNZIONI SERVER ────────────────────────────────────────────────────

-- 1. GENERA I TURNI DI UN MESE (educatore): tutti i mar/gio, 16-17 e 17-18
CREATE OR REPLACE FUNCTION public.bigtop_generate_month(p_year int, p_month int)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  d date;
  n int := 0;
BEGIN
  IF NOT is_educator() THEN RETURN jsonb_build_object('error','not_authorized'); END IF;
  d := make_date(p_year, p_month, 1);
  WHILE extract(month FROM d) = p_month LOOP
    IF extract(isodow FROM d) IN (2, 4) THEN  -- martedì e giovedì
      INSERT INTO bigtop_slots (date, start_time, end_time)
      VALUES (d, '16:00', '17:00') ON CONFLICT (date, start_time) DO NOTHING;
      IF FOUND THEN n := n + 1; END IF;
      INSERT INTO bigtop_slots (date, start_time, end_time)
      VALUES (d, '17:00', '18:00') ON CONFLICT (date, start_time) DO NOTHING;
      IF FOUND THEN n := n + 1; END IF;
    END IF;
    d := d + 1;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'created', n);
END $$;

-- 2. PRENOTA (ragazzo per sé, o educatore per conto suo) — anche più turni
CREATE OR REPLACE FUNCTION public.bigtop_book(p_player_id uuid, p_slot_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_today   date := (now() AT TIME ZONE 'Europe/Rome')::date;
  v_max_day date := (date_trunc('month', (now() AT TIME ZONE 'Europe/Rome')) + interval '2 months' - interval '1 day')::date;
  v_slot    record;
  v_taken   int;
  v_ok      int := 0;
  v_errs    jsonb := '[]'::jsonb;
  sid       uuid;
BEGIN
  IF NOT (is_educator() OR jwt_player_id() = p_player_id) THEN
    RETURN jsonb_build_object('error','not_authorized');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_player_id AND role='player') THEN
    RETURN jsonb_build_object('error','not_found');
  END IF;

  FOREACH sid IN ARRAY p_slot_ids LOOP
    SELECT * INTO v_slot FROM bigtop_slots WHERE id = sid;
    IF NOT FOUND OR v_slot.cancelled_at IS NOT NULL THEN
      v_errs := v_errs || jsonb_build_object('slot', sid, 'why', 'turno_non_disponibile'); CONTINUE;
    END IF;
    IF v_slot.date < v_today THEN
      v_errs := v_errs || jsonb_build_object('slot', sid, 'why', 'passato'); CONTINUE;
    END IF;
    IF v_slot.date > v_max_day THEN
      v_errs := v_errs || jsonb_build_object('slot', sid, 'why', 'troppo_in_anticipo'); CONTINUE;
    END IF;
    SELECT count(*) INTO v_taken FROM bigtop_bookings
     WHERE slot_id = sid AND status IN ('booked','present');
    IF v_taken >= v_slot.max_participants THEN
      v_errs := v_errs || jsonb_build_object('slot', sid, 'why', 'pieno'); CONTINUE;
    END IF;

    INSERT INTO bigtop_bookings (slot_id, player_id, status, booked_by)
    VALUES (sid, p_player_id, 'booked', CASE WHEN is_educator() THEN auth.uid() ELSE NULL END)
    ON CONFLICT (slot_id, player_id)
    DO UPDATE SET status = 'booked', updated_at = now()
      WHERE bigtop_bookings.status = 'cancelled';
    IF FOUND THEN v_ok := v_ok + 1;
    ELSE v_errs := v_errs || jsonb_build_object('slot', sid, 'why', 'gia_prenotato');
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'booked', v_ok, 'errors', v_errs);
END $$;

-- 3. DISDICI (fino alle 22:00 del giorno prima; l'educatore sempre)
CREATE OR REPLACE FUNCTION public.bigtop_cancel(p_player_id uuid, p_slot_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_slot     record;
  v_deadline timestamp;
  v_now      timestamp := (now() AT TIME ZONE 'Europe/Rome');
BEGIN
  IF NOT (is_educator() OR jwt_player_id() = p_player_id) THEN
    RETURN jsonb_build_object('error','not_authorized');
  END IF;
  SELECT * INTO v_slot FROM bigtop_slots WHERE id = p_slot_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','not_found'); END IF;

  v_deadline := (v_slot.date - 1) + time '22:00';
  IF NOT is_educator() AND v_now > v_deadline THEN
    RETURN jsonb_build_object('error','troppo_tardi');
  END IF;

  UPDATE bigtop_bookings SET status = 'cancelled', updated_at = now()
   WHERE slot_id = p_slot_id AND player_id = p_player_id AND status = 'booked';
  IF NOT FOUND THEN RETURN jsonb_build_object('error','nessuna_prenotazione'); END IF;
  RETURN jsonb_build_object('ok', true);
END $$;

-- 4. QR DEL TURNO (educatore): crea o restituisce il codice
CREATE OR REPLACE FUNCTION public.bigtop_generate_qr(p_slot_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_code text;
BEGIN
  IF NOT is_educator() THEN RETURN jsonb_build_object('error','not_authorized'); END IF;
  SELECT qr_code INTO v_code FROM bigtop_slots WHERE id = p_slot_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','not_found'); END IF;
  IF v_code IS NULL THEN
    v_code := upper(substr(md5(random()::text), 1, 6));
    UPDATE bigtop_slots SET qr_code = v_code WHERE id = p_slot_id;
  END IF;
  RETURN jsonb_build_object('code', v_code);
END $$;

-- 5. CHECK-IN COL CODICE (ragazzo): prenotato → presente; walk-in se c'è posto
CREATE OR REPLACE FUNCTION public.bigtop_checkin(p_player_id uuid, p_code text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_today  date := (now() AT TIME ZONE 'Europe/Rome')::date;
  v_slot   record;
  v_bk     record;
  v_taken  int;
  v_newxp  int; v_newcoin int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_player_id AND role='player') THEN
    RETURN jsonb_build_object('error','not_found');
  END IF;
  SELECT * INTO v_slot FROM bigtop_slots
   WHERE date = v_today AND upper(qr_code) = upper(trim(p_code)) AND cancelled_at IS NULL;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','invalid_code'); END IF;

  SELECT * INTO v_bk FROM bigtop_bookings WHERE slot_id = v_slot.id AND player_id = p_player_id;

  IF FOUND AND v_bk.status = 'present' THEN
    RETURN jsonb_build_object('error','already');
  ELSIF FOUND AND v_bk.status IN ('booked','cancelled','absent') THEN
    UPDATE bigtop_bookings SET status='present', updated_at=now() WHERE id = v_bk.id;
  ELSE
    -- Walk-in: non prenotato, entra se c'è posto
    SELECT count(*) INTO v_taken FROM bigtop_bookings
     WHERE slot_id = v_slot.id AND status IN ('booked','present');
    IF v_taken >= v_slot.max_participants THEN
      RETURN jsonb_build_object('error','pieno');
    END IF;
    INSERT INTO bigtop_bookings (slot_id, player_id, status) VALUES (v_slot.id, p_player_id, 'present');
  END IF;

  -- Punti del turno (se impostati)
  IF v_slot.xp_checkin <> 0 OR v_slot.coin_checkin <> 0 THEN
    UPDATE profiles SET xp = xp + v_slot.xp_checkin, coin = coin + v_slot.coin_checkin
     WHERE id = p_player_id RETURNING xp, coin INTO v_newxp, v_newcoin;
    IF v_slot.xp_checkin <> 0 THEN
      INSERT INTO xp_history (player_id, xp_gained, xp_total, reason)
      VALUES (p_player_id, v_slot.xp_checkin, v_newxp, 'bigtop');
    END IF;
  ELSE
    SELECT xp, coin INTO v_newxp, v_newcoin FROM profiles WHERE id = p_player_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'xp', v_slot.xp_checkin, 'coin', v_slot.coin_checkin,
                            'new_xp', v_newxp, 'new_coin', v_newcoin,
                            'slot', to_char(v_slot.start_time,'HH24:MI') || '-' || to_char(v_slot.end_time,'HH24:MI'));
END $$;

-- 6. SEGNA ASSENTI (educatore, su un turno passato): multa 2 coin + notifica
CREATE OR REPLACE FUNCTION public.bigtop_mark_absents(p_slot_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_slot record;
  r      record;
  n      int := 0;
BEGIN
  IF NOT is_educator() THEN RETURN jsonb_build_object('error','not_authorized'); END IF;
  SELECT * INTO v_slot FROM bigtop_slots WHERE id = p_slot_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','not_found'); END IF;

  FOR r IN SELECT * FROM bigtop_bookings WHERE slot_id = p_slot_id AND status = 'booked'
  LOOP
    UPDATE bigtop_bookings SET status='absent', updated_at=now() WHERE id = r.id;
    UPDATE profiles SET coin = GREATEST(coin - 2, 0) WHERE id = r.player_id;
    INSERT INTO notifications (user_id, type, title, body)
    VALUES (r.player_id, 'bigtop', '🎪 Assenza BIG TOP',
            'Eri prenotato per il ' || to_char(v_slot.date,'DD/MM') || ' ' ||
            to_char(v_slot.start_time,'HH24:MI') || ' e non hai fatto il check-in: −2 🪙');
    n := n + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'absents', n);
END $$;

-- 7. CANCELLA UN TURNO (educatore): avvisa gli iscritti
CREATE OR REPLACE FUNCTION public.bigtop_cancel_slot(p_slot_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_slot record;
  r      record;
  n      int := 0;
BEGIN
  IF NOT is_educator() THEN RETURN jsonb_build_object('error','not_authorized'); END IF;
  SELECT * INTO v_slot FROM bigtop_slots WHERE id = p_slot_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','not_found'); END IF;

  UPDATE bigtop_slots SET cancelled_at = now() WHERE id = p_slot_id;
  FOR r IN SELECT * FROM bigtop_bookings WHERE slot_id = p_slot_id AND status = 'booked'
  LOOP
    UPDATE bigtop_bookings SET status='cancelled', updated_at=now() WHERE id = r.id;
    INSERT INTO notifications (user_id, type, title, body)
    VALUES (r.player_id, 'bigtop', '🎪 Turno annullato',
            'Il turno BIG TOP del ' || to_char(v_slot.date,'DD/MM') || ' ' ||
            to_char(v_slot.start_time,'HH24:MI') || ' è stato annullato.');
    n := n + 1;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'notified', n);
END $$;

-- ─── PERMESSI FUNZIONI ──────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.bigtop_generate_month(int,int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bigtop_book(uuid,uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bigtop_cancel(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bigtop_generate_qr(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bigtop_checkin(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bigtop_mark_absents(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bigtop_cancel_slot(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bigtop_generate_month(int,int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bigtop_book(uuid,uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bigtop_cancel(uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bigtop_generate_qr(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bigtop_checkin(uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bigtop_mark_absents(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bigtop_cancel_slot(uuid) TO authenticated;

-- ─── VERIFICA (facoltativa) ─────────────────────────────────────────────
-- SELECT proname FROM pg_proc WHERE proname LIKE 'bigtop%' ORDER BY proname;
-- Atteso: 7 funzioni.
