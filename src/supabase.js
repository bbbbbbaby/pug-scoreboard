import { createClient } from "@supabase/supabase-js";

// ─── CONFIGURAZIONE AMBIENTE ─────────────────────────────────────────
// Le chiavi vengono lette dalle variabili d'ambiente (Vercel o .env.local).
// Se non sono impostate, si usa la PRODUZIONE: così l'app continua a
// funzionare identica anche senza alcuna configurazione.
//
//   Produzione (default)  → nessuna variabile necessaria
//   Staging               → VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY
//                           impostate sul progetto Supabase di staging
// ─────────────────────────────────────────────────────────────────────

export const SUPABASE_URL =
  import.meta.env.VITE_SUPABASE_URL ||
  "https://pkbahkxivoygnzwdnfci.supabase.co";

export const SUPABASE_ANON_KEY =
  import.meta.env.VITE_SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBrYmFoa3hpdm95Z256d2RuZmNpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc5MTI2OTUsImV4cCI6MjA5MzQ4ODY5NX0.h0yAL-uCyhWsG5FKV-8t2WmSxMZQR-DcdTNWwzgoOUI";

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
