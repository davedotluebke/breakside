/**
 * Breakside Authentication Configuration
 * 
 * Shared configuration for Supabase authentication.
 * Used by both the landing page and the PWA.
 */

// Supabase project configuration
const BREAKSIDE_SUPABASE_URL = 'https://mfuziqztsfqaqnnxjcrr.supabase.co';
const BREAKSIDE_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1mdXppcXp0c2ZxYXFubnhqY3JyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU3NTkzMDYsImV4cCI6MjA4MTMzNTMwNn0.ofe60cGBIC82rCoynvngiNEnXIKOyhpF_utezC8KG0w';

// API base URL
const BREAKSIDE_API_BASE_URL = 'https://api.breakside.pro';

// Export for use in other modules
// Note: These are intentionally in global scope for vanilla JS modules
window.BREAKSIDE_AUTH = {
    SUPABASE_URL: BREAKSIDE_SUPABASE_URL,
    SUPABASE_ANON_KEY: BREAKSIDE_SUPABASE_ANON_KEY,
    API_BASE_URL: BREAKSIDE_API_BASE_URL,
};

