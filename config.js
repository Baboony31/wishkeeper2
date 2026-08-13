// Wishkeeper — Supabase config
//
// Find these in your Supabase project: Settings → API
// SUPABASE_ANON_KEY is safe to expose in frontend code — it's a
// public key. Row Level Security (set up by schema.sql) is what
// actually keeps everyone's data private, not secrecy of this key.

const SUPABASE_URL = 'https://YOUR-PROJECT-REF.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR-ANON-PUBLIC-KEY';
