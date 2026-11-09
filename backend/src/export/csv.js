/**
 * Serving a table as a CSV file a person downloads.
 *
 * The one place the API turns rows into CSV, so every export escapes a cell the same way. An agent
 * that wants an export describes its table — the columns, in order, and the rows — and
 * {@link sendCsv} writes the file; nothing agent-specific belongs here.
 *
 * Two rules decide what a cell looks like:
 *
 * - **RFC 4180.** A cell holding a comma, a double quote or a line break is wrapped in double
 *   quotes with each quote inside doubled, and lines end in CRLF. That is what makes a reason such
 *   as `linked as "our pricing", twice` one cell rather than three.
 * - **A cell is never a formula.** A spreadsheet runs a cell that begins with `=`, `+`, `-`, `@`,
 *   a tab or a carriage return, and the text in an export is partly written by a model from a
 *   website's own words. Such a cell is given a leading apostrophe, which a spreadsheet shows as
 *   text. Numbers are written as numbers: `-1` in a numeric column is not a formula.
 *
 * The file is UTF-8 without a byte-order mark. A mark makes one spreadsheet read accents correctly
 * and puts three stray bytes in front of the first header for every program that imports the file,
 * and a map of redirects is imported more often than it is admired.
 */

/** What a spreadsheet treats as the start of a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;

/** What makes a cell need quoting: a separator, a quote, a line break, or space at either end. */
const NEEDS_QUOTES = /[",\r\n]|^\s|\s$/;

/**
 * One value as a CSV cell.
 *
 * @param {unknown} value a string, a number, a boolean, or nothing
 * @returns {string}
 */
export function csvCell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  let text = String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return NEEDS_QUOTES.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * A table as CSV text: a header line, then one line per row.
 *
 * @param {object} table
 * @param {Array<{key: string, header: string}>} table.columns the columns, in order; `key` names
 *   the row's property and `header` is the cell in the first line
 * @param {object[]} table.rows the rows
 * @returns {string}
 */
export function toCsv({ columns, rows }) {
  const lines = [columns.map((column) => csvCell(column.header)).join(",")];
  for (const row of rows) lines.push(columns.map((column) => csvCell(row[column.key])).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

/** A file name reduced to what is safe inside a quoted header value. */
function safeFilename(name) {
  const cleaned = String(name ?? "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.toLowerCase().endsWith(".csv") ? cleaned : `${cleaned || "export"}.csv`;
}

/**
 * Sends a table as a CSV download.
 *
 * `attachment`, like the llms.txt file: the response is a file to save, whether it was asked for
 * by the web app's export button or by somebody's `curl`.
 *
 * @param {import("express").Response} res the response
 * @param {object} table
 * @param {string} table.filename the name the file is saved under
 * @param {Array<{key: string, header: string}>} table.columns the columns, in order
 * @param {object[]} table.rows the rows
 */
export function sendCsv(res, { filename, columns, rows }) {
  res.type("text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${safeFilename(filename)}"`);
  res.send(toCsv({ columns, rows }));
}
