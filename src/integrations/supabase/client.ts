import { createClient } from '@supabase/supabase-js';
// `Database` here is the generated `types.ts` shape extended with tables
// from migrations not yet present in the linked schema — see
// `./database-additions.ts`. Switch back to `./types` once those rows are
// regenerated into `types.ts` and the additions file is empty.
import type { Database } from './database-additions';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY at build time");
}

// Import the supabase client like this:
// import { supabase } from "@/integrations/supabase/client";

export const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: localStorage,
    persistSession: true,
    autoRefreshToken: true,
  }
});