/*
 * Google Sheets writer for export workbooks (utils/exportWorkbook.js).
 *
 * Runs entirely in the browser, with no backend involvement:
 *
 *  1. Google Identity Services (accounts.google.com/gsi/client, loaded on
 *     first use) asks the user for an access token with the `drive.file`
 *     scope, which lets Breakside create spreadsheets and touch only the ones
 *     it created. This is separate from Breakside sign-in: an email/password
 *     account or a share-link guest can export to their own Google Drive.
 *  2. spreadsheets.create writes every tab, its values and number formats in
 *     one request; a batchUpdate then adds the sort/filter ranges.
 *
 * The token lives in memory only (about an hour) and is never sent to our
 * API. Google opens the consent popup from requestAccessToken(), which the
 * browser allows only inside a user gesture — so the dialog preloads the
 * script when it opens (preloadGoogleSheets) and calls getAccessToken()
 * synchronously from the Export click. See ARCHITECTURE.md § Statistics Export.
 */

import { BREAKSIDE_AUTH } from '../auth/config.js';

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

let gisPromise = null;
let tokenClient = null;
let cachedToken = null;   // { value, expiresAt }

/** Whether this deployment has a Google OAuth client configured. */
function googleSheetsConfigured() {
    return !!BREAKSIDE_AUTH.GOOGLE_CLIENT_ID;
}

/** Load the Google Identity Services script once. */
function loadGis() {
    if (window.google?.accounts?.oauth2) return Promise.resolve();
    if (gisPromise) return gisPromise;
    gisPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = GIS_SRC;
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => { gisPromise = null; reject(new Error('Couldn’t reach Google sign-in')); };
        document.head.appendChild(script);
    });
    return gisPromise;
}

/**
 * Start loading Google's script and set up the token client, so a later
 * Export click can open the consent popup without awaiting anything first.
 */
function preloadGoogleSheets() {
    if (!googleSheetsConfigured()) return Promise.resolve(false);
    return loadGis().then(() => {
        if (!tokenClient) {
            tokenClient = window.google.accounts.oauth2.initTokenClient({
                client_id: BREAKSIDE_AUTH.GOOGLE_CLIENT_ID,
                scope: SCOPE,
                callback: () => {},   // replaced per request below
            });
        }
        return true;
    }).catch(() => false);
}

/** Whether preloadGoogleSheets has finished, so getAccessToken can run synchronously. */
function googleSheetsReady() {
    return !!tokenClient;
}

/**
 * Get an access token. MUST be called synchronously from a click handler when
 * no token is cached: Google opens its popup from inside this call.
 * @returns {Promise<string>}
 */
function getAccessToken() {
    if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) {
        return Promise.resolve(cachedToken.value);
    }
    if (!tokenClient) return Promise.reject(new Error('Google sign-in isn’t ready yet — try again in a moment'));
    return new Promise((resolve, reject) => {
        tokenClient.callback = (resp) => {
            if (resp.error) { reject(new Error(resp.error_description || resp.error)); return; }
            cachedToken = { value: resp.access_token, expiresAt: Date.now() + (Number(resp.expires_in) || 3600) * 1000 };
            resolve(resp.access_token);
        };
        tokenClient.error_callback = (err) => {
            // popup_closed / popup_failed_to_open
            reject(new Error(err?.type === 'popup_closed'
                ? 'Google sign-in was closed before it finished'
                : 'Google sign-in couldn’t open — allow pop-ups for this site and try again'));
        };
        tokenClient.requestAccessToken({ prompt: '' });
    });
}

// ── Request bodies (pure; unit-tested) ──────────────────────────────────

const NUMBER_FORMATS = {
    pct: { type: 'PERCENT', pattern: '0%' },
    dec: { type: 'NUMBER', pattern: '0.00' },
};

function cellData(value, fmt, bold) {
    const cell = {};
    if (typeof value === 'number' && Number.isFinite(value)) {
        cell.userEnteredValue = { numberValue: value };
        if (fmt) cell.userEnteredFormat = { numberFormat: NUMBER_FORMATS[fmt] };
    } else if (typeof value === 'boolean') {
        cell.userEnteredValue = { boolValue: value };
    } else if (value !== null && value !== undefined && value !== '') {
        // stringValue is literal text — a name starting with "=" stays text,
        // never a formula.
        cell.userEnteredValue = { stringValue: String(value) };
    }
    if (bold) cell.userEnteredFormat = { ...(cell.userEnteredFormat || {}), textFormat: { bold: true } };
    return cell;
}

/**
 * The spreadsheets.create body for a workbook. Sheet ids are assigned here
 * (0, 1, 2…) so the follow-up filter requests can address them.
 * @param {{stem: string, sheets: Array<object>}} workbook
 * @param {string} title - the document title in Drive
 */
function buildSpreadsheetBody(workbook, title) {
    return {
        properties: { title },
        sheets: workbook.sheets.map((sheet, sheetId) => {
            // Bold the title row (a lone cell above the header) and the header row.
            const headerRow = sheet.filter ? sheet.filter.r0 : -1;
            const width = Math.max(1, ...sheet.rows.map(r => r.length));
            return {
                properties: {
                    sheetId,
                    title: sheet.name,
                    gridProperties: {
                        rowCount: Math.max(sheet.rows.length, 1),
                        columnCount: Math.max(width, (sheet.widths || []).length, 1),
                        frozenRowCount: sheet.frozenRows || 0,
                        frozenColumnCount: sheet.frozenCols || 0,
                    },
                },
                data: [{
                    startRow: 0,
                    startColumn: 0,
                    rowData: sheet.rows.map((row, r) => ({
                        values: row.map((v, c) => cellData(v, sheet.formats?.[c], r <= headerRow)),
                    })),
                    // Sheets measures in pixels; the specs are in characters.
                    columnMetadata: (sheet.widths || []).map(wch => ({ pixelSize: Math.round(wch * 7 + 12) })),
                }],
            };
        }),
    };
}

/** The batchUpdate requests that add each sheet's sort/filter range. */
function buildFilterRequests(workbook) {
    return workbook.sheets
        .map((sheet, sheetId) => sheet.filter && {
            setBasicFilter: {
                filter: {
                    range: {
                        sheetId,
                        startRowIndex: sheet.filter.r0,
                        endRowIndex: sheet.filter.r1 + 1,
                        startColumnIndex: sheet.filter.c0,
                        endColumnIndex: sheet.filter.c1 + 1,
                    },
                },
            },
        })
        .filter(Boolean);
}

// ── Network ─────────────────────────────────────────────────────────────

async function sheetsFetch(url, token, body) {
    const resp = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!resp.ok) {
        if (resp.status === 401) cachedToken = null;
        let message = `Google Sheets returned ${resp.status}`;
        try { message = (await resp.json()).error?.message || message; } catch (e) { /* not JSON */ }
        throw new Error(message);
    }
    return resp.json();
}

/**
 * Create a Google Sheet from a workbook.
 * @param {{stem: string, sheets: Array<object>}} workbook
 * @param {string} token - from getAccessToken()
 * @param {string} title - document title
 * @returns {Promise<string>} the spreadsheet's URL
 */
async function createGoogleSheet(workbook, token, title) {
    const created = await sheetsFetch(SHEETS_API, token, buildSpreadsheetBody(workbook, title));
    const requests = buildFilterRequests(workbook);
    if (requests.length) {
        // Filters are a convenience; a failure here still leaves a usable sheet.
        try {
            await sheetsFetch(`${SHEETS_API}/${created.spreadsheetId}:batchUpdate`, token, { requests });
        } catch (e) {
            console.warn('Google Sheets filter setup failed:', e);
        }
    }
    return created.spreadsheetUrl;
}

// --- ES-module exports ---
export {
    googleSheetsConfigured, preloadGoogleSheets, googleSheetsReady, getAccessToken,
    createGoogleSheet, buildSpreadsheetBody, buildFilterRequests,
};
