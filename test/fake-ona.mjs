#!/usr/bin/env node
// Stand-in for the ona CLI with state: the environments live in the JSON file
// $FAKE_ONA_ENVIRONMENTS, which create/start/stop/delete/update rewrite.
// `environment get` answers from that file, then $FAKE_ONA_GET, then the real
// CLI's not-found messages. argv is logged to $FAKE_ONA_LOG; $FAKE_ONA_FAIL
// fails every call with that message.
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const { FAKE_ONA_FAIL, FAKE_ONA_LOG, FAKE_ONA_ENVIRONMENTS, FAKE_ONA_GET, FAKE_ONA_PROJECTS } = process.env;
const args = process.argv.slice(2);
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
if (FAKE_ONA_FAIL) fail(FAKE_ONA_FAIL);
if (FAKE_ONA_LOG) appendFileSync(FAKE_ONA_LOG, `${args.join(" ")}\n`);

const [group, verb, ref] = args;
const flag = (name) => args[args.indexOf(name) + 1];
const envs = FAKE_ONA_ENVIRONMENTS ? JSON.parse(readFileSync(FAKE_ONA_ENVIRONMENTS, "utf8")) : [];
const env = envs.find((e) => e.id === ref);
const save = () => writeFileSync(FAKE_ONA_ENVIRONMENTS, `${JSON.stringify(envs, null, 2)}\n`);
const notFound = () => fail("Error: not_found: environment not found");
const setPhase = (phase) => {
  if (!env) notFound();
  env.status = { ...env.status, phase: `ENVIRONMENT_PHASE_${phase}` };
  save();
};

if (group === "project" && verb === "list") {
  console.log(FAKE_ONA_PROJECTS ? readFileSync(FAKE_ONA_PROJECTS, "utf8") : "[]");
} else if (group === "environment") {
  switch (verb) {
    case "list":
      console.log(JSON.stringify(envs));
      break;
    case "get":
      if (env) console.log(JSON.stringify(env));
      else if (FAKE_ONA_GET) console.log(readFileSync(FAKE_ONA_GET, "utf8"));
      // The real CLI's messages for an unknown uuid and for a ref that isn't one (docs/ona-notes.md).
      else if (ref.startsWith("env-")) notFound();
      else
        fail(`Error: no environment found matching "${ref}"\nPossible resolutions:\n  - Run \`ona environment list\``);
      break;
    case "create": {
      // shortcut: ids are env-<count+1>, so a create after a delete can reuse an id; number from a counter if a test needs that
      const created = {
        id: `env-${envs.length + 1}`,
        metadata: { name: flag("--name"), projectId: ref },
        status: { phase: "ENVIRONMENT_PHASE_RUNNING" },
      };
      envs.push(created);
      save();
      console.log(JSON.stringify(created));
      break;
    }
    case "start":
      setPhase("RUNNING");
      break;
    case "stop":
      setPhase("STOPPED");
      break;
    case "delete":
      if (!env) notFound();
      envs.splice(envs.indexOf(env), 1);
      save();
      break;
    case "update":
      if (!env) notFound();
      env.metadata.name = flag("--name");
      save();
      break;
    case "keep-alive": {
      const command = args.slice(args.indexOf("--") + 1);
      process.exit(spawnSync(command[0], command.slice(1), { stdio: "inherit" }).status ?? 1);
    }
  }
}
