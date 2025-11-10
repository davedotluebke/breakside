/*
 * Event Log Display
 * Handles event logging and event log UI management
 */

/**
 * Log an event and update the event log display
 * @param {string} description - Description of the event to log
 */
function logEvent(description) {
    console.log("Event: " + description);
    /* update the running event log on the screen */
    const eventLog = document.getElementById('eventLog');
    if (eventLog) {
        eventLog.value = summarizeGame();           // Replace log with the new game summary
        eventLog.scrollTop = eventLog.scrollHeight; // Auto-scroll to the bottom
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

