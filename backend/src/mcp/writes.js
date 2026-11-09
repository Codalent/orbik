import {
  BRAND_ROOT_PATH,
  LIBRARY_ERROR_CODES,
  LibraryError,
  SOURCE_ROOT_PATH,
  isBrandLayerPath,
  isSourceLayerPath,
  libraryDepth,
  normalizeLibraryPath,
} from "@orbik/library";

/**
 * What the MCP endpoint decides about a Library write before the registry sees it, and nothing
 * else: whether the credential may write at all, whether it has written too much this minute,
 * whether the person may write in the workspace chosen, and whether the path is one an outside
 * client may write to.
 *
 * The paths are this layer's because the store allows a person all of them from the Library page —
 * a person annotates a copied page, files beside the chosen folders, writes under `/brand` — and a
 * person's AI writing for them is held to what Orbik's own agents are held to instead. Everything
 * about what a write must keep, and the locks, is the store's (`@orbik/library`), and the refusals
 * here use the store's codes so a client, the Library page and the run log describe them alike.
 */

/** A call to a write tool from a credential that may only read. */
export const WRITE_NOT_GRANTED = "WRITE_NOT_GRANTED";

/** A write past the credential's ceiling for this minute. */
export const WRITE_RATE_LIMITED = "WRITE_RATE_LIMITED";

/**
 * A write to a workspace where the person's role is read-only. The same code the API answers for an
 * action a role does not allow, so the client, the web app and the log describe it alike.
 */
export const ROLE_INSUFFICIENT = "ROLE_INSUFFICIENT";

/**
 * The refusal a read-only credential's call to a write tool gets, saying how the person would
 * allow writing — which differs between a token they paste and an app they approved.
 *
 * @param {object} session the request's session
 */
export function writeNotGranted(session) {
  return coded(
    WRITE_NOT_GRANTED,
    session.kind === "oauth"
      ? "This connection may only read the Library. To let this app write to it, the person " +
        "connects it to Orbik again and ticks \"Allow this app to write to the Library\" on Orbik's " +
        "consent screen. Say so, and do not retry."
      : "This connection may only read the Library. To let an AI write to it, the person creates a " +
        "token with \"May write to the Library\" ticked, under Connect your AI on the workspace's " +
        "settings page in Orbik, and connects with that token instead. Say so, and do not retry.",
  );
}

/**
 * The refusal a write gets in a workspace where the person is read-only now.
 *
 * A credential is issued `orbik:write` only when its holder may write in every workspace it covers,
 * but a role can be lowered afterwards, and a credential with "all" covers workspaces joined later
 * in whatever role. The scope still lets it write where the role allows; here, it does not.
 *
 * @param {{name: string}} workspace the workspace the write was meant for
 */
export function roleInsufficient(workspace) {
  return coded(
    ROLE_INSUFFICIENT,
    `The person's role in ${workspace.name} is read-only, so nothing can be written to its Library through this ` +
      "connection; reading it still works. An admin of the workspace can make them a member in Orbik. Say so, and do not retry.",
  );
}

/**
 * Counts one write against the credential's ceiling, refusing it once the minute's are spent.
 *
 * Keyed on the credential row — the token, or the approved app's grant — so two people's clients
 * never share one, and an app's access tokens, replaced every hour, count as the one connection
 * they are.
 *
 * @param {{take: (key: string) => Promise<{allowed: boolean, retryAfterSeconds: number}>}} writeLimit
 * @param {object} session the request's session
 */
export async function takeWrite(writeLimit, session) {
  const { allowed, retryAfterSeconds } = await writeLimit.take(String(session.tokenId));
  if (allowed) return;
  const error = coded(
    WRITE_RATE_LIMITED,
    `This connection has written to the Library as often as it may this minute. Try again in ${retryAfterSeconds} ` +
      "seconds, and write fewer, whole files rather than many small ones.",
  );
  error.retryAfterSeconds = retryAfterSeconds;
  throw error;
}

/**
 * Refuses a path an outside client may not write to, with the store's code for it.
 *
 * Nothing at the top level: those folders are the structure the person chose. Nothing under
 * `/sources`, which is a copy of the site kept by code; or `/brand`, which is reserved for the
 * design system. A path that is not a path is the store's `INVALID_PATH`, said here before
 * anything is read.
 *
 * @param {unknown} path the `path` argument of `library_write` or `library_mkdir`
 * @throws an error coded `TOP_LEVEL_PROTECTED`, `RESERVED_PATH` or `INVALID_PATH`
 */
export function refuseReservedPath(path) {
  let target;
  try {
    target = normalizeLibraryPath(path);
  } catch (error) {
    if (error instanceof LibraryError) throw coded(error.code, error.message);
    throw error;
  }
  if (isSourceLayerPath(target)) {
    throw coded(
      LIBRARY_ERROR_CODES.reservedPath,
      `${SOURCE_ROOT_PATH} holds a copy of every page of the site, kept in step with it by code. ` +
        "Read it and cite it, but write in a file of your own inside one of the top-level folders.",
    );
  }
  if (isBrandLayerPath(target)) {
    throw coded(
      LIBRARY_ERROR_CODES.reservedPath,
      `${BRAND_ROOT_PATH} is reserved for the design system, which is corrected on the Brand page in ` +
        "Orbik. Write inside one of the top-level folders instead.",
    );
  }
  if (libraryDepth(target) === 1) {
    throw coded(
      LIBRARY_ERROR_CODES.topLevelProtected,
      `${target} would sit at the top level of the Library, and the top-level folders are the ones ` +
        "the person chose. Write inside one of them — library_tree lists them — and if none fits, " +
        "make a folder inside one with library_mkdir.",
    );
  }
}

/** An error carrying a code the model reads. */
function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
