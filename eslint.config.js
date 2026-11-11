// Only rules the typechecker can't cover: promises that are dropped or misused
// (a dropped promise that rejects can crash the plugin process inside bb), and
// bb lifecycle calls whose result is ignored.
import tseslint from "typescript-eslint";

export default tseslint.config(
  // .semgrep/ holds Semgrep test fixtures, which break rules on purpose. .claude/ holds agent
  // worktrees, whose sources belong to their own tsconfig.
  { ignores: ["dist/", "node_modules/", ".semgrep/", ".claude/"] },
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
      // A `return promise` inside try skips its catch, so the rule wants `return await` there and nowhere else.
      "@typescript-eslint/return-await": ["error", "in-try-catch"],
      "max-lines": ["error", { max: 500, skipBlankLines: true, skipComments: true }],
      "no-restricted-syntax": [
        "error",
        // bb can accept a lifecycle request without acting on it; use the host it returns. A lifecycle call is discarded
        // when its statement is bare, awaited or void, possibly followed by a chain of calls such as `.catch(...)` or
        // `.catch(...).finally(...)`.
        // shortcut: chains up to four calls deep, add a depth to the list when a deeper chain appears
        ...[0, 1, 2, 3, 4]
          .flatMap((calls) => {
            // A call on the result is `CallExpression > MemberExpression.callee`, as in `x.catch(...)`. `.callee` keeps a
            // member read passed as an argument, as in `track(x.host)`, out of the chain.
            const chain = "CallExpression > MemberExpression.callee > ".repeat(calls);
            const lifecycle = "CallExpression[callee.property.name=/^experimental_(suspend|resume|reconcile)$/]";
            return [
              `ExpressionStatement > ${chain}${lifecycle}`,
              `ExpressionStatement > :matches(AwaitExpression, UnaryExpression[operator='void']) > ${chain}${lifecycle}`,
            ];
          })
          .map((selector) => ({
            selector,
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
