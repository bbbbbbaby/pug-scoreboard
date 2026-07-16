-- ════════════════════════════════════════════════════════════════════
-- 010 — GESTIONE GIOCATORI IN SQL (sostituisce la edge function)
-- Eseguire in STAGING, testare, poi in PRODUZIONE. Idempotente.
--
-- Le tre operazioni educatore che toccano le password Auth diventano
-- funzioni SECURITY DEFINER nel database: niente più edge function,
-- niente CORS, niente deploy separati.
--   · admin_set_player_pin   → cambia/resetta il PIN (e la password Auth)
--   · admin_create_player    → crea profilo + utente Auth in un colpo
--   · admin_delete_player    → elimina profilo + utente Auth
-- Tutte riservate agli educatori (is_educator()).
-- ════════════════════════════════════════════════════════════════════

-- ─── 1. CAMBIA/RESETTA PIN ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_set_player_pin(p_player_id uuid, p_pin text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth, extensions
AS $$
DECLARE
  v_email text;
  v_pwd   text;
  v_uid   uuid;
BEGIN
  IF NOT is_educator() THEN RETURN jsonb_build_object('error','not_authorized'); END IF;
  IF p_pin !~ '^[0-9]{4}$' THEN RETURN jsonb_build_object('error','invalid_pin'); END IF;

  UPDATE profiles SET pin = p_pin, updated_at = now()
   WHERE id = p_player_id AND role = 'player';
  IF NOT FOUND THEN RETURN jsonb_build_object('error','not_found'); END IF;

  v_email := 'p-' || p_player_id || '@players.pug.local';
  v_pwd   := p_pin || '.' || p_player_id;

  -- Aggiorna la password Auth (stesso hash bcrypt usato da Supabase)
  UPDATE auth.users
     SET encrypted_password = extensions.crypt(v_pwd, extensions.gen_salt('bf')),
         updated_at = now()
   WHERE email = v_email
   RETURNING id INTO v_uid;

  -- Se l'utente Auth non esiste (giocatore mai migrato), crealo ora
  IF v_uid IS NULL THEN
    v_uid := public.create_player_auth_user(p_player_id, p_pin);
  END IF;

  RETURN jsonb_build_object('ok', true);
END $$;

-- ─── 2. HELPER INTERNO: crea l'utente Auth di un giocatore ──────────────
CREATE OR REPLACE FUNCTION public.create_player_auth_user(p_player_id uuid, p_pin text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth, extensions
AS $$
DECLARE
  v_uid   uuid := gen_random_uuid();
  v_email text := 'p-' || p_player_id || '@players.pug.local';
  v_pwd   text := coalesce(p_pin,'1234') || '.' || p_player_id;
BEGIN
  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change, email_change_token_new
  ) VALUES (
    '00000000-0000-0000-0000-000000000000', v_uid, 'authenticated', 'authenticated',
    v_email, extensions.crypt(v_pwd, extensions.gen_salt('bf')), now(),
    jsonb_build_object('provider','email','providers',jsonb_build_array('email'),
                       'player_id', p_player_id, 'role', 'player'),
    '{}'::jsonb, now(), now(), '', '', '', ''
  );
  INSERT INTO auth.identities (
    id, user_id, provider_id, identity_data, provider,
    last_sign_in_at, created_at, updated_at
  ) VALUES (
    gen_random_uuid(), v_uid, v_uid::text,
    jsonb_build_object('sub', v_uid::text, 'email', v_email, 'email_verified', true),
    'email', now(), now(), now()
  );
  RETURN v_uid;
END $$;

-- ─── 3. CREA GIOCATORE (profilo + utente Auth) ──────────────────────────
CREATE OR REPLACE FUNCTION public.admin_create_player(
  p_display_name text,
  p_first_name   text DEFAULT NULL,
  p_pin          text DEFAULT '1234',
  p_squad_id     uuid DEFAULT NULL,
  p_avatar_url   text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth, extensions
AS $$
DECLARE
  v_pid uuid := gen_random_uuid();
  v_pin text := coalesce(nullif(trim(p_pin),''), '1234');
BEGIN
  IF NOT is_educator() THEN RETURN jsonb_build_object('error','not_authorized'); END IF;
  IF v_pin !~ '^[0-9]{4}$' THEN RETURN jsonb_build_object('error','invalid_pin'); END IF;
  IF coalesce(trim(p_display_name),'') = '' THEN RETURN jsonb_build_object('error','missing_name'); END IF;

  INSERT INTO profiles (id, display_name, first_name, role, pin, squad_id, avatar_url)
  VALUES (v_pid, trim(p_display_name), nullif(trim(coalesce(p_first_name,'')),''), 'player', v_pin, p_squad_id, p_avatar_url);

  PERFORM public.create_player_auth_user(v_pid, v_pin);

  RETURN jsonb_build_object('ok', true, 'player_id', v_pid);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('error', 'duplicato: nickname o utente già esistente');
END $$;

-- ─── 4. ELIMINA GIOCATORE (profilo + utente Auth) ───────────────────────
CREATE OR REPLACE FUNCTION public.admin_delete_player(p_player_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth, extensions
AS $$
BEGIN
  IF NOT is_educator() THEN RETURN jsonb_build_object('error','not_authorized'); END IF;
  DELETE FROM auth.users WHERE email = 'p-' || p_player_id || '@players.pug.local';
  DELETE FROM profiles WHERE id = p_player_id AND role = 'player';
  RETURN jsonb_build_object('ok', true);
END $$;

-- ─── PERMESSI: solo utenti autenticati possono invocarle ────────────────
REVOKE ALL ON FUNCTION public.admin_set_player_pin(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_create_player(text, text, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_delete_player(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_player_auth_user(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_set_player_pin(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_create_player(text, text, text, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_player(uuid) TO authenticated;
-- create_player_auth_user resta interno: nessun EXECUTE ai client

-- ─── VERIFICA (facoltativa): deve elencare le 3 funzioni admin_ ─────────
-- SELECT proname FROM pg_proc WHERE proname LIKE 'admin_%player%';
