// Fixtures for semgrep --test. Not compiled, linted or formatted.
async function fixture(run: (argv: string[]) => Promise<string>, envId: string) {
  // ruleid: ona-lifecycle-outside-onacli
  await run(["environment", "start", envId]);
  // ruleid: ona-lifecycle-outside-onacli
  await run(["environment", "stop", envId]);
  // ruleid: ona-lifecycle-outside-onacli
  await run(["--quiet", "environment", "delete", envId]);
  // ruleid: ona-lifecycle-outside-onacli
  await run(["environment", "ssh", envId]);
  // ok: ona-lifecycle-outside-onacli
  await run(["environment", "ssh-config"]);
  // ok: ona-lifecycle-outside-onacli
  await run(["environment", "list", "-o", "json"]);
  // ok: ona-lifecycle-outside-onacli
  await run(["environment", "keep-alive", "--environment-id", envId]);
}
