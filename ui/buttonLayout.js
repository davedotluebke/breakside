/*
 * Button Layout
 * Handles UI consistency functions for button sizing and layout
 */

/**
 * Match button widths for consistent UI appearance
 * Makes the undo button match the width of the game log button
 */
function matchButtonWidths() {
    const gameLogBtn = document.getElementById('toggleEventLogBtn');
    const undoBtn = document.getElementById('undoBtn');

    if (gameLogBtn && undoBtn) {
        // Use getComputedStyle for accurate width and height
        const gameLogStyle = window.getComputedStyle(gameLogBtn);
        undoBtn.style.width = gameLogStyle.width;
        undoBtn.style.height = gameLogStyle.height;
        undoBtn.style.lineHeight = gameLogStyle.lineHeight;
        undoBtn.style.fontSize = gameLogStyle.fontSize;
        undoBtn.style.borderRadius = gameLogStyle.borderRadius;
        undoBtn.style.padding = gameLogStyle.padding;
    }
}

/**
 * Initialize button layout on page load
 */
function initializeButtonLayout() {
    // Initial call
    matchButtonWidths();

    // Also call after a short delay to ensure all styles are applied
    setTimeout(matchButtonWidths, 100);
}

// Initialize on DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeButtonLayout);
} else {
    initializeButtonLayout();
}

