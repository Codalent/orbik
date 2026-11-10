import js from "@eslint/js";
import globals from "globals";

import { boundaryPlugin, boundaryRules } from "./eslint.boundary.mjs";

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/dist/**",
      "**/build/**",
      "frontend/src/components/ui/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["backend/**/*.js", "packages/**/*.js", "agents/**/*.js", "scripts/**/*.js", "scripts/**/*.mjs", "ecosystem.config.cjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-console": "off",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  // The repository's boundary: see eslint.boundary.mjs.
  {
    files: ["backend/**/*.js", "packages/**/*.js", "agents/**/*.js"],
    plugins: { "orbik-boundary": boundaryPlugin },
    rules: boundaryRules,
  },
];
