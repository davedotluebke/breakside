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

// Google OAuth web client for "Export → Google Sheets" (utils/sheetsExport.js).
// Public by design, like the anon key above. Empty = the Google Sheets option
// is hidden from the Export dialog. The client needs the Sheets API enabled,
// the drive.file scope on its consent screen, and each origin the PWA is
// served from as an authorized JavaScript origin. See ARCHITECTURE.md
// § Statistics Export.
const BREAKSIDE_GOOGLE_CLIENT_ID = '328597433158-dgpl69c1p412pvmevtauqo0n856r3v6a.apps.googleusercontent.com';

// --- ES-module export. landing/ pages do NOT load this file — they carry
// --- their own config.
export const BREAKSIDE_AUTH = {
    SUPABASE_URL: BREAKSIDE_SUPABASE_URL,
    SUPABASE_ANON_KEY: BREAKSIDE_SUPABASE_ANON_KEY,
    API_BASE_URL: BREAKSIDE_API_BASE_URL,
    GOOGLE_CLIENT_ID: BREAKSIDE_GOOGLE_CLIENT_ID,
};

// window survivor: auth namespace surface (read window-qualified by
// auth/auth.js; the window namespace is the documented auth config surface)
window.BREAKSIDE_AUTH = BREAKSIDE_AUTH;

