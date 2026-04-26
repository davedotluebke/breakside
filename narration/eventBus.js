/*
 * Event Bus - Client Update Pipeline
 *
 * Tiny pub/sub module that decouples event sources (narration, manual
 * play-by-play, future server push) from UI subscribers (game log, active
 * players display, future full-play-by-play tab).
 *
 * Channels:
 *   - eventAdded(payload)              A new game event was added
 *   - eventAmended(payload)            An existing event was replaced (e.g. slow-pass correction)
 *   - eventRetracted(payload)          An event was removed/undone
 *   - provisionalEventAdded(payload)   A provisional (unconfirmed) narration event was added
 *   - provisionalEventFinalized(payload)  A provisional event was confirmed (no change needed)
 *   - transcriptUpdated(payload)       Live transcript got more text from the realtime API
 *                                       payload: { delta: string, full: string }
 *   - scoreChanged(payload)            The score changed
 *   - pointChanged(payload)            A new point started or ended
 *
 * Payload shape (eventAdded / eventAmended / eventRetracted):
 *   {
 *     event: <Event object>,            // The game event (Throw, Turnover, etc.)
 *     source: 'narration'|'manual'|'server'|'undo',
 *     provisionalId: string|null,       // Matches provisionalEventAdded id if applicable
 *     previousEvent: <Event|null>       // For eventAmended, the event being replaced
 *   }
 *
 * Usage:
 *   narrationEventBus.subscribe('eventAdded', (p) => { ... });
 *   narrationEventBus.publish('eventAdded', { event, source: 'narration' });
 */

(function() {
    const CHANNELS = [
        'eventAdded',
        'eventAmended',
        'eventRetracted',
        'provisionalEventAdded',
        'provisionalEventFinalized',
        'transcriptUpdated',
        'scoreChanged',
        'pointChanged'
    ];

    const subscribers = {};
    CHANNELS.forEach(c => { subscribers[c] = []; });

    /**
     * Subscribe to a channel.
     * @param {string} channel - One of CHANNELS
     * @param {function} fn - Callback receiving a single payload argument
     * @returns {function} An unsubscribe function
     */
    function subscribe(channel, fn) {
        if (!subscribers[channel]) {
            console.warn(`[eventBus] Unknown channel: ${channel}`);
            return () => {};
        }
        subscribers[channel].push(fn);
        return () => {
            const idx = subscribers[channel].indexOf(fn);
            if (idx >= 0) subscribers[channel].splice(idx, 1);
        };
    }

    /**
     * Publish a payload to a channel. Subscribers are called synchronously
     * in subscription order. Errors in one subscriber do not block others.
     */
    function publish(channel, payload) {
        if (!subscribers[channel]) {
            console.warn(`[eventBus] Unknown channel: ${channel}`);
            return;
        }
        subscribers[channel].forEach(fn => {
            try {
                fn(payload);
            } catch (err) {
                console.error(`[eventBus] Subscriber for ${channel} threw:`, err);
            }
        });
    }

    // Expose globally (no module system in this project)
    window.narrationEventBus = {
        subscribe,
        publish,
        CHANNELS
    };
})();
