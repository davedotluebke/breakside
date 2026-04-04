/*
 * Table Sort Controller
 * Reusable utility for adding click-to-sort behavior to any <table>.
 * Supports stable multi-column sorting — sort by column A, then B, and
 * ties in B retain A's ordering naturally.
 *
 * Usage:
 *   const ctrl = createTableSortController({ ... });
 *   ctrl.attach();   // adds click handlers to headers
 *   ctrl.detach();   // removes them (call before re-render)
 */

/**
 * Extract a sortable value from a table cell.
 * @param {HTMLTableRowElement} row
 * @param {number} colIndex - 0-based column index
 * @param {string} type - 'number' | 'string' | 'checkbox' | 'time' | 'percentage'
 * @returns {*} value suitable for comparison
 */
function getValueFromCell(row, colIndex, type) {
    const cell = row.children[colIndex];
    if (!cell) return null;

    switch (type) {
        case 'checkbox': {
            const cb = cell.querySelector('input[type="checkbox"]');
            // No checkbox (e.g. pickup players) treated as checked
            return cb ? (cb.checked ? 1 : 0) : 1;
        }
        case 'number': {
            const text = cell.textContent.trim().replace('+', '');
            const num = parseFloat(text);
            return isNaN(num) ? -Infinity : num;
        }
        case 'time': {
            const text = cell.textContent.trim();
            const parts = text.split(':');
            if (parts.length === 2) {
                return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
            }
            return 0;
        }
        case 'percentage': {
            const text = cell.textContent.trim().replace('%', '');
            if (text === '-') return -Infinity;
            const num = parseFloat(text);
            return isNaN(num) ? -Infinity : num;
        }
        case 'string':
            return cell.textContent.trim().toLowerCase();
        default:
            return cell.textContent.trim();
    }
}

/**
 * Create a sort controller for a table.
 *
 * @param {object} options
 * @param {function(): HTMLTableRowElement} options.getHeaderRow - returns the header <tr>
 * @param {function(): HTMLTableRowElement[]} options.getDataRows - returns sortable rows
 * @param {function(): HTMLTableRowElement[]} options.getAggregateRows - rows that stay at bottom
 * @param {function(): HTMLElement} options.getTbody - the container to reorder within
 * @param {Array<{key: string, type: string, colIndex: number}>} options.columns - column descriptors
 * @returns {object} controller with attach/detach/sort/getSortState/applySort
 */
function createTableSortController(options) {
    const { getHeaderRow, getDataRows, getAggregateRows, getTbody, columns } = options;

    let sortKey = null;
    let sortDirection = null; // 'asc' | 'desc' | null
    let originalOrder = [];   // snapshot of data row order at attach time
    let clickHandlers = [];   // [{ th, handler }] for cleanup

    /**
     * Compare two values for sorting.
     */
    function compare(a, b, type) {
        if (type === 'string') {
            return (a || '').localeCompare(b || '');
        }
        // Numeric comparison (works for number, checkbox, time, percentage)
        return (a === b) ? 0 : (a < b ? -1 : 1);
    }

    /**
     * Reorder DOM rows based on current sort state.
     */
    function reorderRows() {
        const tbody = getTbody();
        if (!tbody) return;

        const headerRow = getHeaderRow();
        const dataRows = sortKey === null ? [...originalOrder] : getDataRows();
        const aggRows = getAggregateRows();

        if (sortKey !== null && sortDirection !== null) {
            const col = columns.find(c => c.key === sortKey);
            if (col) {
                dataRows.sort((rowA, rowB) => {
                    const a = getValueFromCell(rowA, col.colIndex, col.type);
                    const b = getValueFromCell(rowB, col.colIndex, col.type);
                    const cmp = compare(a, b, col.type);
                    return sortDirection === 'desc' ? -cmp : cmp;
                });
            }
        }

        // Re-append in order (appendChild moves existing nodes)
        if (headerRow) tbody.appendChild(headerRow);
        dataRows.forEach(row => tbody.appendChild(row));
        aggRows.forEach(row => tbody.appendChild(row));
    }

    /**
     * Update CSS classes and aria attributes on header cells.
     */
    function updateIndicators() {
        const headerRow = getHeaderRow();
        if (!headerRow) return;

        columns.forEach(col => {
            const th = headerRow.children[col.colIndex];
            if (!th) return;
            th.classList.remove('sorted-asc', 'sorted-desc');
            th.setAttribute('aria-sort', 'none');
        });

        if (sortKey && sortDirection) {
            const col = columns.find(c => c.key === sortKey);
            if (col) {
                const th = headerRow.children[col.colIndex];
                if (th) {
                    th.classList.add(sortDirection === 'asc' ? 'sorted-asc' : 'sorted-desc');
                    th.setAttribute('aria-sort', sortDirection === 'asc' ? 'ascending' : 'descending');
                }
            }
        }
    }

    /**
     * Handle a header click — cycle through default → opposite → clear.
     * Default direction is 'desc' for most columns, 'asc' for string columns.
     */
    function onHeaderClick(key) {
        const col = columns.find(c => c.key === key);
        const defaultDir = (col && col.type === 'string') ? 'asc' : 'desc';
        const oppositeDir = defaultDir === 'asc' ? 'desc' : 'asc';

        if (sortKey === key) {
            if (sortDirection === defaultDir) {
                sortDirection = oppositeDir;
            } else {
                sortKey = null;
                sortDirection = null;
            }
        } else {
            sortKey = key;
            sortDirection = defaultDir;
        }

        reorderRows();
        updateIndicators();
    }

    return {
        /**
         * Attach click handlers and CSS to header cells. Snapshots original row order.
         */
        attach() {
            originalOrder = [...getDataRows()];

            const headerRow = getHeaderRow();
            if (!headerRow) return;

            columns.forEach(col => {
                const th = headerRow.children[col.colIndex];
                if (!th) return;

                th.classList.add('sortable-header');
                th.setAttribute('role', 'button');
                th.setAttribute('aria-sort', 'none');

                const handler = () => onHeaderClick(col.key);
                th.addEventListener('click', handler);
                clickHandlers.push({ th, handler });
            });
        },

        /**
         * Remove click handlers and CSS classes.
         */
        detach() {
            clickHandlers.forEach(({ th, handler }) => {
                th.removeEventListener('click', handler);
                th.classList.remove('sortable-header', 'sorted-asc', 'sorted-desc');
                th.removeAttribute('role');
                th.removeAttribute('aria-sort');
            });
            clickHandlers = [];
            originalOrder = [];
        },

        /**
         * Programmatically set the sort.
         * @param {string} key - column key
         * @param {string|null} direction - 'asc', 'desc', or null to clear
         */
        sort(key, direction) {
            sortKey = direction ? key : null;
            sortDirection = direction || null;
            reorderRows();
            updateIndicators();
        },

        /**
         * Get current sort state.
         * @returns {{ key: string, direction: string }|null}
         */
        getSortState() {
            if (!sortKey || !sortDirection) return null;
            return { key: sortKey, direction: sortDirection };
        },

        /**
         * Re-apply current sort to the DOM (call after rows change without full re-render).
         */
        applySort() {
            originalOrder = [...getDataRows()];
            if (sortKey && sortDirection) {
                reorderRows();
            }
            updateIndicators();
        }
    };
}

window.createTableSortController = createTableSortController;
