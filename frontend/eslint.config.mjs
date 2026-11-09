import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

import { boundaryPlugin, boundaryRules } from "../eslint.boundary.mjs";

const eslintConfig = defineConfig([
  ...nextVitals,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "src/components/ui/**",
  ]),
  // The repository's boundary: see ../eslint.boundary.mjs.
  {
    files: ["src/**/*.{js,jsx,mjs}"],
    plugins: { "orbik-boundary": boundaryPlugin },
    rules: boundaryRules,
  },
]);

export default eslintConfig;
