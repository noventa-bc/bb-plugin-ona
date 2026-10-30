// Fixtures for semgrep --test. Not compiled, linted or formatted.
function fixture(bb: any, error: unknown) {
  // ruleid: console-instead-of-bb-log
  console.log("tunnel up");
  // ruleid: console-instead-of-bb-log
  console.error(error);
  // ok: console-instead-of-bb-log
  bb.log.warn(`tunnel failed: ${String(error)}`);
}

// ok: console-instead-of-bb-log
const remote = String.raw`console.log(JSON.stringify({ ok: true }));`;
