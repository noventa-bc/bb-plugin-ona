// Fixtures for semgrep --test. Not compiled, linted or formatted.
async function fixture(bb: any, kv: any, envId: string, value: string) {
  // ruleid: secret-in-kv-key
  await bb.storage.kv.set("ona:token", value);
  // ruleid: secret-in-kv-key
  await bb.storage.kv.set(`password:${envId}`, value);
  // ruleid: secret-in-kv-key
  await kv.set("enroll-Secret", value);
  // ok: secret-in-kv-key
  await bb.storage.kv.set("ona:tunnels", [envId]);
  // ok: secret-in-kv-key
  await kv.set(`connected-at:${envId}`, Date.now());
}
