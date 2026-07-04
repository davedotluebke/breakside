/*
 * Shared roster-stat-table row/cell building helpers.
 *
 * Used by rosterManagement.js (renderRosterTable) and eventRoster.js
 * (createEventRosterPlayerRow) — renderers that build near-identical
 * Name/Pts/Time/Goals/Assists/Comp%/Ds/TOs/+/- rows with subtly different
 * formatting per caller (dash vs em-dash for "no data", "0.0" vs "0.00" for
 * zero-points +/-per-point, etc). This module extracts only the parts that
 * were genuinely identical across the callers; the per-caller formatting
 * quirks are preserved as-is at each call site rather than unified, to avoid
 * changing what's displayed.
 */

/**
 * Append one <td> to a roster row.
 * @param {HTMLTableRowElement} row
 * @param {Object} cell
 * @param {string|number} [cell.value] - text content (ignored if cell.element is set)
 * @param {HTMLElement} [cell.element] - a pre-built child element (e.g. a checkbox <input>)
 * @param {string|string[]} [cell.className]
 * @param {Function} [cell.onClick]
 * @param {Object} [cell.style] - inline style properties to assign to the <td>
 * @returns {HTMLTableCellElement}
 */
function appendRosterCell(row, cell) {
    const td = document.createElement('td');
    if (cell.className) {
        const classes = Array.isArray(cell.className) ? cell.className : [cell.className];
        td.classList.add(...classes);
    }
    if (cell.style) {
        Object.assign(td.style, cell.style);
    }
    if (cell.element) {
        td.appendChild(cell.element);
    } else {
        td.textContent = cell.value;
    }
    if (cell.onClick) {
        td.addEventListener('click', cell.onClick);
    }
    row.appendChild(td);
    return td;
}

/**
 * Build a roster-table <tr> from an ordered list of cell specs (see appendRosterCell).
 * @param {Array<Object>} cells
 * @returns {HTMLTableRowElement}
 */
function buildRosterRow(cells) {
    const row = document.createElement('tr');
    cells.forEach(cell => appendRosterCell(row, cell));
    return row;
}

/** "+3" / "0" / "-2" — leading "+" for positive values, used by every +/- column. */
function formatSigned(value) {
    return value > 0 ? `+${value}` : `${value}`;
}

/** Same as formatSigned, but for values that need a fixed decimal count (e.g. per-point +/-). */
function formatSignedFixed(value, digits) {
    const fixed = value.toFixed(digits);
    return value > 0 ? `+${fixed}` : fixed;
}

/** "67%" when attempts were made, otherwise `dash`. Shared Comp%/Huck% formatting. */
function formatPercentOrDash(made, attempted, dash = '-') {
    return attempted > 0 ? `${((made / attempted) * 100).toFixed(0)}%` : dash;
}

// --- ES-module exports; consumed only by other teams/ modules (all converted),
// --- so no window.* shims are needed.
export {
    appendRosterCell, buildRosterRow,
    formatSigned, formatSignedFixed, formatPercentOrDash,
};
