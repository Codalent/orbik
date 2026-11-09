import path from "node:path";
import { fileURLToPath } from "node:url";
import packageJson from "./package.json" with { type: "json" };

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  // The Docker image runs the self-contained server `next build` writes with this, rather than
  // carrying the whole workspace's node_modules. Everywhere else the build is as before.
  ...(process.env.NEXT_OUTPUT === "standalone" ? { output: "standalone" } : {}),
  // The extension slots. In this repository the package is an empty stub; a deployment that adds
  // pages resolves the name to its own package, which may ship JSX, so it is always compiled.
  transpilePackages: ["@orbik/web-extensions"],
  // Avoid disclosing framework details on public frontend responses.
  poweredByHeader: false,
  // A dev server behind a proxy on a public hostname while binding 127.0.0.1 would treat every
  // /_next/* dev-asset request as cross-origin and answer 403. Ignored outside development. Such
  // hosts belong in NEXT_ALLOWED_DEV_ORIGINS in the untracked .env, comma separated, so no
  // deployment's hostname is in the checked-in list.
  allowedDevOrigins: [
    ...(process.env.NEXT_ALLOWED_DEV_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  ],
  // The footer shows which build is running. Reading it from the package manifest at build time
  // keeps the displayed number tied to what was released, with nothing to bump by hand.
  env: { NEXT_PUBLIC_APP_VERSION: packageJson.version },
  // An invite link carries its token in the address, and the sign-in page can carry it in `next`;
  // neither may hand that address to another site as a referrer. The invite page also says so in
  // a meta tag, which covers it however it is served.
  async headers() {
    const noReferrer = [{ key: "Referrer-Policy", value: "no-referrer" }];
    return [
      { source: "/invite/:path*", headers: noReferrer },
      { source: "/login", headers: noReferrer },
    ];
  },
};

export default nextConfig;
