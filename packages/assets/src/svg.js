/**
 * Removes from an SVG everything that could run.
 *
 * A stored SVG is served back by the API and handed to other people's tools, so it must be a
 * picture and nothing else: no script, no event handler, no embedded HTML, no link that executes,
 * no animation that sets one. The API also serves every asset under a policy that forbids all of
 * those, so this is the second lock rather than the only one.
 *
 * It is here rather than in either process because both store SVGs: the worker the ones it finds
 * on a site, the API the ones a person uploads.
 *
 * @param {string|Buffer} source the SVG's text
 * @returns {string} the same picture with nothing in it that runs
 */
export function sanitiseSvg(source) {
  return String(source)
    .replace(/<script[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<script[^>]*\/>/gi, "")
    .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, "")
    .replace(/<(set|animate)\b[^>]*\battributeName\s*=\s*["']?(?:xlink:)?href[^>]*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s(?:xlink:)?href\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*'|\s*javascript:[^\s>]*)/gi, "");
}

/** Whether some bytes are an SVG document, by what they say rather than what they are called. */
export function looksLikeSvg(bytes) {
  return /^\s*(\uFEFF)?(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(Buffer.from(bytes).subarray(0, 2000).toString("utf8"));
}
