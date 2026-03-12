import { createClient } from "@supabase/supabase-js";

const supabaseUrl = "https://fnzyowauvewigstdlfgp.supabase.co";
// ⚠️ Replace this with your anon key from:
// Supabase Dashboard → Settings → API → Project API keys → anon / public
const supabaseAnonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZuenlvd2F1dmV3aWdzdGRsZmdwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMzMjY2OTQsImV4cCI6MjA4ODkwMjY5NH0.clTiojxwg3_kHWm_tEB0zzUygDcBE0JAYLpDhr9Fqbw";

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
