import { ObjectId } from "mongodb";

/**
 * Converts an identifier that has already been validated to a MongoDB ObjectId, passing an
 * ObjectId through unchanged.
 *
 * For identifiers a route validator or a job payload check has already vouched for: an invalid
 * string throws, as `new ObjectId` does, rather than quietly matching nothing.
 *
 * @param {ObjectId | string} value a validated identifier
 * @returns {ObjectId}
 */
export function toObjectId(value) {
  return value instanceof ObjectId ? value : new ObjectId(value);
}
