/*
 * OpenAI Realtime API Session Manager
 *
 * Manages the WebSocket to OpenAI's Realtime API for streaming audio and
 * receiving function-call "provisional events".
 *
 * Flow:
 *   1. Caller invokes start(options) with tools + instructions
 *   2. We fetch an ephemeral token from our backend (/api/narration/token)
 *   3. Open WebSocket to OpenAI Realtime API using the ephemeral token
 *   4. Send session.update with instructions, tools, audio format
 *   5. Open the microphone (getUserMedia), run audio through an AudioContext
 *      that resamples to 24kHz PCM16, base64-encoded chunks streamed via
 *      input_audio_buffer.append messages
 *   6. Listen for events:
 *        - input_audio_buffer.committed and
 *          conversation.item.input_audio_transcription.delta/completed
 *          (the transcript, kept per committed item: transcriptItems.js)
 *        - response.function_call_arguments.done
 *          (a provisional event — callback invoked)
 *   7. Caller invokes stop(): the mic closes, the buffer is committed, and
 *      the socket stays open until every committed item has its transcript
 *
 * Ephemeral tokens mean the OpenAI API key never touches the client.
 *
 * Note: OpenAI's browser-recommended transport is WebRTC; this uses the
 * WebSocket transport since it's simpler and sufficient for one-direction
 * audio (browser → server) without audio playback. If token delivery via
 * WebSocket subprotocol proves unreliable in a given browser, switching to
 * WebRTC is a scoped change within this module.
 */
import { authFetch, API_BASE_URL } from '../store/sync.js';
import { log } from '../utils/logger.js';
import { createTranscriptItems } from './transcriptItems.js';

/**
 * Merge a completed-utterance transcript into an accumulated transcript.
 * Guards against double-appending text already received via streaming
 * deltas: skip only when the accumulated text already ends with this
 * utterance — an `includes` check would wrongly drop genuinely repeated
 * phrases later in the recording.
 *
 * No longer used by this module or by the narration surfaces (plays,
 * lineups, squads): they take the session's own transcript, which is kept
 * per item (transcriptItems.js) and passed as the second argument of both
 * transcript callbacks. Kept so that a branch written against the old
 * callbacks still loads; a caller that accumulates on its own from the first
 * argument joins utterances with nothing between them.
 * @returns {string} The (possibly unchanged) accumulated transcript
 */
function mergeCompletedUtterance(accumulated, utterance) {
    if (!utterance || accumulated.endsWith(utterance)) return accumulated;
    return accumulated + utterance;
}

const narrationRealtimeSession = (function() {
    const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime';
    const TOKEN_ENDPOINT_PATH = '/api/narration/token';
    const TARGET_SAMPLE_RATE = 24000;  // OpenAI Realtime API expects 24kHz PCM16
    const BUFFER_SIZE = 4096;           // ScriptProcessorNode buffer size (~170ms at 24kHz)
    // Backstops for stop(), for a server that never answers. Normally stop()
    // returns as soon as the transcript is settled: about 0.2 s after a
    // pause, 0.5-1.5 s when the last words were still in the buffer. The
    // server caps an item at about 15 s of speech and transcribed those
    // within 2.3 s; across some 500 completions that was the slowest, and
    // one stop in about 100 browser runs took 3.7 s to settle (live API,
    // 2026-11-25). The backstops cost nothing while the server answers, so
    // they are set well clear of that.
    const STOP_QUIET_MS = 6000;         // give up after this long with no transcription event
    const STOP_MAX_MS = 12000;          // and never wait longer than this in all

    // State
    let ws = null;
    let audioContext = null;
    let mediaStream = null;
    let sourceNode = null;
    let processorNode = null;
    let sessionActive = false;
    let onFunctionCallCb = null;
    let onTranscriptDeltaCb = null;
    let onTranscriptCompleteCb = null;
    let onErrorCb = null;
    // The transcript, one entry per committed item, and what stop() waits on.
    const transcriptItems = createTranscriptItems();
    // Optional observer of the mic stream (narration/clipRecorder.js);
    // registered through setAudioTap(). Never affects the session itself.
    let audioTap = null;

    // Module-level mode flag, set by start() and read by stop() to decide
    // whether we need to commit + create a response (conversation) or just
    // commit and wait for final transcription deltas (transcription-only).
    let currentMode = 'transcription';
    // getUserMedia constraints chosen by start() (from Advanced Settings),
    // read by startAudioCapture which takes no args.
    let currentAudioConstraints = null;

    /**
     * Start a realtime session.
     * @param {object} options
     * @param {string} [options.mode] - 'transcription' (default) or 'conversation'.
     *   - 'transcription' uses the dedicated `?intent=transcription` Realtime
     *     endpoint with no LLM in the loop (cheaper, no response.* events,
     *     no acknowledgment-text spam). instructions/tools/onFunctionCall
     *     are ignored in this mode.
     *   - 'conversation' is the legacy gpt-realtime path with tools and
     *     function-call provisional events. Kept reachable for the day we
     *     re-enable the fast-pass extractor.
     * @param {string} [options.model] - Conversation-mode model (e.g. 'gpt-realtime').
     * @param {string} [options.transcriptionModel] - ASR model in transcription mode.
     * @param {string} [options.transcriptionLanguage] - ISO code (e.g. 'en') to pin
     *   recognition language, or undefined to auto-detect.
     * @param {string} [options.transcriptionPrompt] - Free-text vocabulary hint to
     *   bias the recognizer toward expected names/jargon.
     * @param {string} [options.vadEagerness] - semantic_vad eagerness: low|medium|high|auto.
     * @param {string} [options.noiseReduction] - near_field|far_field|off.
     * @param {object} [options.audioConstraints] - getUserMedia audio constraints
     *   (echoCancellation/noiseSuppression/autoGainControl/channelCount).
     * @param {string} [options.instructions] - Conversation-mode system prompt.
     * @param {Array}  [options.tools] - Conversation-mode tool definitions.
     * @param {function} [options.onFunctionCall] - Conversation-mode call back.
     * @param {function} [options.onTranscriptDelta] - Called as (delta, transcript):
     *   the new text, and the whole transcript so far.
     * @param {function} [options.onTranscriptComplete] - Called as (utterance,
     *   transcript): one item's final text, and the whole transcript so far.
     *   Use the second argument of either callback as the transcript; it is
     *   assembled per item, in order, with a space between utterances.
     * @param {function} [options.onError] - Called on errors.
     * @returns {Promise<void>} Resolves when session is open and mic is streaming.
     */
    async function start(options) {
        if (sessionActive) {
            throw new Error('Realtime session already active');
        }

        const {
            mode = 'transcription',
            model = 'gpt-realtime',
            // Fallback only: both callers pass the Advanced Settings value
            // (settings/advancedSettings.js owns the real default).
            transcriptionModel = 'gpt-4o-transcribe',
            transcriptionLanguage,
            transcriptionPrompt,
            vadEagerness,
            noiseReduction,
            audioConstraints,
            instructions = '',
            tools = [],
            onFunctionCall,
            onTranscriptDelta,
            onTranscriptComplete,
            onError
        } = options;

        currentMode = (mode === 'conversation') ? 'conversation' : 'transcription';
        // Stash for startAudioCapture (called below without args).
        currentAudioConstraints = audioConstraints || null;

        onFunctionCallCb = onFunctionCall || (() => {});
        onTranscriptDeltaCb = onTranscriptDelta || (() => {});
        onTranscriptCompleteCb = onTranscriptComplete || (() => {});
        onErrorCb = onError || ((e) => console.error('[realtimeSession]', e));
        transcriptItems.reset();

        // Timing breakdown — helps diagnose slow orange→green button transitions.
        const t0 = performance.now();
        const logPhase = (label) => log(`[realtimeSession] ${label}: ${Math.round(performance.now() - t0)}ms`);

        // 1. Fetch ephemeral token from our backend (mode determines which
        //    OpenAI endpoint the server hits; we never see the real key).
        const token = await fetchEphemeralToken({
            mode: currentMode,
            model,
            transcriptionModel
        });
        logPhase('token fetched');

        // 2. Open WebSocket to OpenAI with token in subprotocol.
        //    URL differs by mode:
        //      conversation : ?model=<model>
        //      transcription: ?intent=transcription   (model goes in session.update)
        const wsUrl = (currentMode === 'transcription')
            ? `${OPENAI_REALTIME_URL}?intent=transcription`
            : `${OPENAI_REALTIME_URL}?model=${encodeURIComponent(model)}`;

        ws = new WebSocket(
            wsUrl,
            [
                'realtime',
                // The ephemeral client_secret is passed as a subprotocol.
                // Using the documented subprotocol naming:
                `openai-insecure-api-key.${token}`
                // Do NOT add the retired beta-era subprotocol here (the old
                // third entry). Since the GA cutover, OpenAI accepts the
                // handshake and then kills the session (error + close 4000
                // beta_api_shape_disabled) if that subprotocol appears in the
                // offer at all — that server-side change is what silently
                // broke narration in the field (G5, 2026-07-04) with no
                // client deploy involved. Pinned by
                // tests/unit/narrationRealtimeSocket.test.mjs.
            ]
        );

        try {
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('WebSocket connection timeout')), 10000);
                ws.addEventListener('open', () => {
                    clearTimeout(timeout);
                    resolve();
                }, { once: true });
                ws.addEventListener('error', (err) => {
                    clearTimeout(timeout);
                    reject(new Error('WebSocket connection error'));
                }, { once: true });
            });
        } catch (err) {
            // On timeout/error the socket is half-open with listeners attached
            // and would otherwise leak (and a later start could open the mic
            // against a dead socket). Close and null it before bubbling.
            try { if (ws) ws.close(); } catch (_) {}
            ws = null;
            throw err;
        }
        logPhase('websocket open');

        // Guard against a socket that errored/closed in the same tick the open
        // resolved — never proceed to open the mic against a dead socket.
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            try { if (ws) ws.close(); } catch (_) {}
            ws = null;
            throw new Error('WebSocket closed before session setup');
        }

        // Each listener answers only while its socket is the session's socket.
        // stop() nulls `ws` before the close handshake finishes, so without
        // this a late message from a finished session would land in the next
        // one's transcript, and its close event could tear that session down.
        const socket = ws;
        socket.addEventListener('message', (ev) => { if (ws === socket) handleServerMessage(ev); });
        socket.addEventListener('close', (ev) => { if (ws === socket) handleSocketClose(ev); });
        socket.addEventListener('error', (err) => { if (ws === socket) onErrorCb(err); });

        // 3. Configure the session.
        if (currentMode === 'transcription') {
            // Knobs come from Advanced Settings (passed in by the engine);
            // fall back to the legacy console globals, then sane defaults.
            // window.NARRATION_VAD_EAGERNESS / NARRATION_NOISE_REDUCTION still
            // work as quick dev overrides without opening the settings UI.
            const eagerness = vadEagerness
                || (typeof window !== 'undefined' && window.NARRATION_VAD_EAGERNESS)
                || 'medium';
            const nrSetting = noiseReduction
                || (typeof window !== 'undefined' && window.NARRATION_NOISE_REDUCTION)
                || 'near_field';
            const noiseReductionObj = (nrSetting === 'off' || nrSetting === 'none')
                ? null
                : { type: nrSetting };

            // GA shape: nested under audio.input.* with session.type=transcription.
            // No tools, no instructions, no response model — pure ASR.
            const transcription = { model: transcriptionModel };
            if (transcriptionLanguage) transcription.language = transcriptionLanguage;
            if (transcriptionPrompt) transcription.prompt = transcriptionPrompt;

            const inputCfg = {
                // GA requires an object here; a bare 'audio/pcm' string is
                // rejected with invalid_type and the transcription session
                // never produces any transcript (silent narration failure).
                format: { type: 'audio/pcm', rate: TARGET_SAMPLE_RATE },
                transcription,
                turn_detection: { type: 'semantic_vad', eagerness }
            };
            if (noiseReductionObj) inputCfg.noise_reduction = noiseReductionObj;

            send({
                type: 'session.update',
                session: {
                    type: 'transcription',
                    audio: { input: inputCfg }
                }
            });
        } else {
            // Conversation mode: GA gpt-realtime path with tools. GA renamed
            // `modalities` -> `output_modalities`, requires session.type, and
            // nests audio config under audio.input.* (same migration as the
            // transcription branch above and the backend token mint).
            send({
                type: 'session.update',
                session: {
                    type: 'realtime',
                    output_modalities: ['text'],
                    instructions,
                    tools,
                    tool_choice: 'auto',
                    audio: {
                        input: {
                            format: { type: 'audio/pcm', rate: TARGET_SAMPLE_RATE },
                            transcription: {
                                // gpt-4o-mini-transcribe is paired with
                                // gpt-realtime; whisper-1 does not reliably emit
                                // transcription events on this path in testing.
                                model: transcriptionModel
                            },
                            turn_detection: {
                                type: 'server_vad',
                                // Sane defaults for the conversational fast pass.
                                // We're not chasing maximal splits — just clean
                                // utterance boundaries and reliable VAD on stop.
                                threshold: 0.5,
                                prefix_padding_ms: 300,
                                silence_duration_ms: 500
                            }
                        }
                    }
                }
            });
        }
        logPhase('session.update sent');

        // 4. Open the microphone and start streaming. If capture fails
        // (permission denied, no device), close the socket we just opened —
        // otherwise it lingers listener-attached until OpenAI idle-times it
        // out, and a quick retry can find stale state.
        // Tell the tap a session is about to go live, before the first
        // chunk can flow; every path out of here below then closes it.
        if (audioTap && audioTap.onSessionStart) {
            audioTap.onSessionStart({ mode: currentMode, model, transcriptionModel, sampleRate: TARGET_SAMPLE_RATE });
        }
        try {
            await startAudioCapture();
        } catch (err) {
            try { if (ws) ws.close(); } catch (_) {}
            ws = null;
            if (audioTap && audioTap.onSessionStop) audioTap.onSessionStop({ transcript: '', aborted: true });
            throw err;
        }
        logPhase('audio capture started');

        // The socket can die while getUserMedia is up — on iOS the permission
        // prompt holds this await open for seconds, ample time for a fatal
        // server error (e.g. the beta_api_shape_disabled close that caused
        // G5) to land. Without this check that death was invisible:
        // handleSocketClose ignores closes while !sessionActive, send()
        // silently drops frames on a closed socket, and the UI latched into a
        // green "recording" state streaming into the void. Fail loudly
        // instead so the engine resets and the mic button surfaces an error.
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            stopAudioCapture();
            ws = null;
            if (audioTap && audioTap.onSessionStop) audioTap.onSessionStop({ transcript: '', aborted: true });
            throw new Error('Connection closed during microphone setup');
        }

        sessionActive = true;
    }

    /**
     * Stop the realtime session, closing mic and WebSocket.
     * @returns {Promise<{transcript: string}>} The session's transcript for the slow pass.
     */
    async function stop() {
        if (!sessionActive) {
            return { transcript: transcriptItems.text() };
        }
        sessionActive = false;

        // Stop audio capture first so no more frames go out
        stopAudioCapture();

        // Force end-of-turn. VAD only commits after a silence window —
        // once we stop sending audio there's no silence for it to detect
        // either, so without a manual commit the trailing utterance sits
        // pending forever. The server answers the commit one of two ways:
        // input_audio_buffer.committed with a new item to transcribe, or a
        // "buffer too small" error when VAD had already committed everything
        // (benign: handleServerMessage reads it as "no new item").
        //
        // In conversation mode we additionally fire response.create to
        // flush any pending function calls. Transcription-only sessions
        // have no response model — sending response.create is meaningless
        // and will error, so we skip it.
        if (ws && ws.readyState === WebSocket.OPEN) {
            const stoppedAt = performance.now();
            if (currentMode === 'transcription') transcriptItems.expectCommit();
            try {
                send({ type: 'input_audio_buffer.commit' });
                if (currentMode === 'conversation') {
                    send({ type: 'response.create' });
                }
            } catch (_) { /* socket may already be closing */ }

            // Transcription: wait until the commit is answered and every
            // committed item has its transcript — not for "the next
            // completion", which may belong to an earlier phrase (and then
            // the last words were lost), or may never come (and then the
            // whole timeout was spent on nothing). Conversation: wait for
            // response.done. Either way a close or the backstops end it.
            const how = await waitForStop();
            log(`[realtimeSession] stop: ${how} after ${Math.round(performance.now() - stoppedAt)}ms`);
        }

        try {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.close();
            }
        } catch (_) { /* ignore */ }

        ws = null;
        const transcript = transcriptItems.text();
        if (audioTap && audioTap.onSessionStop) {
            audioTap.onSessionStop({ transcript, aborted: false });
        }
        return { transcript };
    }

    // What stop() is waiting on, or null: { finish(how), progress() }.
    // finish() resolves the wait; progress() restarts the no-activity clock.
    let pendingStop = null;

    function waitForStop() {
        return new Promise((resolve) => {
            let done = false;
            let quietTimer = null;
            let maxTimer = null;
            const finish = (how) => {
                if (done) return;
                done = true;
                clearTimeout(quietTimer);
                clearTimeout(maxTimer);
                pendingStop = null;
                resolve(how);
            };
            const progress = () => {
                clearTimeout(quietTimer);
                quietTimer = setTimeout(() => finish('gave up (no transcription activity)'), STOP_QUIET_MS);
            };
            pendingStop = { finish, progress };
            maxTimer = setTimeout(() => finish('gave up (time limit)'), STOP_MAX_MS);
            progress();
        });
    }

    // A transcription event arrived. If stop() is waiting, either the
    // transcript is now settled, or the server is still working on it.
    function noteTranscriptionActivity() {
        if (!pendingStop) return;
        if (currentMode === 'transcription' && transcriptItems.isSettled()) {
            pendingStop.finish('settled');
        } else {
            pendingStop.progress();
        }
    }

    /**
     * Is a session currently active?
     */
    function isActive() {
        return sessionActive;
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    async function fetchEphemeralToken({ mode, model, transcriptionModel }) {
        // Uses the authFetch helper imported from store/sync.js
        if (typeof authFetch !== 'function') {
            throw new Error('authFetch not available');
        }
        const apiBase = typeof API_BASE_URL !== 'undefined' ? API_BASE_URL : '';
        const resp = await authFetch(`${apiBase}${TOKEN_ENDPOINT_PATH}`, {
            method: 'POST',
            body: JSON.stringify({
                mode,
                model,
                transcription_model: transcriptionModel
            })
        });
        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            throw new Error(`Token fetch failed (${resp.status}): ${text || resp.statusText}`);
        }
        const data = await resp.json();
        if (!data.token) {
            throw new Error('Token response missing "token"');
        }
        return data.token;
    }

    function send(obj) {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        // Log outbound except the avalanche of input_audio_buffer.append chunks.
        if (window.NARRATION_VERBOSE !== false && obj.type !== 'input_audio_buffer.append') {
            log(`[rt] => ${obj.type}`, obj);
        }
        ws.send(JSON.stringify(obj));
    }

    /**
     * Dispatch server events. See OpenAI Realtime API docs for event types.
     */
    function handleServerMessage(ev) {
        let msg;
        try {
            msg = JSON.parse(ev.data);
        } catch (_) {
            return;
        }

        // Verbose diagnostic — logs every event type we receive from OpenAI
        // (needs debug logging on, e.g. ?debug=1; NARRATION_VERBOSE=false
        // force-disables). Filter on "[rt]" in console for the full sequence.
        if (window.NARRATION_VERBOSE !== false) {
            log(`[rt] <= ${msg.type}`, msg);
        }

        switch (msg.type) {
            case 'session.created':
            case 'session.updated':
                // no-op; we don't gate on these
                break;

            case 'input_audio_buffer.committed':
                // A stretch of audio became an item to transcribe: a turn the
                // VAD closed, or the answer to stop()'s manual commit.
                transcriptItems.onCommitted(msg.item_id);
                noteTranscriptionActivity();
                break;

            case 'conversation.item.input_audio_transcription.delta':
                if (msg.delta) {
                    transcriptItems.onDelta(msg.item_id, msg.delta);
                    onTranscriptDeltaCb(msg.delta, transcriptItems.text());
                }
                noteTranscriptionActivity();
                break;

            case 'conversation.item.input_audio_transcription.completed':
                // The item's final text (some transports send only this, no
                // deltas). Transcription-only sessions never emit
                // response.done; stop() is done when the last of these is in.
                transcriptItems.onCompleted(msg.item_id, msg.transcript);
                onTranscriptCompleteCb(msg.transcript || '', transcriptItems.text());
                noteTranscriptionActivity();
                break;

            case 'conversation.item.input_audio_transcription.failed':
                // Nothing more will come for this item; don't let stop() wait
                // on it. What its deltas delivered, if anything, is kept.
                console.warn('[realtimeSession] transcription failed for an item:', msg.error?.message || msg.error || '');
                transcriptItems.onFailed(msg.item_id);
                noteTranscriptionActivity();
                break;

            case 'response.function_call_arguments.done': {
                // A function call has been emitted by the model.
                // msg.name, msg.arguments (JSON string)
                let args = {};
                try {
                    args = JSON.parse(msg.arguments || '{}');
                } catch (e) {
                    console.warn('[realtimeSession] Failed to parse function args:', msg.arguments);
                }
                onFunctionCallCb(msg.name, args, {
                    callId: msg.call_id || null,
                    itemId: msg.item_id || null
                });

                // DO NOT send a function_call_output ack here. Earlier I
                // added one based on an incorrect assumption that the
                // Realtime API required it to unblock further calls. In
                // practice, sending conversation.item.create while the
                // model is still mid-response (streaming more function
                // call deltas) short-circuits the response — the model
                // treats it as start-of-new-turn and stops emitting. The
                // v3 code that worked for the user's first successful
                // multi-event test never sent this ack. Just fire-and-
                // forget — we record the event locally and move on.
                break;
            }

            case 'response.text.delta':
                // When the model emits a text response instead of a function
                // call we want to know — it usually means the prompt wasn't
                // strong enough to force a tool call, or the audio was
                // ambiguous. Log it so we can tune.
                if (msg.delta) {
                    log('[rt] MODEL TEXT OUTPUT (not expected):', msg.delta);
                }
                break;

            case 'response.text.done':
                if (msg.text) {
                    console.warn('[rt] Full model text output (should have been a function call):', msg.text);
                }
                break;

            case 'response.done':
                // Fires at the very end of a response (after all function
                // calls in the response have been emitted). stop() uses
                // this to know when it's safe to close the socket.
                //
                // When a response finished with zero output items, log a
                // helpful diagnostic so we can see empty-response cases.
                try {
                    const r = msg.response || {};
                    const items = r.output || [];
                    const fnCalls = items.filter(i => i.type === 'function_call').length;
                    const texts = items.filter(i => i.type === 'message').length;
                    if (fnCalls === 0) {
                        console.warn(`[rt] response.done with no function calls (status=${r.status}, items: ${items.length}, texts: ${texts})`, r);
                    } else {
                        log(`[rt] response.done: ${fnCalls} function call(s), status=${r.status}`);
                    }
                } catch (_) {}
                if (pendingStop) pendingStop.finish('response done');
                break;

            case 'error': {
                const errMsg = msg.error?.message || 'Realtime API error';
                const errCode = msg.error?.code;
                // "buffer too small" (code input_audio_buffer_commit_empty) is
                // benign: server VAD had already committed all the audio
                // before our manual commit in stop() reached the server. It is
                // also the answer stop() is waiting for: no new item is
                // coming, so only items already committed are outstanding.
                if (errCode === 'input_audio_buffer_commit_empty' ||
                    errMsg.includes('buffer too small') ||
                    errMsg.includes('buffer_empty')) {
                    log('[rt] (ignored) server had already committed the audio:', errMsg);
                    transcriptItems.onCommitRejected();
                    noteTranscriptionActivity();
                    break;
                }
                // Likewise "active response" is benign in conversation mode:
                // server VAD already auto-created the response before our
                // explicit response.create in stop(). Nothing went wrong.
                if (errMsg.includes('active response') ||
                    errCode === 'conversation_already_has_active_response') {
                    log('[rt] (ignored) server already created the response:', errMsg);
                    break;
                }
                onErrorCb(new Error(errMsg));
                break;
            }

            default:
                // Many event types we don't care about; ignore quietly.
                break;
        }
    }

    function handleSocketClose(ev) {
        // A stop() waiting on this socket's answers has nothing more to wait
        // for. (stop() clears sessionActive before it waits, so this cannot
        // sit inside the branch below.)
        if (pendingStop) pendingStop.finish('socket closed');
        if (sessionActive) {
            // Unexpected close. Tear down audio and reconcile state so the UI
            // doesn't latch in "recording"/"finalizing":
            sessionActive = false;
            stopAudioCapture();
            if (audioTap && audioTap.onSessionStop) {
                audioTap.onSessionStop({ transcript: transcriptItems.text(), aborted: true });
            }
            // Notify the engine so it can reset its phase out of "recording".
            onErrorCb(new Error(`Realtime WebSocket closed: ${ev.code} ${ev.reason}`));
        }
    }

    // ---------------------------------------------------------------------
    // Audio capture
    // ---------------------------------------------------------------------

    async function startAudioCapture() {
        // Constraints come from Advanced Settings via start(); default to the
        // browser-processing-on profile when unset.
        const audioConstraints = currentAudioConstraints || {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1
        };
        mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: audioConstraints
        });

        // Create AudioContext at the target sample rate (24kHz). Most browsers
        // will resample the mic input to match this context rate for us.
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        audioContext = new AudioCtx({ sampleRate: TARGET_SAMPLE_RATE });

        sourceNode = audioContext.createMediaStreamSource(mediaStream);

        // ScriptProcessorNode is deprecated but reliably available. Upgrading
        // to AudioWorklet requires a separate module file; revisit if needed.
        processorNode = audioContext.createScriptProcessor(BUFFER_SIZE, 1, 1);
        processorNode.onaudioprocess = (audioEvent) => {
            if (!ws || ws.readyState !== WebSocket.OPEN) return;
            const input = audioEvent.inputBuffer.getChannelData(0);
            const pcm16 = float32ToPcm16(input);
            const base64 = arrayBufferToBase64(pcm16.buffer);
            send({
                type: 'input_audio_buffer.append',
                audio: base64
            });
            // After the send, so the tap sees exactly what went to OpenAI.
            if (audioTap && audioTap.onAudioChunk) audioTap.onAudioChunk(pcm16);
        };

        sourceNode.connect(processorNode);
        // ScriptProcessorNode must be connected somewhere to fire onaudioprocess.
        processorNode.connect(audioContext.destination);

        // Mic-open seconds are the third battery term after screen and
        // polling; the power log tracks them so we can size that claim.
        window.powerLog?.micOpened?.();
    }

    function stopAudioCapture() {
        window.powerLog?.micClosed?.();
        try { if (processorNode) processorNode.disconnect(); } catch (_) {}
        try { if (sourceNode) sourceNode.disconnect(); } catch (_) {}
        try { if (audioContext) audioContext.close(); } catch (_) {}
        if (mediaStream) {
            mediaStream.getTracks().forEach(t => t.stop());
        }
        processorNode = null;
        sourceNode = null;
        audioContext = null;
        mediaStream = null;
    }

    // ---------------------------------------------------------------------
    // Audio conversion helpers
    // ---------------------------------------------------------------------

    /** Convert a Float32Array (-1..1) to Int16Array PCM. */
    function float32ToPcm16(float32) {
        const out = new Int16Array(float32.length);
        for (let i = 0; i < float32.length; i++) {
            let s = Math.max(-1, Math.min(1, float32[i]));
            out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        return out;
    }

    /** Convert ArrayBuffer to base64 without blowing the call stack. */
    function arrayBufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        const chunkSize = 0x8000;  // 32k chunks
        for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
        }
        return btoa(binary);
    }

    /**
     * Register an observer of the microphone stream (the clip recorder).
     * onSessionStart({mode, model, transcriptionModel, sampleRate}) fires
     * before the first chunk; onAudioChunk(Int16Array) once per chunk that
     * was actually sent; onSessionStop({transcript, aborted}) exactly once
     * per started session, however it ends. Pass null to detach.
     */
    function setAudioTap(tap) {
        audioTap = tap || null;
    }

    // Public API
    return {
        start,
        stop,
        isActive,
        setAudioTap
    };
})();

// --- ES-module export. The sole consumer (narration/narrationEngine.js)
// --- imports it directly; no window shim needed — grep found no other
// --- window.narrationRealtimeSession references (code, tests, or HTML).
export { narrationRealtimeSession, mergeCompletedUtterance };
