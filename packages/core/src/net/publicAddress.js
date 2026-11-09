import ipaddr from "ipaddr.js";

/**
 * Says whether an IP address is on the public internet, and which range it falls in.
 *
 * Every server-side guard that decides whether a host may be contacted asks this one question —
 * the crawler before each request, the API before it reads a client's metadata document, and the
 * API again when a workspace names its website by IP address — so they share one rule rather than
 * three that drift apart.
 *
 * The rule is an allow-list: only ordinary `unicast` is public. An IPv4 address written inside
 * IPv6 (`::ffff:127.0.0.1`) is unwrapped first and judged as the IPv4 address it is. Everything
 * else — loopback, private, link-local, multicast, reserved, and the IPv6 translation and
 * tunnelling prefixes (`64:ff9b::/96`, `2002::/16`, Teredo) that can embed an internal IPv4
 * address — is not public, so a range the library learns to name later is refused by default
 * rather than let through because nobody added it to a list. A string that is not an address at
 * all is not public either.
 *
 * Only the verdict lives here. Each caller keeps its own way of finding the address (a DNS lookup,
 * a URL's hostname) and its own error codes and wording.
 *
 * @param {string} address an IPv4 or IPv6 address, as a resolver returned it or a URL spelled it
 * @returns {{ isPublic: boolean, range: string | null }} `range` is ipaddr.js's name for the range,
 *   judged after unwrapping, or null when `address` is not an IP address
 */
export function classifyAddress(address) {
  let range;
  try {
    range = ipaddr.process(address).range();
  } catch {
    return { isPublic: false, range: null };
  }
  return { isPublic: range === "unicast", range };
}
