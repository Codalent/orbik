import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The boundary of the open-source repository, as a lint rule: nothing in `backend/`, `agents/`,
 * `frontend/` or `packages/` may import from outside this repository. Code that is not in it — a
 * deployment's plans, billing, enterprise features — reaches core only through the extension
 * loader (`ORBIK_EXTENSIONS`, imported by a computed specifier that no rule sees) and the
 * `@orbik/web-extensions` slot package. The written rule beside it: core must start and serve
 * every page with no extension loaded.
 *
 * Shared by the root ESLint config and the web app's own.
 */
export const REPOSITORY_ROOT = path.dirname(fileURLToPath(import.meta.url));

/** The `@orbik/*` names this repository defines; any other `@orbik/` name is from elsewhere. */
const OWN_PACKAGES = new Set(
  readdirSync(path.join(REPOSITORY_ROOT, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      try {
        return JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, "packages", entry.name, "package.json"), "utf8")).name;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .concat(["@orbik/agents"]),
);

/** Package names that are never core's to import, whatever they resolve to. */
export const OUTSIDE_PACKAGES = ["orbik-cloud", "orbik-cloud/*", "@orbik-cloud/*", "@orbik/cloud", "@orbik/cloud-*"];
const OUTSIDE_PACKAGE = /^(?:orbik-cloud(?:\/|$)|@orbik-cloud\/|@orbik\/cloud(?:-|\/|$))/;

const stayInsideRepository = {
  meta: {
    type: "problem",
    docs: { description: "Disallow imports that reach outside the open-source repository." },
    schema: [],
    messages: {
      outsidePath: "'{{source}}' resolves outside this repository. Core reaches other code only through ORBIK_EXTENSIONS and @orbik/web-extensions.",
      unknownPackage: "'{{source}}' is not a package of this repository. Core reaches other code only through ORBIK_EXTENSIONS and @orbik/web-extensions.",
      privatePackage: "'{{source}}' is a deployment's private package. Core reaches it only through ORBIK_EXTENSIONS and @orbik/web-extensions.",
    },
  },
  create(context) {
    const file = context.filename ?? context.getFilename();
    // `dynamic`: an import() or require(), which no-restricted-imports does not look at, so this
    // rule also refuses the private package names there.
    function check(node, source, dynamic = false) {
      if (typeof source !== "string") return;
      if (dynamic && OUTSIDE_PACKAGE.test(source)) {
        context.report({ node, messageId: "privatePackage", data: { source } });
        return;
      }
      if (source.startsWith(".") || source.startsWith("/") || source.startsWith("file:")) {
        const target = source.startsWith("file:")
          ? fileURLToPath(source)
          : path.resolve(path.dirname(file), source);
        const relative = path.relative(REPOSITORY_ROOT, target);
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
          context.report({ node, messageId: "outsidePath", data: { source } });
        }
        return;
      }
      const scoped = /^@orbik\/[^/]+/.exec(source)?.[0];
      if (scoped && !OWN_PACKAGES.has(scoped)) {
        context.report({ node, messageId: "unknownPackage", data: { source } });
      }
    }
    const literal = (node) => (node?.type === "Literal" ? node.value : undefined);
    return {
      ImportDeclaration: (node) => check(node.source, node.source.value),
      ExportNamedDeclaration: (node) => node.source && check(node.source, node.source.value),
      ExportAllDeclaration: (node) => check(node.source, node.source.value),
      ImportExpression: (node) => check(node.source, literal(node.source), true),
      CallExpression(node) {
        if (node.callee.type === "Identifier" && node.callee.name === "require" && node.arguments.length === 1) {
          check(node.arguments[0], literal(node.arguments[0]), true);
        }
      },
    };
  },
};

/** The plugin and the two rules, ready to spread into a flat config entry. */
export const boundaryPlugin = { rules: { "stay-inside-repository": stayInsideRepository } };
export const boundaryRules = {
  "orbik-boundary/stay-inside-repository": "error",
  "no-restricted-imports": ["error", {
    patterns: [{
      group: OUTSIDE_PACKAGES,
      message: "Core never imports a deployment's private packages; they attach through ORBIK_EXTENSIONS and @orbik/web-extensions.",
    }],
  }],
};
