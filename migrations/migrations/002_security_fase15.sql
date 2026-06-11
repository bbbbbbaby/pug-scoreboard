-- ════════════════════════════════════════════════════════════════════
-- PUG SCOREBOARD — SICUREZZA FASE 1.5
-- Da eseguire nel SQL Editor di Supabase DOPO pug_security_update.sql.
-- Eseguibile più volte senza danni (idempotente).
--
-- Obiettivo: nessuno può più scriversi XP/coin/streak da console.
-- Le tre azioni di gioco che li toccano (check-in QR, badge mensile,
-- prenotazione Lab) diventano funzioni server-side che calcolano tutto
-- nel database; al client arriva solo l'esito. In più i codici QR del
-- giorno non sono più leggibili dalla anon key.
-- ════════════════════════════════════════════════════════════════════


-- ─── 1. do_checkin: check-in QR (giornaliero e Lab) lato server ────────
-- Valida il codice, la finestra oraria e i doppioni; legge XP/coin dalla
-- config; calcola lo streak; aggiorna profilo e xp_history in un'unica
-- transazione atomica.
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
BEGIN
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_player_id AND role = 'player') THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  -- ── Codice Lab? ──
  SELECT lq.activity_id, a.name, coalesce(a.xp_full, 20) AS xp, coalesce(a.coin_full, 10) AS coin
    INTO v_lab
    FROM lab_qr lq JOIN activities a ON a.id = lq.activity_id
   WHERE lq.date::date = v_today AND upper(lq.code) = v_code;

  IF FOUND THEN
    BEGIN
      INSERT INTO attendances (player_id, date, check_type, status, xp_awarded, coin_awarded, qr_verified, activity_id)
      VALUES (p_player_id, v_today, 'lab', 'full', v_lab.xp, v_lab.coin, true, v_lab.activity_id);
    EXCEPTION WHEN unique_violation THEN
      RETURN jsonb_build_object('error', 'lab_already');
    END;

    UPDATE profiles SET xp = xp + v_lab.xp, coin = coin + v_lab.coin
     WHERE id = p_player_id RETURNING xp, coin INTO v_newxp, v_newcoin;
    INSERT INTO xp_history (player_id, xp_gained, xp_total, reason)
    VALUES (p_player_id, v_lab.xp, v_newxp, 'lab_checkin');

    RETURN jsonb_build_object('type','lab','name',v_lab.name,'xp',v_lab.xp,'coin',v_lab.coin,
                              'new_xp',v_newxp,'new_coin',v_newcoin);
  END IF;

  -- ── Check-in giornaliero ──
  SELECT * INTO v_qr FROM daily_qr WHERE date::date = v_today;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','no_qr'); END IF;
  IF upper(v_qr.code) <> v_code THEN RETURN jsonb_build_object('error','invalid_code'); END IF;
  IF v_qr.valid_from  IS NOT NULL AND now() < v_qr.valid_from::timestamptz  THEN RETURN jsonb_build_object('error','too_early'); END IF;
  IF v_qr.valid_until IS NOT NULL AND now() > v_qr.valid_until::timestamptz THEN RETURN jsonb_build_object('error','too_late');  END IF;

  -- XP/coin dalla config di sistema (stessa fonte usata dagli educatori)
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

  -- Streak: ieri presente → +1, altrimenti riparte da 1
  SELECT current_streak, longest_streak, last_checkin_date INTO v_prev
    FROM profiles WHERE id = p_player_id;
  v_streak := CASE WHEN v_prev.last_checkin_date::date = v_today - 1
                   THEN coalesce(v_prev.current_streak, 0) + 1
                   ELSE 1 END;

  UPDATE profiles
     SET xp = xp + v_xp,
         coin = coin + v_coin,
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


-- ─── 2. claim_monthly_badge: badge streak mensile lato server ──────────
CREATE OR REPLACE FUNCTION public.claim_monthly_badge(p_player_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now        date := (now() AT TIME ZONE 'Europe/Rome')::date;
  v_months     text[] := ARRAY['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno','Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'];
  v_prev_month int;
  v_prev_year  int;
  v_cfg        record;
  v_badge_name text;
  v_start      date;
  v_presences  int;
  v_badge_id   uuid;
  v_newxp      int;
  v_newcoin    int;
BEGIN
  -- Solo nei primi 5 giorni del mese (stessa regola del client)
  IF extract(day FROM v_now) > 5 THEN
    RETURN jsonb_build_object('skip', 'window');
  END IF;

  v_prev_month := CASE WHEN extract(month FROM v_now) = 1 THEN 12 ELSE extract(month FROM v_now)::int - 1 END;
  v_prev_year  := CASE WHEN extract(month FROM v_now) = 1 THEN extract(year FROM v_now)::int - 1 ELSE extract(year FROM v_now)::int END;

  SELECT * INTO v_cfg FROM streak_config WHERE month = v_prev_month AND year = v_prev_year;
  IF NOT FOUND THEN RETURN jsonb_build_object('skip','no_config'); END IF;

  v_badge_name := coalesce(v_cfg.badge_name, v_months[v_prev_month] || ' ' || v_prev_year);

  -- Ha già il badge?
  IF EXISTS (SELECT 1 FROM player_badges pb JOIN badges b ON b.id = pb.badge_id
              WHERE pb.player_id = p_player_id AND b.name = v_badge_name) THEN
    RETURN jsonb_build_object('skip','already');
  END IF;

  -- Presenze sufficienti nel mese?
  v_start := make_date(v_prev_year, v_prev_month, 1);
  SELECT count(*) INTO v_presences FROM attendances
   WHERE player_id = p_player_id
     AND date::date >= v_start
     AND date::date <  v_start + interval '1 month'
     AND status <> 'none';
  IF v_presences < v_cfg.min_days THEN RETURN jsonb_build_object('skip','not_enough'); END IF;

  -- Badge (creato se non esiste)
  SELECT id INTO v_badge_id FROM badges WHERE name = v_badge_name;
  IF NOT FOUND THEN
    INSERT INTO badges (name, description, xp_default, coin_default)
    VALUES (v_badge_name, 'Presente almeno ' || v_cfg.min_days || ' giorni in ' || v_badge_name || '!',
            v_cfg.xp_reward, v_cfg.coin_reward)
    RETURNING id INTO v_badge_id;
  END IF;

  INSERT INTO player_badges (player_id, badge_id, xp_awarded, coin_awarded)
  VALUES (p_player_id, v_badge_id, v_cfg.xp_reward, v_cfg.coin_reward);

  UPDATE profiles SET xp = xp + v_cfg.xp_reward, coin = coin + v_cfg.coin_reward
   WHERE id = p_player_id RETURNING xp, coin INTO v_newxp, v_newcoin;

  IF v_cfg.xp_reward > 0 THEN
    INSERT INTO xp_history (player_id, xp_gained, xp_total, reason)
    VALUES (p_player_id, v_cfg.xp_reward, v_newxp, 'streak_mensile');
  END IF;

  INSERT INTO notifications (user_id, type, title, body)
  VALUES (p_player_id, 'badge_assigned', '🏅 Badge ' || v_badge_name || ' sbloccato!',
          '+' || v_cfg.xp_reward || ' XP · +' || v_cfg.coin_reward || ' Coin');

  RETURN jsonb_build_object('ok', true, 'badge_name', v_badge_name,
                            'xp', v_cfg.xp_reward, 'coin', v_cfg.coin_reward,
                            'new_xp', v_newxp, 'new_coin', v_newcoin);
END;
$$;

REVOKE ALL ON FUNCTION public.claim_monthly_badge(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_monthly_badge(uuid) TO anon, authenticated;


-- ─── 3. book_activity: prenotazione Lab con coin verificate lato server ─
-- Il costo viene letto dalle activities (non più passato dal client) e
-- la verifica del saldo + blocco coin + creazione prenotazione avvengono
-- in un'unica transazione (niente saldi negativi, niente race).
CREATE OR REPLACE FUNCTION public.book_activity(p_player_id uuid, p_activity_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cost    int;
  v_active  boolean;
  v_newcoin int;
BEGIN
  SELECT coalesce(coin_cost, 0), coalesce(is_active, false) INTO v_cost, v_active
    FROM activities WHERE id = p_activity_id;
  IF NOT FOUND OR NOT v_active THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  IF v_cost > 0 THEN
    UPDATE profiles SET coin = coin - v_cost
     WHERE id = p_player_id AND role = 'player' AND coin >= v_cost
     RETURNING coin INTO v_newcoin;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('error', 'insufficient');
    END IF;
  ELSE
    SELECT coin INTO v_newcoin FROM profiles WHERE id = p_player_id AND role = 'player';
    IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  END IF;

  INSERT INTO bookings (player_id, activity_id, coin_held, status)
  VALUES (p_player_id, p_activity_id, v_cost, 'pending');

  RETURN jsonb_build_object('ok', true, 'coin_held', v_cost, 'new_coin', v_newcoin);
END;
$$;

REVOKE ALL ON FUNCTION public.book_activity(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.book_activity(uuid, uuid) TO anon, authenticated;


-- ─── 4. Revoche: la anon key non può più toccare i valori di gioco ──────
-- profiles: la anon key può ancora aggiornare i campi "innocui" del
-- proprio profilo (nome, avatar...), ma NON xp, coin, streak e pin.
DO $$
DECLARE
  cols text;
BEGIN
  SELECT string_agg(quote_ident(column_name), ', ')
    INTO cols
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name   = 'profiles'
     AND column_name NOT IN ('pin', 'xp', 'coin', 'current_streak', 'longest_streak', 'last_checkin_date');

  REVOKE UPDATE ON public.profiles FROM anon;
  EXECUTE format('GRANT UPDATE (%s) ON public.profiles TO anon', cols);
END $$;

-- Le tabelle dei valori di gioco si scrivono SOLO tramite le funzioni
-- qui sopra (o da educatori autenticati):
REVOKE INSERT, UPDATE, DELETE ON public.attendances   FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.xp_history    FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.player_badges FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.badges        FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.bookings      FROM anon;

-- I codici QR del giorno non sono più leggibili dalla console:
-- la validazione avviene dentro do_checkin.
REVOKE ALL ON public.daily_qr FROM anon;
REVOKE ALL ON public.lab_qr   FROM anon;


-- ─── VERIFICA (opzionale) ───────────────────────────────────────────────
-- SELECT public.do_checkin('<player-uuid>', 'XXXX');     -- atteso: invalid_code o no_qr
-- SELECT public.book_activity('<player-uuid>', '<lab-uuid>');
-- SELECT grantee, privilege_type FROM information_schema.table_privileges
--  WHERE table_name IN ('daily_qr','lab_qr','attendances') AND grantee='anon';  -- atteso: vuoto/solo select dove previsto
