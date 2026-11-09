/**
 * Public surface of `@orbik/library`.
 *
 * The Library's domain code: what a path is and where the bounds are, the source layer and which
 * of its pages the knowledge base is written from, the blocks a person wrote that an agent must
 * keep, where citations come from, and the one store that the API (for people) and the tools (for
 * agents) both write through. Rules that two writers
 * must share belong here; how either writer is reached — HTTP, a tool call — does not.
 *
 * A name is exported only when something outside this package imports it; the rest stay
 * importable by relative path from inside.
 */
export {
  LIBRARY_ERROR_CODES,
  LIBRARY_FILE_ROLES,
  LIBRARY_LIMITS,
  LIBRARY_NODE_KINDS,
  LIBRARY_NODE_KIND_VALUES,
  LIBRARY_RESERVED_PATHS,
  LIBRARY_ROLES,
  LIBRARY_ROOT_PATH,
  LIBRARY_SOURCE_KINDS,
  LIBRARY_SOURCE_KIND_VALUES,
  LIBRARY_WRITE_CHANNELS,
  LibraryError,
  libraryDepth,
  librarySegmentOf,
  normalizeLibraryPath,
} from "./library.js";
export { USER_BLOCK_OPEN, diffMarkdownBlocks, keepUserWriting, markUserBlocks } from "./blocks.js";
export { BRAND_ROOT_PATH, BRAND_WRITER_SLUG, isBrandLayerPath } from "./brand.js";
export { createCrawlSourceProvider } from "./sources.js";
export { createLibraryStore } from "./store.js";
export {
  SOURCE_FIXED_SKIPS,
  SOURCE_LAYER_WRITER_SLUG,
  SOURCE_ROOT_PATH,
  SOURCE_SELECTION_SLUG,
  SOURCE_WEBSITE_PATH,
  isSourceLayerPath,
  sourceMirrorVerdict,
  sourcePageFolders,
  sourcePagePath,
} from "./sourceLayer.js";
export { indexExclusionOf, loadPageExclusions, noindexPageKeys } from "./pageExclusions.js";
export { SYNTHESIS_PAGE_CEILING, chooseSynthesisPages, siteWidePages } from "./selection.js";
export { LIBRARY_STANDARD_FOLDER_NAMES, describeStandardFolders } from "./vocabulary.js";
export {
  DEFAULT_LIBRARY_STRUCTURE,
  STRUCTURE_LIMITS,
  describeDefaultStructure,
  libraryStructureState,
  normalizeLibraryStructure,
} from "./structure.js";
export { CHUNK_SOURCE_KINDS, LIBRARY_CHUNK_KIND } from "./chunkKinds.js";
