/**
 * Shared Supabase client bootstrap for the landing pages.
 *
 * Classic script — landing/ is intentionally not part of the ES-module
 * graph (see ARCHITECTURE.md § Module Loading). Load AFTER the supabase-js
 * CDN script and BEFORE landing.js / join.js; the `supabaseClient` binding
 * below is shared with them via the global lexical scope.
 *
 * Pass a no-op lock function to disable the Navigator Locks API. Without
 * this, Supabase tries to acquire an exclusive cross-tab lock on
 * "lock:sb-<project-ref>-auth-token" and fails immediately with
 * "Acquiring an exclusive Navigator LockManager lock ... immediately
 * failed" when another tab is open with the app — exactly the scenario
 * multi-coach testing requires. auth/auth.js applies the same fix for the
 * main app (it lives in a different execution context — ES module with
 * config from window.BREAKSIDE_AUTH — so it keeps its own copy).
 */
const SUPABASE_URL = 'https://mfuziqztsfqaqnnxjcrr.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1mdXppcXp0c2ZxYXFubnhqY3JyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU3NTkzMDYsImV4cCI6MjA4MTMzNTMwNn0.ofe60cGBIC82rCoynvngiNEnXIKOyhpF_utezC8KG0w';

const noOpLock = async (name, acquireTimeout, fn) => fn();
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { lock: noOpLock }
});
