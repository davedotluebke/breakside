/*
 * Browser stop check — the real narration session, the real Realtime API,
 * a clip in place of the microphone.
 *
 * stop_latency_probe.py measures what the server does and models the
 * client. This runs the client itself (narration/realtimeSession.js) in a
 * page, so it is the before/after tool for anything in the stop path: tap
 * timing, lost last words, the transcript's shape, back-to-back recordings.
 *
 * Setup (a dev server and a dev backend, both from the worktree under test):
 *
 *   1. scripts/dev-backend.sh --port 8013 --label stop-check --fresh
 *      with OPENAI_API_KEY in its environment (it mints the session tokens).
 *   2. scripts/dev-server.sh 3013, then copy two clips where it serves them:
 *        lineup_scenarios/C3-all-off-then-two-in/audio.flac    -> tests/_probe/c3.flac
 *        lineup_scenarios/A1-single-bare-add-partial/audio.flac -> tests/_probe/kris.flac
 *      (tests/ is excluded from deploys; delete the copies afterwards.)
 *   3. Open http://localhost:3013/?api=http://localhost:8013&testMode=true
 *      and click once anywhere: audio needs a user gesture.
 *   4. Paste this file into the console (or inject it), then for example:
 *
 *        await stopCheck.init();
 *        await stopCheck.sweep([['addon', 0.6], ['addon', 1.1], ['tail', 3]], { pauseMs: 3500 });
 *        stopCheck.table();
 *
 * A run plays [0.3 s silence][first phrase][gap][add-on "Kris"][0.25 s] (kind
 * 'addon', seconds = the gap) or [first phrase][silence] (kind 'tail',
 * seconds = the pause before the tap) and calls stop() the moment playback
 * ends. Each result carries how long stop() took, the transcript, how much
 * audio actually went out, and the server's events timed against the tap.
 *
 * Reading the result: 'ok' the add-on is in the transcript as its own word;
 * 'GLUED' it is there but run onto the previous word; 'ABSENT' it is not
 * there (check the trace: if the server's own completed text lacks it, the
 * recognizer left it out and no client change will bring it back); 'KILLED'
 * the session reported an error, e.g. a previous session's socket closing
 * late. pauseMs is the gap between runs: 250 is back-to-back, 3500 keeps a
 * late close from an earlier run out of the picture.
 *
 * 2026-11-25, gpt-4o-transcribe, old stop() against the item-tracked one:
 * stop after a 3 s pause 4.0 s -> 0.2-0.4 s; back-to-back runs killed 15 of
 * 31 -> 0 of 16; add-on at 0.5-0.8 s gaps lost or glued 3 of 16 -> absent 1
 * of 16; at a 0.4 s gap absent 4 of 4 -> 3 of 10 (recognizer omissions).
 */
window.stopCheck = (() => {
    const ROSTER = ['Kris', 'Sam', 'Hank', 'Morgan Vale', 'Nora', 'Omar', 'Wes', 'Alice', 'Priya', 'Dana', 'Jake', 'Charlie']
        .map(name => ({ name }));
    const ADDON = /\b(k|ch)ris\b/i;
    const ADDON_ANYWHERE = /(k|ch)ris/i;

    let feedCtx, first, addon, session;
    let sentSeconds = 0;
    let trace = { events: [], stopAt: null };
    const results = [];

    // Count the audio put on the wire and record the server's events, by
    // wrapping the page's WebSocket. Install before the first session.
    const NativeWS = window.WebSocket;
    class TracedWS extends NativeWS {
        constructor(url, protocols) {
            super(url, protocols);
            const mine = trace = { events: [], stopAt: null };
            this.addEventListener('message', (ev) => {
                try {
                    const m = JSON.parse(ev.data);
                    const t = m.type || '';
                    if (t.startsWith('input_audio_buffer.') || t.includes('input_audio_transcription') || t === 'error') {
                        mine.events.push([performance.now(), t, (m.item_id || '').slice(-4),
                            t.endsWith('.delta') ? m.delta : (m.transcript ?? (m.error && m.error.code) ?? '')]);
                    }
                } catch (_) { /* not ours to judge */ }
            });
            this.addEventListener('close', () => mine.events.push([performance.now(), 'socket.close', '', '']));
        }
        send(data) {
            if (typeof data === 'string' && data.startsWith('{"type":"input_audio_buffer.append"')) {
                sentSeconds += (data.length - 60) * 0.75 / 2 / 24000;   // base64 PCM16 at 24 kHz
            }
            return super.send(data);
        }
    }
    window.WebSocket = TracedWS;

    async function init() {
        feedCtx = new AudioContext();
        await feedCtx.resume();
        const load = async (url) => feedCtx.decodeAudioData(await (await fetch(url)).arrayBuffer());
        first = await load('/tests/_probe/c3.flac');
        addon = await load('/tests/_probe/kris.flac');
        session = (await import('/narration/realtimeSession.js')).narrationRealtimeSession;
        return { audio: feedCtx.state, first: first.duration, addon: addon.duration,
                 model: window.advancedSettings.get('narration.transcriptionModel') };
    }

    function composite(parts) {
        const rate = feedCtx.sampleRate;
        const length = parts.reduce((n, p) => n + (typeof p === 'number' ? Math.round(p * rate) : p.length), 0);
        const out = feedCtx.createBuffer(1, length, rate);
        const channel = out.getChannelData(0);
        let offset = 0;
        for (const p of parts) {
            if (typeof p === 'number') offset += Math.round(p * rate);
            else { channel.set(p.getChannelData(0), offset); offset += p.length; }
        }
        return out;
    }

    function classify(r) {
        if (r.errors.length) return 'KILLED';
        if (r.kind === 'tail') return 'tail';
        if (ADDON.test(r.transcript)) return 'ok';
        return ADDON_ANYWHERE.test(r.transcript) ? 'GLUED' : 'ABSENT';
    }

    async function runOne(kind, seconds, model) {
        const clip = kind === 'addon' ? composite([0.3, first, seconds, addon, 0.25]) : composite([0.3, first, seconds]);
        const mic = feedCtx.createMediaStreamDestination();
        const realGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async () => mic.stream;
        const errors = [];
        const live = [];
        const options = window.advancedSettings.getNarrationSessionOptions(ROSTER);
        if (model) options.transcriptionModel = model;
        sentSeconds = 0;
        try {
            await session.start({
                mode: 'transcription', ...options,
                // The second argument is the whole transcript on builds that pass it.
                onTranscriptDelta: (delta, transcript) => live.push(transcript ?? delta),
                onTranscriptComplete: (utterance, transcript) => live.push(transcript ?? utterance),
                onError: (e) => errors.push(String(e && e.message || e))
            });
        } finally {
            navigator.mediaDevices.getUserMedia = realGetUserMedia;
        }
        const mine = trace;
        const source = feedCtx.createBufferSource();
        source.buffer = clip;
        source.connect(mic);
        const ended = new Promise((resolve) => { source.onended = resolve; });
        source.start();
        await ended;
        mine.stopAt = performance.now();
        const { transcript } = await session.stop();
        const stopMs = Math.round(performance.now() - mine.stopAt);
        await new Promise(resolve => setTimeout(resolve, 600));       // let late events reach the trace
        const result = {
            kind, seconds, model: options.transcriptionModel, stopMs, transcript: transcript || '',
            liveLast: live[live.length - 1], errors,
            clipMs: Math.round(clip.duration * 1000), sentMs: Math.round(sentSeconds * 1000),
            trace: mine.events.map(([t, type, item, text]) => [Math.round(t - mine.stopAt),
                type.replace('conversation.item.input_audio_transcription.', 'tx.').replace('input_audio_buffer.', 'buf.'),
                item, String(text).slice(0, 60)])
        };
        result.outcome = classify(result);
        results.push(result);
        return result;
    }

    /** plan: [[kind, seconds, model?], ...]. Resolves when every run is done. */
    async function sweep(plan, { pauseMs = 3500 } = {}) {
        for (const [kind, seconds, model] of plan) {
            await runOne(kind, seconds, model);
            await new Promise(resolve => setTimeout(resolve, pauseMs));
        }
        return results.length;
    }

    function table() {
        console.table(results.map(r => ({
            kind: r.kind, seconds: r.seconds, stopMs: r.stopMs, outcome: r.outcome,
            end: r.transcript.slice(-28), unsentMs: r.clipMs - r.sentMs
        })));
        return results.reduce((tally, r) => { tally[r.outcome] = (tally[r.outcome] || 0) + 1; return tally; }, {});
    }

    return { init, runOne, sweep, table, results };
})();
