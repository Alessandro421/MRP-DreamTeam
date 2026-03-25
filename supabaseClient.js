import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

function createOfflineClient(reason) {
  const error = { message: `Supabase unavailable: ${reason}` };
  const queryBuilder = {
    select: async () => ({ data: [], error }),
    upsert: async () => ({ data: null, error }),
    delete: () => ({ eq: async () => ({ data: null, error }) }),
  };

  return {
    from: () => queryBuilder,
    channel: () => ({
      on() {
        return this;
      },
      subscribe(cb) {
        cb?.("CHANNEL_ERROR");
        return this;
      },
      send: async () => ({ error }),
    }),
    removeChannel: async () => ({ error: null }),
  };
}

let supabaseClient = createOfflineClient("missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY");

if (supabaseUrl && supabaseAnonKey) {
  try {
    supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false },
    });
  } catch (err) {
    console.error("Failed to initialize Supabase client.", err);
    supabaseClient = createOfflineClient("invalid Supabase credentials");
  }
} else {
  console.warn("Supabase env vars missing; app running in offline mode.");
}

export const supabase = supabaseClient;
