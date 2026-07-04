/*
 * Event Log Display
 * Handles event logging and event log UI management
 */
import { isGameScreenVisible } from './panelSystem.js';
import { log } from '../utils/logger.js';

/**
 * Log an event and update the event log display
 * @param {string} description - Description of the event to log
 */
function logEvent(description) {
    log("Event: " + description);
    /* update the running event log on the screen */
    const eventLog = document.getElementById('eventLog');
    if (eventLog) {
        // late-bound back-edge (summarizeGame's owner game/gameLogic.js lives
        // "above" this layer); see ARCHITECTURE.md § ES modules — the window
        // shim at the owner is kept deliberately.
        eventLog.value = window.summarizeGame();    // Replace log with the new game summary
        eventLog.scrollTop = eventLog.scrollHeight; // Auto-scroll to the bottom
    }

    // Also update the new game screen Game Log panel if visible
    // late-bound back-edge (updateGameLogEvents' owner game/gameScreenSync.js
    // lives "above" this layer); owner keeps the shim.
    if (typeof window.updateGameLogEvents === 'function' && typeof isGameScreenVisible === 'function') {
        if (isGameScreenVisible()) {
            window.updateGameLogEvents();
        }
    }
}

/**
 * Initialize event log toggle button
 * Sets up the click handler for showing/hiding the event log
 */
function initializeEventLogToggle() {
    const toggleEventLogBtn = document.getElementById('toggleEventLogBtn');
    if (toggleEventLogBtn) {
        toggleEventLogBtn.addEventListener('click', function() {
            const eventLog = document.getElementById('eventLog');
            if (!eventLog) {
                console.warn('Event log element not found.');
                return;
            }

            if (eventLog.style.display !== 'block') {
                eventLog.style.display = 'block';
                toggleEventLogBtn.classList.add('selected');
            } else {
                eventLog.style.display = 'none';
                toggleEventLogBtn.classList.remove('selected');
            }
        });
    }
}

// Initialize on DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeEventLogToggle);
} else {
    initializeEventLogToggle();
}

// --- ES-module exports ---
export { logEvent };

