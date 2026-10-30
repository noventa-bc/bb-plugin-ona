// Only rules the typechecker can't cover: promises that are dropped or misused
// (a dropped promise that rejects can crash the plugin process inside bb), and
// bb lifecycle calls whose result is ignored.
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
      // bb can accept a lifecycle request without acting on it; use the host it returns.
      "no-restricted-syntax": [
        "error",
        ...[
          "ExpressionStatement > AwaitExpression",
          "ExpressionStatement > UnaryExpression[operator='void']",
          "ExpressionStatement",
        ].map((parent) => ({
          selector: `${parent} > CallExpression[callee.property.name=/^experimental_(suspend|resume|reconcile)$/]`,
          message: "bb can accept this without acting on it: check the returned host's lifecycle (lifecycleRefusal).",
        })),
      ],
    },
  },
);
