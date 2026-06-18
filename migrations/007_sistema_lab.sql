-- ════════════════════════════════════════════════════════════════════
-- 007 — SISTEMA LAB: moltiplicatore, QR server-side, completamento auto
-- Eseguire in STAGING, testare, poi in PRODUZIONE. Idempotente.
--
-- 1. generate_lab_qr  → l'educatore genera il QR del lab (RISOLVE il bug
--    di venerdì: la generazione era bloccata dalle revoche su anon)
-- 2. do_checkin riscritta → alla presenza dà i valori del lab; quando il
--    ragazzo ha segnato TUTTI gli appuntamenti, scatta il bonus
--    completamento ×moltiplicatore (su XP e Coin).
--
-- Modello dati (riusa colonne esistenti su activities):
--   duration_days  = numero di appuntamenti del lab
--   xp_partial     = XP per singola presenza
--   coin_partial   = Coin per singola presenza
--   lab_multiplier = moltiplicatore di completamento (config di sistema, globale)
-- ════════════════════════════════════════════════════════════════════


-- ─── 1. generate_lab_qr: QR del giorno per un lab (solo educatori) ──────
CREATE OR REPLACE FUNCTION public.generate_lab_qr(p_activity_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Europe/Rome')::date;
  v_code  text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  -- Se esiste già il QR di oggi per questo lab, restituiscilo
  SELECT code INTO v_code FROM lab_qr
   WHERE activity_id = p_activity_id AND date = v_today;
  IF FOUND THEN
    RETURN jsonb_build_object('code', v_code, 'existing', true);
  END IF;

  -- Altrimenti generane uno nuovo (6 caratteri maiuscoli)
  v_code := upper(substr(md5(random()::text), 1, 6));
  INSERT INTO lab_qr (activity_id, date, code)
  VALUES (p_activity_id, v_today, v_code)
  ON CONFLICT (activity_id, date) DO UPDATE SET code = lab_qr.code
  RETURNING code INTO v_code;

  RETURN jsonb_build_object('code', v_code, 'existing', false);
END;
$$;

REVOKE ALL ON FUNCTION public.generate_lab_qr(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.generate_lab_qr(uuid) TO authenticated;


-- ─── 2. do_checkin riscritta ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.do_checkin(p_player_id uuid, p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today    date := (now() AT TIME ZONE 'Europe/Rome')::date;
  v_code     text := upper(trim(p_code));
  v_lab      record;
  v_qr       record;
  v_att      jsonb;
  v_xp       int;
  v_coin     int;
  v_newxp    int;
  v_newcoin  int;
  v_streak   int;
  v_prev     record;
  v_mult     numeric;
  v_count    int;
  v_bonus_xp   int;
  v_bonus_coin int;
  v_completed  boolean := false;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_player_id AND role = 'player') THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  -- ════ Codice Lab? ════
  SELECT lq.activity_id, a.name,
         coalesce(a.xp_partial, 10)   AS xp_each,
         coalesce(a.coin_partial, 5)  AS coin_each,
         coalesce(a.duration_days, 1) AS appointments
    INTO v_lab
    FROM lab_qr lq JOIN activities a ON a.id = lq.activity_id
   WHERE lq.date = v_today AND upper(lq.code) = v_code;

  IF FOUND THEN
    -- Inserisci la presenza (il vincolo unique blocca i doppioni)
    BEGIN
      INSERT INTO attendances (player_id, date, check_type, status, xp_awarded, coin_awarded, qr_verified, activity_id)
      VALUES (p_player_id, v_today, 'lab', 'full', v_lab.xp_each, v_lab.coin_each, true, v_lab.activity_id);
    EXCEPTION WHEN unique_violation THEN
      RETURN jsonb_build_object('error', 'lab_already');
    END;

    -- Punti partecipazione
    UPDATE profiles SET xp = xp + v_lab.xp_each, coin = coin + v_lab.coin_each
     WHERE id = p_player_id RETURNING xp, coin INTO v_newxp, v_newcoin;
    INSERT INTO xp_history (player_id, xp_gained, xp_total, reason)
    VALUES (p_player_id, v_lab.xp_each, v_newxp, 'lab_presenza');

    -- Quante presenze ha ora questo ragazzo per QUESTO lab?
    SELECT count(*) INTO v_count FROM attendances
     WHERE player_id = p_player_id AND activity_id = v_lab.activity_id AND check_type = 'lab';

    -- Completamento? (ha segnato tutti gli appuntamenti)
    IF v_count >= v_lab.appointments THEN
      SELECT coalesce((app_config->>'lab_multiplier')::numeric, 2)
        INTO v_mult FROM profiles WHERE id = '00000000-0000-0000-0000-000000000099';

      -- Bonus = totale guadagnato dal lab × (moltiplicatore − 1),
      -- così il ragazzo arriva esattamente al ×moltiplicatore.
      v_bonus_xp   := round(v_lab.appointments * v_lab.xp_each   * (v_mult - 1));
      v_bonus_coin := round(v_lab.appointments * v_lab.coin_each * (v_mult - 1));

      IF v_bonus_xp <> 0 OR v_bonus_coin <> 0 THEN
        UPDATE profiles SET xp = xp + v_bonus_xp, coin = coin + v_bonus_coin
         WHERE id = p_player_id RETURNING xp, coin INTO v_newxp, v_newcoin;
        IF v_bonus_xp <> 0 THEN
          INSERT INTO xp_history (player_id, xp_gained, xp_total, reason)
          VALUES (p_player_id, v_bonus_xp, v_newxp, 'lab_completato');
        END IF;
        INSERT INTO notifications (user_id, type, title, body)
        VALUES (p_player_id, 'badge_assigned', '🎉 Lab completato: ' || v_lab.name || '!',
                'Bonus ×' || v_mult || ' → +' || v_bonus_xp || ' XP, +' || v_bonus_coin || ' Coin');
      END IF;
      v_completed := true;
    END IF;

    RETURN jsonb_build_object('type','lab','name',v_lab.name,
                              'xp',v_lab.xp_each,'coin',v_lab.coin_each,
                              'new_xp',v_newxp,'new_coin',v_newcoin,
                              'completed',v_completed,
                              'bonus_xp',coalesce(v_bonus_xp,0),'bonus_coin',coalesce(v_bonus_coin,0),
                              'progress',v_count,'total',v_lab.appointments);
  END IF;

  -- ════ Check-in giornaliero (invariato) ════
  SELECT * INTO v_qr FROM daily_qr WHERE date = v_today;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','no_qr'); END IF;
  IF upper(v_qr.code) <> v_code THEN RETURN jsonb_build_object('error','invalid_code'); END IF;
  IF v_qr.valid_from  IS NOT NULL AND now() < v_qr.valid_from::timestamptz  THEN RETURN jsonb_build_object('error','too_early'); END IF;
  IF v_qr.valid_until IS NOT NULL AND now() > v_qr.valid_until::timestamptz THEN RETURN jsonb_build_object('error','too_late');  END IF;

  SELECT app_config->'attendance_config' INTO v_att
    FROM profiles WHERE id = '00000000-0000-0000-0000-000000000099';
  v_xp   := coalesce((v_att->>'xp_daily_checkin')::int, 10);
  v_coin := coalesce((v_att->>'coin_daily_checkin')::int, 5);

  BEGIN
    INSERT INTO attendances (player_id, date, check_type, status, xp_awarded, coin_awarded, qr_verified)
    VALUES (p_player_id, v_today, 'daily', 'full', v_xp, v_coin, true);
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('error', 'already');
  END;

  SELECT current_streak, longest_streak, last_checkin_date INTO v_prev
    FROM profiles WHERE id = p_player_id;
  v_streak := CASE WHEN v_prev.last_checkin_date = v_today - 1
                   THEN coalesce(v_prev.current_streak, 0) + 1
                   ELSE 1 END;

  UPDATE profiles
     SET xp = xp + v_xp, coin = coin + v_coin,
         current_streak = v_streak,
         longest_streak = GREATEST(v_streak, coalesce(longest_streak, 0)),
         last_checkin_date = v_today
   WHERE id = p_player_id
   RETURNING xp, coin INTO v_newxp, v_newcoin;

  INSERT INTO xp_history (player_id, xp_gained, xp_total, reason)
  VALUES (p_player_id, v_xp, v_newxp, 'presenza_qr');

  RETURN jsonb_build_object('type','daily','xp',v_xp,'coin',v_coin,'streak',v_streak,
                            'new_xp',v_newxp,'new_coin',v_newcoin);
END;
$$;

REVOKE ALL ON FUNCTION public.do_checkin(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.do_checkin(uuid, text) TO anon, authenticated;

-- ─── VERIFICA ───────────────────────────────────────────────────────────
-- Imposta il moltiplicatore globale (se non già presente):
-- UPDATE profiles SET app_config = jsonb_set(coalesce(app_config,'{}'), '{lab_multiplier}', '2')
--  WHERE id = '00000000-0000-0000-0000-000000000099';
