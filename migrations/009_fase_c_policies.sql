-- ════════════════════════════════════════════════════════════════════
-- 009 — MIGRAZIONE AUTH, FASE C: LE REGOLE DEFINITIVE
-- Eseguire in STAGING, testare a fondo, poi in PRODUZIONE.
-- Va pubblicata INSIEME ad App9_08 (l'app adatta i flussi educatore).
--
-- Chiude in un colpo solo:
--  · xp/coin/streak non più scrivibili da console (né anon né player)
--  · impersonificazione su reazioni/notifiche/push (ognuno solo per sé)
--  · PIN illeggibili anche dai giocatori autenticati (solo educatori, via RPC)
--  · codici QR illeggibili anche dai giocatori autenticati
--
-- Le funzioni server (verify_pin, do_checkin, award_xp, ...) sono
-- SECURITY DEFINER: bypassano queste regole e continuano a funzionare.
-- ════════════════════════════════════════════════════════════════════

-- ─── 1. HELPER ──────────────────────────────────────────────────────────

-- L'identità firmata del giocatore, letta dal JWT (non falsificabile)
CREATE OR REPLACE FUNCTION public.jwt_player_id()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(auth.jwt()->'app_metadata'->>'player_id','')::uuid
$$;

-- Vero se chi chiama è un educatore/admin autenticato
CREATE OR REPLACE FUNCTION public.is_educator()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('educator','admin'))
$$;

-- ─── 2. GUARDIA COLONNE SENSIBILI SUI PROFILI ───────────────────────────
-- Un giocatore può aggiornare il proprio profilo (nome, avatar, obiettivo)
-- ma le colonne di gioco vengono CONGELATE se a scrivere non è un
-- educatore né una funzione server. Silenzioso: il resto passa.
CREATE OR REPLACE FUNCTION public.guard_profile_columns()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF current_user IN ('anon','authenticated') AND NOT is_educator() THEN
    NEW.xp                := OLD.xp;
    NEW.coin              := OLD.coin;
    NEW.current_streak    := OLD.current_streak;
    NEW.longest_streak    := OLD.longest_streak;
    NEW.last_checkin_date := OLD.last_checkin_date;
    NEW.pin               := OLD.pin;
    NEW.role              := OLD.role;
    NEW.squad_id          := OLD.squad_id;
    NEW.level_id          := OLD.level_id;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_profile_columns ON public.profiles;
CREATE TRIGGER trg_guard_profile_columns
BEFORE UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.guard_profile_columns();

-- ─── 3. PIN INVISIBILE ANCHE AGLI AUTENTICATI ───────────────────────────
-- I giocatori ora sono 'authenticated': senza questo, potrebbero leggere
-- i PIN altrui. Colonne esplicite: tutte tranne pin.
REVOKE SELECT ON public.profiles FROM authenticated;
GRANT SELECT (id, display_name, role, avatar_url, squad_id, xp, coin, level_id,
              created_at, updated_at, first_name, current_streak, longest_streak,
              last_checkin_date, app_config, xp_goal)
  ON public.profiles TO authenticated;

REVOKE UPDATE ON public.profiles FROM authenticated;
GRANT UPDATE (display_name, role, avatar_url, squad_id, xp, coin, level_id,
              updated_at, first_name, current_streak, longest_streak,
              last_checkin_date, app_config, xp_goal)
  ON public.profiles TO authenticated;
-- INSERT resta pieno (la creazione giocatori passa dalla edge function,
-- ma il grant non è un rischio: l'INSERT richiede comunque la policy educatore)

-- I PIN agli educatori: unica via, questa RPC
CREATE OR REPLACE FUNCTION public.educator_player_pins()
RETURNS TABLE(player_id uuid, pin text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_educator() THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;
  RETURN QUERY SELECT p.id, p.pin FROM profiles p WHERE p.role = 'player';
END $$;
REVOKE ALL ON FUNCTION public.educator_player_pins() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.educator_player_pins() TO authenticated;

-- ─── 4. VIA TUTTE LE VECCHIE POLICY ─────────────────────────────────────
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.policyname, r.tablename);
  END LOOP;
END $$;

-- ─── 5. LE POLICY DEFINITIVE ────────────────────────────────────────────

-- PROFILES: lista visibile (serve al login), scritture governate
CREATE POLICY profiles_select ON public.profiles FOR SELECT TO public USING (true);
CREATE POLICY profiles_update ON public.profiles FOR UPDATE TO authenticated
  USING (is_educator() OR id = jwt_player_id())
  WITH CHECK (is_educator() OR id = jwt_player_id());
CREATE POLICY profiles_insert ON public.profiles FOR INSERT TO authenticated
  WITH CHECK (is_educator());
CREATE POLICY profiles_delete ON public.profiles FOR DELETE TO authenticated
  USING (is_educator());

-- QR: solo educatori (i giocatori verificano i codici via do_checkin)
CREATE POLICY daily_qr_all ON public.daily_qr FOR ALL TO authenticated
  USING (is_educator()) WITH CHECK (is_educator());
CREATE POLICY lab_qr_all ON public.lab_qr FOR ALL TO authenticated
  USING (is_educator()) WITH CHECK (is_educator());

-- PRESENZE / STORICO XP / BADGE / PRENOTAZIONI: lettura aperta (dashboard
-- e classifiche), scrittura solo educatori — i flussi giocatore passano
-- dalle funzioni server.
CREATE POLICY attendances_select ON public.attendances FOR SELECT TO public USING (true);
CREATE POLICY attendances_write ON public.attendances FOR ALL TO authenticated
  USING (is_educator()) WITH CHECK (is_educator());

CREATE POLICY xp_history_select ON public.xp_history FOR SELECT TO public USING (true);
CREATE POLICY xp_history_write ON public.xp_history FOR ALL TO authenticated
  USING (is_educator()) WITH CHECK (is_educator());

CREATE POLICY player_badges_select ON public.player_badges FOR SELECT TO public USING (true);
CREATE POLICY player_badges_write ON public.player_badges FOR ALL TO authenticated
  USING (is_educator()) WITH CHECK (is_educator());

CREATE POLICY badges_select ON public.badges FOR SELECT TO public USING (true);
CREATE POLICY badges_write ON public.badges FOR ALL TO authenticated
  USING (is_educator()) WITH CHECK (is_educator());

CREATE POLICY bookings_select ON public.bookings FOR SELECT TO public USING (true);
CREATE POLICY bookings_write ON public.bookings FOR ALL TO authenticated
  USING (is_educator()) WITH CHECK (is_educator());

-- MESSAGGI: l'educatore invia; ognuno firma col proprio nome
CREATE POLICY messages_select ON public.messages FOR SELECT TO public USING (true);
CREATE POLICY messages_insert ON public.messages FOR INSERT TO authenticated
  WITH CHECK (is_educator() OR sender_id = jwt_player_id());
CREATE POLICY messages_update ON public.messages FOR UPDATE TO authenticated
  USING (is_educator() OR sender_id = jwt_player_id() OR recipient_id = jwt_player_id());
CREATE POLICY messages_delete ON public.messages FOR DELETE TO authenticated
  USING (is_educator());

-- NOTIFICHE: si creano per sé (level-up) o da educatore; si segnano
-- lette solo le proprie
CREATE POLICY notifications_select ON public.notifications FOR SELECT TO public USING (true);
CREATE POLICY notifications_insert ON public.notifications FOR INSERT TO authenticated
  WITH CHECK (is_educator() OR user_id = jwt_player_id());
CREATE POLICY notifications_update ON public.notifications FOR UPDATE TO authenticated
  USING (is_educator() OR user_id = jwt_player_id());
CREATE POLICY notifications_delete ON public.notifications FOR DELETE TO authenticated
  USING (is_educator() OR user_id = jwt_player_id());

-- PUSH: ognuno registra solo il proprio dispositivo
CREATE POLICY push_all ON public.push_subscriptions FOR ALL TO authenticated
  USING (is_educator() OR player_id = jwt_player_id() OR player_id = auth.uid())
  WITH CHECK (is_educator() OR player_id = jwt_player_id() OR player_id = auth.uid());

-- REAZIONI: ognuno reagisce solo a nome proprio (fine dell'impersonificazione)
CREATE POLICY reactions_select ON public.reactions FOR SELECT TO public USING (true);
CREATE POLICY reactions_write ON public.reactions FOR ALL TO authenticated
  USING (is_educator() OR player_id = jwt_player_id() OR player_id = auth.uid())
  WITH CHECK (is_educator() OR player_id = jwt_player_id() OR player_id = auth.uid());

-- CATALOGHI E CONFIG: lettura aperta, scrittura educatori
CREATE POLICY squads_select ON public.squads FOR SELECT TO public USING (true);
CREATE POLICY squads_write ON public.squads FOR ALL TO authenticated
  USING (is_educator()) WITH CHECK (is_educator());

CREATE POLICY activities_select ON public.activities FOR SELECT TO public USING (true);
CREATE POLICY activities_write ON public.activities FOR ALL TO authenticated
  USING (is_educator()) WITH CHECK (is_educator());

CREATE POLICY streak_config_select ON public.streak_config FOR SELECT TO public USING (true);
CREATE POLICY streak_config_write ON public.streak_config FOR ALL TO authenticated
  USING (is_educator()) WITH CHECK (is_educator());

CREATE POLICY levels_select ON public.levels FOR SELECT TO public USING (true);
CREATE POLICY levels_write ON public.levels FOR ALL TO authenticated
  USING (is_educator()) WITH CHECK (is_educator());

CREATE POLICY config_select ON public.config FOR SELECT TO public USING (true);
CREATE POLICY config_write ON public.config FOR ALL TO authenticated
  USING (is_educator()) WITH CHECK (is_educator());

CREATE POLICY app_settings_select ON public.app_settings FOR SELECT TO public USING (true);
CREATE POLICY app_settings_write ON public.app_settings FOR ALL TO authenticated
  USING (is_educator()) WITH CHECK (is_educator());

CREATE POLICY announcements_select ON public.announcements FOR SELECT TO public USING (true);
CREATE POLICY announcements_write ON public.announcements FOR ALL TO authenticated
  USING (is_educator()) WITH CHECK (is_educator());

-- NOTE EDUCATORI: roba interna, solo loro (anche in lettura)
CREATE POLICY educator_notes_all ON public.educator_notes FOR ALL TO authenticated
  USING (is_educator()) WITH CHECK (is_educator());

-- ─── VERIFICA RAPIDA (facoltativa, dopo il Run) ─────────────────────────
-- SELECT tablename, count(*) FROM pg_policies WHERE schemaname='public'
-- GROUP BY tablename ORDER BY tablename;
