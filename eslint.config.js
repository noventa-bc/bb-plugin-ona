// Only rules the typechecker can't cover: promises that are dropped or misused
// (a dropped promise that rejects can crash the plugin process inside bb), and
// bb lifecycle calls whose result is ignored.
import tseslint from "typescript-eslint";

export default tseslint.config(
  // .semgrep/ holds Semgrep test fixtures, which break rules on purpose.
  { ignores: ["dist/", "node_modules/", ".semgrep/"] },
  {
    // test/*.mjs is the fake ona CLI; shellcheck no longer covers it, this does.
    files: ["**/*.ts", "**/*.tsx", "test/*.mjs"],
    extends: [tseslint.configs.base],
    languageOptions: { parserOptions: { projectService: { allowDefaultProject: ["test/*.mjs"] } } },
    rules: {
      "@typescript-eslint/no-floating-promises": [
        "error",
        // node:test tracks the promises its own test() calls return.
        { allowForKnownSafeCalls: [{ from: "package", package: "node:test", name: ["test", "before", "after"] }] },
      ],
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-deprecated": "error",
      "@typescript-eslint/no-shadow": "error",
      "@typescript-eslint/use-unknown-in-catch-callback-variable": "error",
      "@typescript-eslint/prefer-promise-reject-errors": "error",
      "@typescript-eslint/only-throw-error": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "max-lines": ["error", { max: 500, skipBlankLines: true, skipComments: true }],
      "no-restricted-syntax": [
        "error",
        // bb can accept a lifecycle request without acting on it; use the host it returns.
        ...[
          "ExpressionStatement > AwaitExpression",
          "ExpressionStatement > UnaryExpression[operator='void']",
          "ExpressionStatement",
        ].map((parent) => ({
          selector: `${parent} > CallExpression[callee.property.name=/^experimental_(suspend|resume|reconcile)$/]`,
          message: "bb can accept this without acting on it: check the returned host's lifecycle (lifecycleRefusal).",
        })),
        {
          // A reset right after an aborted fake sleep breaks the next test's timers on CI's Node
          // (test/fake-clock.ts). `mock.reset()` resets the clock too.
          selector:
            "CallExpression[callee.property.name='reset']:matches([callee.object.name=/^(mock|timers)$/], [callee.object.property.name=/^(mock|timers)$/])",
          message:
            "Reset the fake clock with await resetFakeClock() from test/fake-clock.ts (stubs: mock.restoreAll()).",
        },
      ],
    },
  },
  {
    // Dead `??`, `?.` and always-true checks hide a type that drifted from the code. Tests and
    // app.tsx are left out: fakes and UI props are loose on purpose.
    files: ["src/**/*.ts", "server.ts"],
    rules: { "@typescript-eslint/no-unnecessary-condition": "error" },
  },
);
