import { createClient } from '@supabase/supabase-js'
const SUPABASE_URL = 'https://pkbahkxivoygnzwdnfci.supabase.co'
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBrYmFoa3hpdm95Z256d2RuZmNpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc5MTI2OTUsImV4cCI6MjA5MzQ4ODY5NX0.h0yAL-uCyhWsG5FKV-8t2WmSxMZQR-DcdTNWwzgoOUI'
export const sb = createClient(SUPABASE_URL, SUPABASE_KEY)
