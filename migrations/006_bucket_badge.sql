-- ════════════════════════════════════════════════════════════════════
-- 006 — BUCKET IMMAGINI BADGE
-- Da eseguire in STAGING e poi in PRODUZIONE. Idempotente.
-- Permette il caricamento delle immagini badge direttamente dall'app
-- (anche da telefono), senza passare da GitHub.
-- ════════════════════════════════════════════════════════════════════

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('badge-images', 'badge-images', true, 1048576,
        ARRAY['image/webp','image/jpeg','image/png','image/gif'])
ON CONFLICT (id) DO UPDATE
  SET public = true,
      file_size_limit = 1048576,
      allowed_mime_types = ARRAY['image/webp','image/jpeg','image/png','image/gif'];

-- Solo educatori autenticati possono caricare
DROP POLICY IF EXISTS "badge images upload" ON storage.objects;
CREATE POLICY "badge images upload" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'badge-images');
