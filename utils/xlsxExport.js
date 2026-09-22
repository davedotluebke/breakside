/*
 * Excel (.xlsx) writer for export workbooks (utils/exportWorkbook.js), powered
 * by SheetJS (vendored in vendor/xlsx.mini.min.js, a classic script global).
 *
 * Numbers are written as real Excel types (percentages, decimal minutes), and
 * an AutoFilter scoped to the header + player rows gives click-to-sort column
 * dropdowns without dragging the title or the Team total into the sort.
 */

/**
 * Convert one model sheet to a SheetJS worksheet.
 * @param {object} sheet - see utils/exportWorkbook.js
 */
function toWorksheet(sheet) {
    const ws = XLSX.utils.aoa_to_sheet(sheet.rows);
    ws['!cols'] = (sheet.widths || []).map(wch => ({ wch }));
    const range = XLSX.utils.decode_range(ws['!ref']);
    Object.entries(sheet.formats || {}).forEach(([c, fmt]) => {
        const letter = XLSX.utils.encode_col(Number(c));
        for (let R = range.s.r; R <= range.e.r; R++) {
            const cell = ws[`${letter}${R + 1}`];
            if (cell && typeof cell.v === 'number') {
                cell.t = 'n';
                cell.z = fmt === 'pct' ? '0%' : '0.00';
            }
        }
    });
    if (sheet.filter) {
        const f = sheet.filter;
        ws['!autofilter'] = { ref: XLSX.utils.encode_range({ r: f.r0, c: f.c0 }, { r: f.r1, c: f.c1 }) };
    }
    return ws;
}

/**
 * Build the workbook and trigger its download as `<stem>.xlsx`.
 * @param {{stem: string, sheets: Array<object>}} workbook
 */
function downloadXlsx(workbook) {
    const wb = XLSX.utils.book_new();
    workbook.sheets.forEach(sheet => XLSX.utils.book_append_sheet(wb, toWorksheet(sheet), sheet.name));
    XLSX.writeFile(wb, `${workbook.stem}.xlsx`, { compression: true });
}

// --- ES-module exports ---
export { downloadXlsx };
