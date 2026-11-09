/**
 * Hands a piece of text to the browser as a file to save.
 *
 * The API is on another origin and authenticates with the session cookie, so a download is a
 * credentialed fetch followed by this, rather than a link the browser follows on its own: the text
 * is already in hand, and a failed request can be reported on the page instead of opening a tab
 * of JSON.
 *
 * @param {object} file
 * @param {string} file.filename the name the file is saved under
 * @param {string} file.text the file's contents
 * @param {string} [file.type] its media type
 */
export function saveTextFile({ filename, text, type = "text/plain;charset=utf-8" }) {
  const href = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  anchor.click();
  // Revoked after the click has been handled, not in the same tick: some browsers start the
  // download asynchronously and would find the address already gone.
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}
