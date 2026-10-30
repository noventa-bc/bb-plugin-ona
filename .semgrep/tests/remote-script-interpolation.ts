// Fixtures for semgrep --test. Not compiled, linted or formatted.
async function fixture(executor: any, signal: AbortSignal, dir: string, url: string) {
  // ruleid: remote-script-interpolation
  await sshCapture(executor, `mkdir -p ${dir}`, signal);
  // ruleid: remote-script-interpolation
  await sshCapture(executor, `mkdir -p ${shellQuote(dir)} && curl ${url}`, signal);
  // ok: remote-script-interpolation
  await sshCapture(executor, `mkdir -p ${shellQuote(dir)}`, signal);
  // ok: remote-script-interpolation
  await sshCapture(executor, 'mountpoint -q "$HOME"', signal);
  // ok: remote-script-interpolation
  await sshCapture(executor, `true`, signal);
  await executor.exec({
    // ruleid: remote-script-interpolation
    command: ["bash", "-c", `rm -rf ${dir}`],
  });
  await executor.exec({
    // ok: remote-script-interpolation
    command: ["bash", "-c", 'rm -rf "$1"', "bb-ona-fixture", dir],
  });
}
