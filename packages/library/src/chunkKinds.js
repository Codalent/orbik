import { LIBRARY_SOURCE_KINDS } from "./library.js";

/**
 * The kinds of source the retrieval index holds, named in the Library's own vocabulary.
 *
 * Two of them are Library source kinds and the third is the Library itself, so the names are the
 * Library's to define. They live here rather than in `@orbik/retrieval` because `@orbik/tools`
 * filters a search by them and is deliberately handed the retrieval index rather than depending on
 * it; the API and `@orbik/retrieval` read the same names from here.
 */

/** The special source kind a Library file is indexed under. */
export const LIBRARY_CHUNK_KIND = "library";

/** Every source kind the retrieval index holds. */
export const CHUNK_SOURCE_KINDS = Object.freeze([
  LIBRARY_SOURCE_KINDS.page,
  LIBRARY_CHUNK_KIND,
  LIBRARY_SOURCE_KINDS.document,
]);
