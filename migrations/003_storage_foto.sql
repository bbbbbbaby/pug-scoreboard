-- ════════════════════════════════════════════════════════════════════
-- PUG SCOREBOARD — FOTO MESSAGGI SU STORAGE
-- Da eseguire nel SQL Editor di Supabase. Idempotente.
--
-- Crea il bucket "message-media" dove l'app carica automaticamente le
-- foto allegate ai messaggi (al posto del base64 dentro la tabella).
-- Gli educatori non devono fare nulla di diverso: l'upload avviene da
-- solo quando scelgono la foto, come oggi.
-- ════════════════════════════════════════════════════════════════════

-- Bucket pubblico in lettura, max 2 MB per file, solo immagini
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('message-media', 'message-media', true, 2097152,
        ARRAY['image/webp','image/jpeg','image/png','image/gif'])
ON CONFLICT (id) DO UPDATE
  SET public = true,
      file_size_limit = 2097152,
      allowed_mime_types = ARRAY['image/webp','image/jpeg','image/png','image/gif'];

-- Solo gli educatori autenticati possono caricare (i player non allegano
-- foto ai messaggi: usano gli sticker, che non passano da Storage)
DROP POLICY IF EXISTS "message media upload" ON storage.objects;
CREATE POLICY "message media upload" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'message-media');

-- ─── VERIFICA (opzionale) ──────────────────────────────────────────────
-- SELECT id, public, file_size_limit FROM storage.buckets WHERE id = 'message-media';
