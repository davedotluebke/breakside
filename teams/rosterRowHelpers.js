/*
 * Shared roster-stat-table row/cell building helpers — the DOM half.
 *
 * Used by rosterManagement.js (renderRosterTable), eventRoster.js and
 * gameSummary.js, which build near-identical Name/Pts/Time/.../+/- rows.
 * *What* goes in those cells is defined once in utils/statsColumns.js (which
 * also owns the shared value formatters); this module only assembles the
 * <tr>/<td> around them. The remaining per-caller differences are the identity
 * columns — a checkbox, gender styling, click handlers — which stay local.
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

// --- ES-module exports; consumed only by other teams/ modules (all converted),
// --- so no window.* shims are needed.
export { appendRosterCell, buildRosterRow };
