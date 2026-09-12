# Password change and reset

Status: shipped. Built 2026-09-12 on branch `password-change`, tried on staging with a real account the same day, and merged to `main` 2026-09-12. Everything up to the Supabase calls was first verified in a browser preview with those calls stubbed (an agent session cannot sign in); the recipe below is still the way to exercise it without an account. Last verified 2026-09-12.

The mechanism is summarised in ARCHITECTURE.md § Password management. This note is the why, the traps, and the test recipe.

## What existed before

Nothing for a signed-in user, and "Forgot password?" was half a feature. Both sign-in forms sent the reset email, but nothing handled the link: the landing page's `PASSWORD_RECOVERY` handler wrote "Enter your new password" into a container it had just hidden, and the app had no handler at all, so the link simply signed the user in with no prompt (a recovery session is a session). No `updateUser` call existed anywhere.

## Design calls

- **The current password is verified before the write**, although Supabase's `updateUser` does not require it. A coach's unlocked phone gets handed around on a sideline; the session alone should not be enough to lock its owner out. Recovery mode (the emailed link) skips it because the link was the proof.
- **Verification goes through GoTrue's REST grant, not supabase-js.** `signInWithPassword` on the app's client replaces the session and fires `SIGNED_IN`, which `main.js` answers by re-rendering the Teams screen under the dialog; a second `createClient` logs a "Multiple GoTrueClient instances" warning. `POST /auth/v1/token?grant_type=password` with the anon key is what the client sends anyway, and the session it mints is revoked with `/logout?scope=local`. A 400 with no `error_code` is treated as bad credentials (older GoTrue answers `{error, error_description}`).
- **One dialog, two modes.** Recovery mode drops the current-password field and the forgot-link row and relabels the button. A reset link can announce itself twice (the URL hash at boot, then the `PASSWORD_RECOVERY` event supabase-js fires from a `setTimeout(0)` inside its initializer), so opening is a no-op while the dialog is already up, and the install prompt that normally follows an auth callback is skipped in favour of the dialog.
- **Google-only accounts see a note, not the link.** `updateUser({ password })` would *add* a password to such an account, which is a different feature with no current-password check possible. Unknown user shapes (the test-mode fake user) count as password accounts; the worst outcome there is "current password is incorrect".
- **"Sign out my other devices"** is `signOut({ scope: 'others' })`, unchecked by default. That scope keeps the local session and fires no `SIGNED_OUT` (which would bounce to the landing page). Its failure is reported in the done message, not treated as a failed change.
- **Reauthentication setting.** If the Supabase project's *Secure password change* is on, `updateUser` answers `reauthentication_needed`; the dialog explains and points at "Email me a reset link" rather than implementing the nonce flow.
- **The forgot link inside the dialog** exists for the coach who has been auto-signed-in for months and no longer knows the current password. It is the same `resetPassword()` as the sign-in screen's, and its link reopens the dialog in recovery mode.

## Things that bit

- `/app/` is not a route. S3's 404 fallback serves `index.html` there, and every asset reference in that file is relative, so `main.js` resolves to `/app/main.js` and comes back as HTML (checked on production: 404, `text/html`). `resetPassword()`, `signInWithGoogle()` and the join page's post-join redirect all pointed there; all target `/` now, and `tests/unit/noAppPathRedirect.test.mjs` fails on any new one.
- Supabase honours `redirectTo` only from its Redirect URL allowlist and otherwise sends the link to the Site URL (production). If a staging reset link lands on www, that is the cause. The link's host is worth checking on the first real test.
- On the landing page, `updateUIForUser(session.user)` runs on every auth event and flips the modal to "Welcome"; recovery mode has to short-circuit it until the form's own handler is done. Likewise, subscribing with `onAuthStateChange` emits `INITIAL_SESSION` straight away, and the logged-out branch of that handler resets the modal, which wiped an expired-link message shown just before subscribing. The message is now shown from inside the handler.
- Expired links come back as `#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired`, not as a token. Both pages surface the description.
- `.prominent-dialog-header h2` is 2rem uppercase; "CHANGE PASSWORD" wraps to two lines in a 420px modal, on top of a form that is tall already. The dialog overrides it to 1.6rem.

## How to test without an account

- **App dialog**: `http://localhost:<port>/?testMode=true`, Teams screen, Account section at the bottom, *Change password…*. Stub `window.breakside.auth.verifyCurrentPassword`, `updatePassword` and `resetPassword` from an injected main-world `<script>` element (the preview's isolated world cannot see `window.breakside`); return shapes are documented on the functions in `auth/auth.js`. Recovery mode: `window.showChangePasswordDialog({ recovery: true })` from the same script. Fields accept scripted `value` plus a bubbling `input` event; submit with `form.requestSubmit()`.
- **Expired-link path in the app**: load `/#error_description=Email+link+is+invalid+or+has+expired` with no stubs; the in-app sign-in screen shows the text.
- **Landing page**: call the global `showNewPasswordForm()` after stubbing `supabaseClient.auth.updateUser` and `getSession` (classic script, so `supabaseClient` is a global `const`; patch its methods, as for the join page). The expired-link path is `/landing/#error_description=…` with no stubs.
- **Real end-to-end** (needs a person): staging → sign in → Teams → Account → Change password, including a wrong current password and the sign-out-others box; then Sign Out → Forgot password → email → link → the dialog should open in recovery mode. If "Secure password change" is on in the Supabase dashboard, expect the reauthentication message instead of a change.

## Landing-page twin (branch `password-followups`, merged 2026-09-12)

The *My Account* modal on `/landing/` got its own change-password form. It is deliberately smaller than the app's dialog (no show-passwords toggle, no sign-out-other-devices) and its rules are a hand-kept copy of `auth/passwordRules.js`, because `landing/` is classic scripts that cannot import a module; `landing/apiOrigin.js` is the precedent. The current-password check is the same direct GoTrue grant, for the same reason: `updateUIForUser()` runs on every auth event, and a `signInWithPassword` on the page's client would flip the modal back to the welcome view mid-flow. Sign-out resets the form; closing the modal returns to the account view.

Test without an account: from an injected main-world `<script>`, stub `supabaseClient.auth.updateUser` and the global `verifyCurrentPassword`, call `updateUIForUser({ email, identities: [{ provider: 'email' }] })`, click `#changePasswordLink`, and drive `#changePasswordForm`. A user object whose identities hold only `google` hides the link.

## Follow-ups

Listed in TODO.md § Near Term: *Set a password* for Google-only accounts.
