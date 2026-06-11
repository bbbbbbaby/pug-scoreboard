-- ════════════════════════════════════════════════════════════════════
-- PUG SCOREBOARD — CONSOLIDAMENTO
-- Da eseguire nel SQL Editor dopo le migration precedenti. Idempotente.
--
-- 1. xp_history.awarded_by: traccia QUALE educatore ha assegnato XP/coin
--    (risponde a "chi ha dato 50 XP a Marco martedì?")
-- 2. award_xp aggiornata per registrare l'autore (auth.uid()).
--    Stessa firma: il client non cambia.
-- ════════════════════════════════════════════════════════════════════

-- ─── 1. Colonna autore ──────────────────────────────────────────────────
ALTER TABLE public.xp_history ADD COLUMN IF NOT EXISTS awarded_by uuid;
CREATE INDEX IF NOT EXISTS idx_xp_history_awarded_by ON public.xp_history (awarded_by);

-- ─── 2. award_xp con tracciamento autore ────────────────────────────────
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
    INSERT INTO xp_history (player_id, xp_gained, xp_total, reason, awarded_by)
    VALUES (p_player_id, p_xp, v_xp, p_reason, auth.uid());
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

-- ─── VERIFICA (opzionale, dopo qualche assegnazione) ────────────────────
-- SELECT h.created_at, p.display_name AS giocatore, h.xp_gained, h.reason,
--        e.display_name AS assegnato_da
--   FROM xp_history h
--   JOIN profiles p ON p.id = h.player_id
--   LEFT JOIN profiles e ON e.id = h.awarded_by
--  ORDER BY h.created_at DESC LIMIT 20;
