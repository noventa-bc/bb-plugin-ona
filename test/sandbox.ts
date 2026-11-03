// The agent sandbox hides other processes from `ps`; tests that need to see them run in CI and outside the sandbox.
export const sandboxed = {
  skip: process.env.NONO_CAP_FILE ? "needs to see other processes, hidden in the agent sandbox" : false,
};
