/**
 * Public surface of `@orbik/core`.
 *
 * The primitives every Orbik process stands on — environment parsing, the MongoDB connection and
 * its physical collection names, the redacting logger, the public-address check, the robots.txt
 * rules the crawler obeys, the URL normaliser every crawl key and every search row is hashed
 * from — plus the few records more than one process reads or writes that no domain package owns:
 * the AI call log,
 * agent setups, the crawl schedule, and the slugs and limits of the agents more than one process
 * has to name.
 *
 * A domain with a package of its own (the Library, the retrieval index, crawl budget, the tools)
 * lives there and depends on this one; nothing here imports from them. Code with a single consumer
 * lives with that consumer. A name is exported only when something outside this package imports
 * it.
 */
export {
  assertValidEnvironment,
  parseBoundedInteger,
  parseMongoUri,
  parseNodeEnv,
  parseUrl,
} from "./env.js";
export { log } from "./logger.js";
export { classifyAddress } from "./net/publicAddress.js";
export { MAX_ROBOTS_BYTES, ROBOTS_SOURCE, createRobotsRules } from "./robots/robots.js";
export { createAiCallLog } from "./ai/callLog.js";
export { closeMongo, connectMongo, isMongoReady } from "./db/mongo.js";
export { toObjectId } from "./db/objectId.js";
export { escapeRegExp } from "./escapeRegExp.js";
export { INVALID_URL, hashUrl, normalizeUrl, tryNormalizeUrl } from "./url/url.js";
export {
  AGENT_COLLECTIONS,
  COLLECTIONS,
  RETIRED_COLLECTIONS,
  getAgentCollections,
  getCollections,
} from "./db/collections.js";
export {
  applyCrawlSchedule,
  effectiveIntervalHours,
  patternIntervalHours,
} from "./crawl/schedule.js";
export { describePageKind } from "./crawl/pageKind.js";
export {
  ON_REQUEST_AGENT_SLUGS,
  UPSTREAM_AGENT_SLUGS,
  createAgentSetupStore,
  isOnRequestAgent,
  isUpstreamAgent,
  normalizeTrackedPages,
  pageLimitsFor,
  scheduleProfileFor,
} from "./agentSetups/store.js";
export {
  KNOWLEDGE_AGENT_SLUG,
  LLMS_LIMITS,
  LLMS_TXT_AGENT_SLUG,
  SOURCE_STATUS,
  SOURCE_STATUS_VALUES,
} from "./knowledge/knowledge.js";
export {
  BRAND_ASSET_KINDS,
  BRAND_ASSET_KIND_VALUES,
  BRAND_ASSET_ORIGINS,
  BRAND_DOCUMENT_KINDS,
  BRAND_IMAGERY_KINDS,
  BRAND_LIMITS,
  BRAND_PRIVATE_KINDS,
  BRAND_UPLOAD_LIMITS,
  DESIGN_SYSTEM_AGENT_SLUG,
} from "./designSystem/designSystem.js";
