/**
 * A scripted OpenAI Realtime server for narration e2e tests.
 *
 * The real session module (narration/realtimeSession.js) runs in the browser;
 * what it talks to is stood in for here: the WebSocket, the microphone and
 * the token endpoint. A test then plays the server's side of the conversation
 * with serverSays(). The message shapes are the live API's, as recorded by
 * breakside_server/tests/narration/tools/stop_latency_probe.py (2026-11-25).
 *
 * Everything the client sends (audio chunks aside) is on window.__rt.sent,
 * and each socket it opened on window.__rt.sockets.
 */
import { Page } from '@playwright/test';

/** The server's answer to a manual commit when nothing is left to commit. */
export const EMPTY_COMMIT = {
  type: 'error',
  error: {
    type: 'invalid_request_error',
    code: 'input_audio_buffer_commit_empty',
    message: 'Error committing input audio buffer: buffer too small. Expected at least 100ms of audio, but buffer only has 0.00ms of audio.',
  },
};

export const committed = (item_id: string) => ({ type: 'input_audio_buffer.committed', item_id });
export const delta = (item_id: string, text: string) =>
  ({ type: 'conversation.item.input_audio_transcription.delta', item_id, delta: text });
export const completed = (item_id: string, transcript: string) =>
  ({ type: 'conversation.item.input_audio_transcription.completed', item_id, transcript });

/** Install the scripted server before any app code runs. */
export async function installFakeRealtime(page: Page) {
  await page.addInitScript(() => {
    const rt: any = { sockets: [], sent: [] };
    (window as any).__rt = rt;

    // The token endpoint: answered here, so no backend key and no CORS.
    const realFetch = window.fetch.bind(window);
    window.fetch = (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.includes('/api/narration/token')) {
        return Promise.resolve(new Response(JSON.stringify({ token: 'e2e-token' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        }));
      }
      return realFetch(input, init);
    };

    class FakeRealtimeSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      url: string; readyState = 0; sent: any[] = [];
      private listeners: Record<string, { fn: any; once: boolean }[]> = {};
      constructor(url: string) {
        this.url = url;
        rt.sockets.push(this);
        setTimeout(() => { this.readyState = 1; this.dispatch('open', {}); }, 0);
      }
      addEventListener(type: string, fn: any, opts?: any) {
        (this.listeners[type] ||= []).push({ fn, once: !!(opts && opts.once) });
      }
      removeEventListener(type: string, fn: any) {
        this.listeners[type] = (this.listeners[type] || []).filter((l) => l.fn !== fn);
      }
      dispatch(type: string, ev: any) {
        const list = (this.listeners[type] || []).slice();
        this.listeners[type] = (this.listeners[type] || []).filter((l) => !l.once);
        list.forEach((l) => l.fn(ev));
      }
      send(data: string) {
        const msg = JSON.parse(data);
        if (msg.type === 'input_audio_buffer.append') return;   // audio chunks: not the point here
        this.sent.push(msg);
        rt.sent.push(msg);
      }
      close() {
        if (this.readyState === 3) return;
        this.readyState = 3;
        setTimeout(() => this.dispatch('close', { code: 1000, reason: '' }), 0);
      }
      /** The server says something. */
      emit(msg: any) { this.dispatch('message', { data: JSON.stringify(msg) }); }
      /** The connection drops. */
      drop(code = 1006) { this.readyState = 3; this.dispatch('close', { code, reason: 'dropped' }); }
    }
    (window as any).WebSocket = FakeRealtimeSocket;

    // A microphone that needs no device and no permission.
    const fakeMic = async () => {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const dest = ctx.createMediaStreamDestination();
      osc.connect(dest);
      osc.start();
      return dest.stream;
    };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: fakeMic },
    });
  });
}

/** The current socket hears these from the server, in order. */
export async function serverSays(page: Page, ...msgs: any[]) {
  await page.evaluate((list) => {
    const rt = (window as any).__rt;
    const socket = rt.sockets[rt.sockets.length - 1];
    list.forEach((m: any) => socket.emit(m));
  }, msgs);
}

/** How many manual commits the client has sent so far. */
export const commitsSent = (page: Page) => page.evaluate(() =>
  (window as any).__rt.sent.filter((m: any) => m.type === 'input_audio_buffer.commit').length);
