// Research mode turns on when the Supabase project is configured. Without it
// the app runs as before, with everything saved in the browser, which keeps
// local development key-free apart from Anthropic.
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
export const researchMode = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
