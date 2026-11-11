// Setup shared by the offline end-to-end files (e2e*.test.ts): the real
// server.ts in the SDK's fake bb host with the fake `ona` and fake `ssh`, a
// loopback `/health` server for the tunnel probe, and the temp dir the fakes
// write their state and call log to.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakePluginHost, type CreateFakePluginHostOptions } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

export type Env = { id: string; metadata: { name?: string }; status: { phase: string; content?: unknown } };
export type E2eHost = Awaited<ReturnType<typeof startHost>>;

// The agent sandbox blocks localhost; the e2e files run in CI and outside the sandbox.
export const local = { skip: process.env.NONO_CAP_FILE ? "needs local ports, blocked in the agent sandbox" : false };
/** Provider call context; a test that asserts on checkpoints overrides `checkpoint`. */
export const ctx = {
  report: { step() {}, log() {} },
  signal: new AbortController().signal,
  checkpoint: async (_resource: unknown) => {},
};
const here = (name: string) => fileURLToPath(new URL(name, import.meta.url));
const FAKE_ENV = ["FAKE_ONA_ENVIRONMENTS", "FAKE_ONA_LOG", "FAKE_ONA_PROJECTS", "FAKE_SSH_HOME", "FAKE_SSH_LOG"];

export async function startHost(
  options: Pick<CreateFakePluginHostOptions, "sdk" | "machineBootstrap" | "machineResource">,
) {
  const dir = mkdtempSync(join(tmpdir(), "bb-ona-e2e-"));
  const state = join(dir, "environments.json");
  const log = join(dir, "ona.log");
  writeFileSync(state, "[]");
  writeFileSync(log, "");
  process.env.FAKE_ONA_ENVIRONMENTS = state;
  process.env.FAKE_ONA_LOG = log;
  process.env.FAKE_ONA_PROJECTS = here("./fixtures/ona/projects.json");
  const sshLog = join(dir, "ssh.log");
  writeFileSync(sshLog, "");
  process.env.FAKE_SSH_LOG = sshLog;
  process.env.FAKE_SSH_HOME = dir;
  const health = http.createServer((req, res) => res.writeHead(req.url === "/health" ? 200 : 404).end());
  await new Promise<void>((resolve) => health.listen(0, "127.0.0.1", resolve));
  const host = createFakePluginHost({
    ...options,
    pluginId: "ona",
    loopbackBaseUrl: `http://127.0.0.1:${(health.address() as AddressInfo).port}`,
    settings: {
      onaPath: here("./fake-ona.mjs"),
      sshPath: here("./fake-ssh.sh"),
      waitForSharedHome: false,
      machineDataDir: "",
      codexSqliteHome: "",
    },
  });
  await plugin(host.bb);
  const provider = host.harness.registrations.machineProviders.get("ona")!;
  const envs = (): Env[] => JSON.parse(readFileSync(state, "utf8")) as Env[];
  const patchBox = (envId: string, patch: Partial<Env["status"]>) =>
    writeFileSync(
      state,
      JSON.stringify(envs().map((e) => (e.id === envId ? { ...e, status: { ...e.status, ...patch } } : e))),
    );
  /**
   * `ona` calls since the last read, without the `--timeout` and `-o json` every
   * call carries. `environment list` calls are dropped (a `get` is kept): the
   * tunnel loop runs one in the background at a time of its own choosing. A
   * scenario that counts them reads the log itself (test/e2e-tunnel.test.ts).
   */
  const onaCalls = () => {
    const lines = readFileSync(log, "utf8").split("\n");
    writeFileSync(log, "");
    return lines
      .map((line) => line.replace(/ -o json| --timeout \d+s/g, ""))
      .filter((line) => line !== "environment list" && line !== "");
  };
  /**
   * `ssh` calls since the last read. A tunnel's `ssh -N` is left out: the tunnel
   * loop opens one whenever a box is connected, at its own pace.
   */
  const sshCalls = () => {
    const lines = readFileSync(sshLog, "utf8").split("\n");
    writeFileSync(sshLog, "");
    return lines.filter((line) => line !== "" && !line.split(" ").includes("-N"));
  };
  /** Pids of every tunnel the fake started so far, running or not (test/fake-ssh.sh writes them). */
  const tunnelPids = (): number[] => {
    const file = join(dir, "tunnel-pids");
    return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number) : [];
  };
  const close = async () => {
    await host.harness.lifecycle.dispose();
    health.close();
    rmSync(dir, { recursive: true, force: true });
    for (const key of FAKE_ENV) delete process.env[key];
  };
  return { host, provider, dir, state, log, envs, patchBox, onaCalls, sshCalls, tunnelPids, close };
}
