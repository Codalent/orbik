import path from "node:path";
import { pathToFileURL } from "node:url";

import { log as defaultLog } from "@orbik/core";

import { PROCESSES, createExtensionHost } from "./host.js";

/** The process-wide host: the one `loadExtensions` built, or the open-source default. */
let active = null;

/**
 * The extensions this process loaded at startup.
 *
 * A process loads its extensions once, before it serves or claims anything, so code deep inside
 * the crawler or the call log reads limits from here rather than having a host threaded through
 * every constructor between `worker.js` and the place a page is charged. A script that never calls
 * `loadExtensions` gets the open-source default: unlimited, and nothing listening.
 */
export function activeExtensions() {
  if (!active) active = createExtensionHost({ processName: null });
  return active;
}

/**
 * Splits `ORBIK_EXTENSIONS` into module specifiers.
 *
 * @param {string | string[] | undefined} value comma-separated, or already a list
 */
export function parseExtensionList(value) {
  const entries = Array.isArray(value) ? value : String(value ?? "").split(",");
  return entries.map((entry) => entry.trim()).filter(Boolean);
}

/**
 * Imports and registers the extensions a process is configured with, then makes the result the
 * process-wide host.
 *
 * Each entry of `ORBIK_EXTENSIONS` is a package name, resolved the way any import is — from this
 * package upward, so in a workspace that lists the extension as a dependency of its root it is
 * found — or a path, resolved against the process's working directory. Its default export (or the
 * module itself) must be `{ name, register(host) }`.
 *
 * Any failure stops the process. A deployment configured with an extension that enforces its
 * plans must not come up without it and quietly serve everything unlimited.
 *
 * @param {object} options
 * @param {"api"|"worker"|"scheduler"|"script"} options.processName which process this is
 * @param {string|string[]} [options.specifiers] usually `process.env.ORBIK_EXTENSIONS`
 * @param {import("mongodb").Db} [options.database] handed to each extension
 * @param {object} [options.config] the process's parsed configuration, handed to each extension
 * @param {Function} [options.logger]
 * @param {string} [options.cwd] what a path entry is relative to
 * @returns {Promise<ReturnType<typeof createExtensionHost>>}
 */
export async function loadExtensions({
  processName,
  specifiers,
  database = null,
  config = null,
  logger = defaultLog,
  cwd = process.cwd(),
}) {
  if (!PROCESSES.includes(processName)) throw new Error(`Unknown process ${processName}.`);
  const host = createExtensionHost({ processName, logger });
  for (const specifier of parseExtensionList(specifiers)) {
    let extension;
    try {
      const module = await import(importTarget(specifier, cwd));
      extension = module.default ?? module;
    } catch (error) {
      throw new Error(`Extension ${specifier} could not be imported: ${error.message}`, { cause: error });
    }
    if (typeof extension?.name !== "string" || !extension.name || typeof extension.register !== "function") {
      throw new Error(`Extension ${specifier} must export { name, register(host) }.`);
    }
    try {
      await host.register(extension, { database, config });
    } catch (error) {
      throw new Error(`Extension ${extension.name} failed to register in the ${processName} process: ${error.message}`, { cause: error });
    }
  }
  if (host.extensions.length) logger("info", "extensions.loaded", { process: processName, extensions: host.extensions });
  active = host;
  return host;
}

/** A path or file URL as a URL to import; a package name as it is. */
function importTarget(specifier, cwd) {
  if (specifier.startsWith("file:")) return specifier;
  if (specifier.startsWith(".") || path.isAbsolute(specifier)) {
    return pathToFileURL(path.resolve(cwd, specifier)).href;
  }
  return specifier;
}
