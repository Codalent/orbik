import { z } from "zod";
import ipaddr from "ipaddr.js";

const unsafeIpRanges = new Set(["unspecified", "broadcast", "multicast", "linkLocal", "loopback", "private", "reserved", "uniqueLocal", "carrierGradeNat"]);

/** Canonicalizes and validates a workspace name for immediate form feedback. */
function canonicalizeWorkspaceName(value) {
  const name = value.trim().normalize("NFC");
  const characters = [...name];
  if (characters.length < 1) throw new Error("Workspace name is required.");
  if (characters.length > 80) throw new Error("Workspace name must not exceed 80 characters.");
  if (characters.some((character) => {
    const code = character.codePointAt(0);
    return code <= 31 || (code >= 127 && code <= 159);
  })) {
    throw new Error("Workspace name contains unsupported characters.");
  }
  return name;
}

/** Canonicalizes public HTTP(S) URLs while blocking obvious local/private targets. */
export function canonicalizePublicUrl(value) {
  const input = value.trim();
  let url;
  try { url = new URL(input); } catch { throw new Error("Enter a complete public website URL."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Enter a complete public HTTP or HTTPS URL without credentials.");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const privateAddress = ipaddr.isValid(host) && unsafeIpRanges.has(ipaddr.parse(host).range());
  const localName = host === "localhost" || /\.(?:localhost|local|internal|home|lan)$/iu.test(host);
  if (!host || localName || (!host.includes(".") && !ipaddr.isValid(host)) || privateAddress) {
    throw new Error("Enter a complete public website URL.");
  }
  const canonical = url.toString();
  if (canonical.length > 2048) throw new Error("Website URL must not exceed 2048 characters.");
  return canonical;
}

/**
 * A website as people type it: `example.com` and `www.example.com` mean `https://` there. Input
 * that names a scheme is left as it is, and anything that is not a host still fails the check
 * that follows (`canonicalizePublicUrl`). The API does the same with a workspace's website.
 */
export function withAssumedScheme(value) {
  const input = String(value ?? "").trim();
  if (!input || /^[a-z][a-z0-9+.-]*:\/\//i.test(input)) return input;
  return `https://${input.replace(/^\/\//, "")}`;
}

const WEBSITE_HINT = "Enter your website's public address, such as example.com.";

/**
 * A workspace's website, as the create wizard takes it: a full URL or a bare host. Separate from
 * {@link workspaceUrlSchema}, which the crawl's start address uses and which wants a full URL.
 */
const websiteUrlSchema = z.string().trim().min(1, "Website URL is required.").transform((value, context) => {
  try { return canonicalizePublicUrl(withAssumedScheme(value)); } catch (error) {
    context.addIssue({ code: "custom", message: error.message === "Enter a complete public website URL." ? WEBSITE_HINT : error.message });
    return z.NEVER;
  }
});

/** Workspace-name form schema with canonical output. */
const workspaceNameSchema = z.string().transform((value, context) => {
  try { return canonicalizeWorkspaceName(value); } catch (error) {
    context.addIssue({ code: "custom", message: error.message });
    return z.NEVER;
  }
});

/** Website-URL form schema with canonical public URL output. */
export const workspaceUrlSchema = z.string().min(1, "Website URL is required.").transform((value, context) => {
  try { return canonicalizePublicUrl(value); } catch (error) {
    context.addIssue({ code: "custom", message: error.message });
    return z.NEVER;
  }
});

/** Completion schema that mirrors all API workspace fields. */
/** Exact completion payload schema; unknown browser fields are rejected. */
export const workspaceSchema = z.object({ name: workspaceNameSchema, websiteUrl: websiteUrlSchema }).strict();
