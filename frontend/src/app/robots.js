/**
 * The app is not for search engines: the pages here are sign-in forms, invites and pages behind a
 * session.
 */
export default function robots() {
  return { rules: [{ userAgent: "*", disallow: "/" }] };
}
