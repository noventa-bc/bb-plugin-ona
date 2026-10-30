// Fixtures for semgrep --test. Not compiled, linted or formatted.
// ruleid: child-process-outside-runners
import { spawn } from "node:child_process";
// ruleid: child-process-outside-runners
import { execFile } from "child_process";
// ruleid: child-process-outside-runners
import * as cp from "node:child_process";
// ok: child-process-outside-runners
import { readFile } from "node:fs/promises";

// ruleid: child-process-outside-runners
const legacy = require("node:child_process");

// ok: child-process-outside-runners
const script = String.raw`const { spawn } = require("node:child_process");`;

// ruleid: child-process-outside-runners
const dyn = await import("node:child_process");
void dyn;
