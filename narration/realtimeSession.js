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
 *        - conversation.item.input_audio_transcription.delta/completed
 *          (accumulated transcript)
 *        - response.function_call_arguments.done
 *          (a provisional event — callback invoked)
 *   7. Caller invokes stop() to close mic + socket cleanly
 *
 * Ephemeral tokens mean the OpenAI API key never touches the client.
 *
 * Note: OpenAI's browser-recommended transport is WebRTC; this uses the
 * WebSocket transport since it's simpler and sufficient for one-direction
 * audio (browser → server) without audio playback. If token delivery via
 * WebSocket subprotocol proves unreliable in a given browser, switching to
 * WebRTC is a scoped change within this module.
 */

(function() {
    const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime';
    const TOKEN_ENDPOINT_PATH = '/api/narration/token';
    const TARGET_SAMPLE_RATE = 24000;  // OpenAI Realtime API expects 24kHz PCM16
    const BUFFER_SIZE = 4096;           // ScriptProcessorNode buffer size (~170ms at 24kHz)

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
    let accumulatedTranscript = '';

    /**
     * Start a realtime session.
     * @param {object} options
     * @param {string} options.model - e.g. 'gpt-4o-mini-realtime-preview'
     * @param {string} options.instructions - System prompt for the model
     * @param {Array} options.tools - Tool definitions (see plan)
     * @param {function} options.onFunctionCall - Called with (name, args) for each provisional event
     * @param {function} [options.onTranscriptDelta] - Called with delta transcript text
     * @param {function} [options.onTranscriptComplete] - Called with full utterance transcript
     * @param {function} [options.onError] - Called on errors
     * @returns {Promise<void>} Resolves when session is open and mic is streaming
     */
    async function start(options) {
        if (sessionActive) {
            throw new Error('Realtime session already active');
        }

        const {
            model = 'gpt-4o-mini-realtime-preview',
            instructions = '',
            tools = [],
            onFunctionCall,
            onTranscriptDelta,
            onTranscriptComplete,
            onError
        } = options;

        onFunctionCallCb = onFunctionCall || (() => {});
        onTranscriptDeltaCb = onTranscriptDelta || (() => {});
        onTranscriptCompleteCb = onTranscriptComplete || (() => {});
        onErrorCb = onError || ((e) => console.error('[realtimeSession]', e));
        accumulatedTranscript = '';

        // Timing breakdown — helps diagnose slow orange→green button transitions.
        const t0 = performance.now();
        const logPhase = (label) => console.log(`[realtimeSession] ${label}: ${Math.round(performance.now() - t0)}ms`);

        // 1. Fetch ephemeral token from our backend
        const token = await fetchEphemeralToken(model);
        logPhase('token fetched');

        // 2. Open WebSocket to OpenAI with token in subprotocol
        ws = new WebSocket(
            `${OPENAI_REALTIME_URL}?model=${encodeURIComponent(model)}`,
            [
                'realtime',
                // The ephemeral client_secret is passed as a subprotocol.
                // Using the documented subprotocol naming:
                `openai-insecure-api-key.${token}`,
                'openai-beta.realtime-v1'
            ]
        );

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
        logPhase('websocket open');

        ws.addEventListener('message', handleServerMessage);
        ws.addEventListener('close', handleSocketClose);
        ws.addEventListener('error', (err) => onErrorCb(err));

        // 3. Configure the session
        send({
            type: 'session.update',
            session: {
                modalities: ['text'],
                instructions,
                tools,
                tool_choice: 'auto',
                input_audio_format: 'pcm16',
                input_audio_transcription: {
                    model: 'whisper-1'
                },
                turn_detection: {
                    type: 'server_vad',
                    threshold: 0.5,
                    prefix_padding_ms: 300,
                    silence_duration_ms: 500
                }
            }
        });
        logPhase('session.update sent');

        // 4. Open the microphone and start streaming
        await startAudioCapture();
        logPhase('audio capture started');

        sessionActive = true;
    }

    /**
     * Stop the realtime session, closing mic and WebSocket.
     * @returns {Promise<{transcript: string}>} The accumulated transcript for the slow pass.
     */
    async function stop() {
        if (!sessionActive) {
            return { transcript: accumulatedTranscript };
        }
        sessionActive = false;

        // Stop audio capture first so no more frames go out
        stopAudioCapture();

        // With turn_detection: server_vad the server handles commit and
        // response.create automatically on silence. Calling them manually
        // here races with that auto-commit and triggers
        //   "Error committing input audio buffer: buffer too small"
        // when the server has already drained the buffer. Just wait briefly
        // for any in-flight transcriptions to land, then close.
        await new Promise(r => setTimeout(r, 500));

        try {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.close();
            }
        } catch (_) { /* ignore */ }

        ws = null;
        return { transcript: accumulatedTranscript };
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

    async function fetchEphemeralToken(model) {
        // Uses the authFetch helper defined in store/sync.js
        if (typeof authFetch !== 'function') {
            throw new Error('authFetch not available');
        }
        const apiBase = typeof API_BASE_URL !== 'undefined' ? API_BASE_URL : '';
        const resp = await authFetch(`${apiBase}${TOKEN_ENDPOINT_PATH}`, {
            method: 'POST',
            body: JSON.stringify({ model })
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
            console.log(`[rt] => ${obj.type}`, obj);
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

        // Verbose diagnostic — logs every event type we receive from OpenAI.
        // Filter on "[rt]" in console to see the full event sequence.
        if (window.NARRATION_VERBOSE !== false) {
            console.log(`[rt] <= ${msg.type}`, msg);
        }

        switch (msg.type) {
            case 'session.created':
            case 'session.updated':
                // no-op; we don't gate on these
                break;

            case 'conversation.item.input_audio_transcription.delta':
                if (msg.delta) {
                    accumulatedTranscript += msg.delta;
                    onTranscriptDeltaCb(msg.delta);
                }
                break;

            case 'conversation.item.input_audio_transcription.completed':
                // Some transports only send the full transcript here, not deltas.
                if (msg.transcript && !accumulatedTranscript.includes(msg.transcript)) {
                    accumulatedTranscript += msg.transcript;
                }
                onTranscriptCompleteCb(msg.transcript || '');
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

                // IMPORTANT: the Realtime API, unlike Chat Completions, requires
                // the client to acknowledge each function call with a
                // function_call_output conversation item. Without this the
                // response stays in an "awaiting tool output" state and the
                // model will not emit subsequent function calls for the rest
                // of the narration — only the first call in an utterance
                // makes it through.
                //
                // We don't actually care about the tool's return value (we're
                // just recording the event locally), so an empty ack is fine.
                // We then trigger response.create to unblock further calls
                // from any audio already buffered.
                if (msg.call_id) {
                    send({
                        type: 'conversation.item.create',
                        item: {
                            type: 'function_call_output',
                            call_id: msg.call_id,
                            output: JSON.stringify({ ok: true })
                        }
                    });
                    send({ type: 'response.create' });
                }
                break;
            }

            case 'error':
                onErrorCb(new Error(msg.error?.message || 'Realtime API error'));
                break;

            default:
                // Many event types we don't care about; ignore quietly.
                break;
        }
    }

    function handleSocketClose(ev) {
        if (sessionActive) {
            // Unexpected close
            onErrorCb(new Error(`Realtime WebSocket closed: ${ev.code} ${ev.reason}`));
            sessionActive = false;
            stopAudioCapture();
        }
    }

    // ---------------------------------------------------------------------
    // Audio capture
    // ---------------------------------------------------------------------

    async function startAudioCapture() {
        mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                channelCount: 1
            }
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
        };

        sourceNode.connect(processorNode);
        // ScriptProcessorNode must be connected somewhere to fire onaudioprocess.
        processorNode.connect(audioContext.destination);
    }

    function stopAudioCapture() {
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

    // Expose globally
    window.narrationRealtimeSession = {
        start,
        stop,
        isActive
    };
})();
