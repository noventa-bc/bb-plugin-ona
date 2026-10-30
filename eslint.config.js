// Only rules the typechecker can't cover: promises that are dropped or misused.
// A dropped promise that rejects can crash the plugin process inside bb.
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/"] },
  {
    files: ["**/*.ts", "**/*.tsx"],
    extends: [tseslint.configs.base],
    languageOptions: { parserOptions: { projectService: true } },
    rules: {
      "@typescript-eslint/no-floating-promises": [
        "error",
        // node:test tracks the promises its own test() calls return.
        { allowForKnownSafeCalls: [{ from: "package", package: "node:test", name: ["test", "before", "after"] }] },
      ],
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
);
