#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "child_process";

const MAX_LINES = 2000;
const KILL_TIMEOUT_MS = 5000;
const DEFAULT_BUILD_TIMEOUT = 120_000;
const DEFAULT_RECOMPILE_TIMEOUT = 60_000;
const IDLE_START_TIMEOUT = 10_000;

const processes = new Map();
const trackers = new Map();

function cleanupChildProcesses() {
  for (const [name, proc] of processes) {
    console.error(`[live-console] Cleaning up "${name}" (PID: ${proc.process?.pid || 'exited'})`);
    if (proc.process) {
      try { proc.process.kill("SIGTERM"); } catch {}
    }
  }
}

process.on("SIGTERM", () => { cleanupChildProcesses(); process.exit(0); });
process.on("SIGINT", () => { cleanupChildProcesses(); process.exit(0); });
process.on("SIGHUP", () => { cleanupChildProcesses(); process.exit(0); });
process.on("exit", cleanupChildProcesses);

const PATTERNS = {
  buildStart: [
    /Starting compilation in watch mode/,
    /File change detected\. Starting/,
    /Changes detected\. Rebuilding/,
    /> Building/,
  ],
  buildSuccess: [
    /Found 0 errors\. Watching for file changes/,
    /Page reload sent to client/,
    /Application bundle generation complete/,
  ],
  buildFailure: [
    /Found [1-9]\d* errors\. Watching for file changes/,
    /Application bundle generation failed/,
  ],
  fullStartup: [
    /Nest application successfully started/,
    /➜\s+Local:/,
  ],
};

function matchAny(line, patterns) {
  return patterns.some(p => p.test(line));
}

function getTracker(name) {
  if (!trackers.has(name)) {
    trackers.set(name, {
      state: "idle",
      lastBuild: null,
      fullStartupDone: false,
      currentBuildStart: null,
      errors: [],
      warnings: [],
      idleTimer: null,
      endWaiters: [],
      startWaiters: [],
    });
  }
  return trackers.get(name);
}

function resetTrackerBuild(tracker) {
  tracker.currentBuildStart = Date.now();
  tracker.errors = [];
  tracker.warnings = [];
}

function finalizeBuild(tracker, status, output) {
  const duration = tracker.currentBuildStart ? Date.now() - tracker.currentBuildStart : 0;
  const build = {
    status,
    duration_ms: duration,
    finishedAt: new Date().toISOString(),
    errors: tracker.errors.slice(),
    warnings: tracker.warnings.slice(),
    output,
  };
  tracker.lastBuild = build;
  tracker.state = status;
  tracker.currentBuildStart = null;

  for (const w of tracker.endWaiters) {
    clearTimeout(w.timer);
    w.resolve(build);
  }
  tracker.endWaiters = [];

  if (tracker.idleTimer) {
    clearTimeout(tracker.idleTimer);
    tracker.idleTimer = null;
  }
}

function rejectStartWaiters(tracker, reason) {
  for (const w of tracker.startWaiters) {
    clearTimeout(w.timer);
    w.resolve(null);
  }
  tracker.startWaiters = [];
}

function processLine(name, line) {
  const tracker = getTracker(name);

  if (tracker.state === "idle" || tracker.state === "success" || tracker.state === "failure") {
    if (matchAny(line, PATTERNS.buildStart)) {
      resetTrackerBuild(tracker);
      tracker.state = "building";
      rejectStartWaiters(tracker, "started");
      return;
    }
    if (matchAny(line, PATTERNS.fullStartup)) {
      tracker.fullStartupDone = true;
    }
    return;
  }

  if (tracker.state === "building") {
    if (matchAny(line, PATTERNS.buildSuccess)) {
      finalizeBuild(tracker, "success", line);
      return;
    }
    if (matchAny(line, PATTERNS.buildFailure)) {
      finalizeBuild(tracker, "failure", line);
      return;
    }

    const errMatch = line.match(/^(.+\.ts):(\d+):(\d+) - error TS(\d+): (.+)/);
    if (errMatch) {
      tracker.errors.push({
        file: `${errMatch[1]}:${errMatch[2]}:${errMatch[3]}`,
        code: `TS${errMatch[4]}`,
        message: errMatch[5],
      });
      return;
    }

    if (/X \[ERROR\]/.test(line)) {
      tracker.errors.push({
        file: null,
        code: null,
        message: line.replace(/^X \[ERROR\]\s*/, "").trim(),
      });
      return;
    }

    const warnMatch = line.match(/▲ \[WARNING\]\s*(NG\d+):\s*(.+?)(?:\s+\[plugin|\s*$)/);
    if (warnMatch) {
      tracker.warnings.push({
        code: warnMatch[1],
        message: warnMatch[2].trim(),
        file: null,
      });
      return;
    }
  }
}

function addOutput(proc, name, lines) {
  for (const line of lines) {
    proc.buffer.push(line);
    if (proc.buffer.length > MAX_LINES) {
      proc.buffer.shift();
    }
    processLine(name, line);
  }
}

function spawnProcess(name, cwd, runner, cmd) {
  const fullCmd = `${runner} ${cmd}`;
  console.error(`[live-console] Starting: ${fullCmd} in ${cwd}`);

  const child = spawn(fullCmd, [], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
    windowsHide: true,
  });

  const proc = {
    process: child,
    buffer: [],
    status: "running",
    cwd,
    runner,
    cmd,
    fullCmd,
    pid: child.pid,
  };

  const tracker = getTracker(name);
  tracker.state = "idle";
  tracker.fullStartupDone = false;
  tracker.lastBuild = null;

  child.stdout.on("data", (data) => {
    const lines = data.toString().split("\n").filter(l => l !== "");
    addOutput(proc, name, lines);
  });

  child.stderr.on("data", (data) => {
    const lines = data.toString().split("\n").filter(l => l !== "");
    addOutput(proc, name, lines.map(l => `[stderr] ${l}`));
  });

  child.on("exit", (code, signal) => {
    console.error(`[live-console] "${name}" exited with code ${code}, signal ${signal}`);
    addOutput(proc, name, [`[live-console] Process exited with code ${code}`]);
    proc.status = "exited";
    proc.exitCode = code;
    proc.process = null;
    const t = getTracker(name);
    t.state = "exited";
    rejectStartWaiters(t, "exited");
    for (const w of t.endWaiters) {
      clearTimeout(w.timer);
      w.resolve({ status: "exited", duration_ms: 0, finishedAt: new Date().toISOString(), errors: [], warnings: [], output: "Process exited" });
    }
    t.endWaiters = [];
  });

  child.on("error", (err) => {
    console.error(`[live-console] "${name}" error: ${err.message}`);
    addOutput(proc, name, [`[live-console] Error: ${err.message}`]);
    proc.status = "error";
    proc.process = null;
  });

  processes.set(name, proc);
  return proc;
}

function stopProcess(name) {
  const proc = processes.get(name);
  if (!proc || !proc.process) return false;

  try {
    proc.process.kill("SIGTERM");
    setTimeout(() => {
      if (proc.process && !proc.process.killed) {
        try { proc.process.kill("SIGKILL"); } catch {}
      }
    }, KILL_TIMEOUT_MS);
  } catch {
    try { proc.process.kill("SIGKILL"); } catch {}
  }

  proc.status = "stopped";
  return true;
}

function waitForEvent(name, timeoutMs, mode) {
  return new Promise((resolve) => {
    const proc = processes.get(name);
    if (!proc) {
      resolve(null);
      return;
    }
    const tracker = getTracker(name);

    const timer = setTimeout(() => {
      if (mode === "end") {
        tracker.endWaiters = tracker.endWaiters.filter(w => w.resolve !== resolve);
      } else {
        tracker.startWaiters = tracker.startWaiters.filter(w => w.resolve !== resolve);
      }
      resolve({ status: "timeout", duration_ms: Date.now() - (tracker.currentBuildStart || Date.now()), finishedAt: new Date().toISOString(), errors: tracker.errors.slice(), warnings: tracker.warnings.slice(), output: "" });
    }, timeoutMs);

    if (mode === "end") {
      tracker.endWaiters.push({ resolve, timer });
    } else {
      tracker.startWaiters.push({ resolve, timer });
    }
  });
}

function getBuildOutput(name) {
  const proc = processes.get(name);
  if (!proc) return "";
  const tracker = getTracker(name);

  if (tracker.currentBuildStart && tracker.lastBuild) {
    const linesSince = proc.buffer.filter((l, i) => i >= (proc.buffer.length - tracker.lastBuild.output.length));
    return linesSince.join("\n");
  }
  return proc.buffer.slice(-30).join("\n");
}

const server = new Server(
  { name: "live-console", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "start_dev",
      description: `Start a dev server process in background.
The agent provides:
- name: unique identifier for this server
- cwd: working directory (absolute path)
- cmd: the command to run WITHOUT the runner (e.g. "run start:dev", "ng serve", "run dev")
- runner: optional, defaults to "pnpm". Use "npm", "yarn", "bun", "npx", etc.

Examples:
  start_dev({ name: "nest", cwd: "/project/server", cmd: "run start:dev" })
  start_dev({ name: "angular", cwd: "/project/client", cmd: "ng serve", runner: "npx" })`,
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Unique identifier for this server" },
          cwd: { type: "string", description: "Absolute path to the working directory" },
          cmd: { type: "string", description: "Command to run (without runner, e.g. 'run start:dev')" },
          runner: { type: "string", description: "Package runner (default: pnpm). Options: pnpm, npm, yarn, bun, npx" },
        },
        required: ["name", "cwd", "cmd"],
      },
    },
    {
      name: "dev_output",
      description: "Get recent output from a running dev server.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Server identifier" },
          lines: { type: "number", description: "Number of recent lines (default: all, max: 2000)" },
          clear: { type: "boolean", description: "Clear buffer after reading (default: false)" },
        },
        required: ["name"],
      },
    },
    {
      name: "stop_dev",
      description: "Stop a running dev server (SIGTERM → SIGKILL after 5s).",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Server identifier" },
        },
        required: ["name"],
      },
    },
    {
      name: "restart_dev",
      description: "Restart a dev server. Uses the same cwd, runner, and cmd from the original start.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Server identifier" },
        },
      },
    },
    {
      name: "dev_status",
      description: "Get detailed status of one or all dev servers including build state and last build result.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Server identifier (optional — omit for all)" },
        },
      },
    },
    {
      name: "wait_for_recompile",
      description: `Wait for a recompilation cycle to complete after code changes.
Blocks until the dev server detects changes, compiles, and produces a result.
Returns structured build result with errors and warnings.

Use this AFTER making code changes to verify compilation quickly.

NestJS detects: "Found 0/N errors. Watching for file changes"
Angular detects: "Page reload sent to client(s)" or "Application bundle generation failed"`,
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Server identifier" },
          timeout: { type: "number", description: "Max wait time in seconds (default: 60)" },
        },
        required: ["name"],
      },
    },
    {
      name: "wait_for_build",
      description: `Wait for the initial build (or a fresh build cycle) to complete.
Use this after starting a dev server to wait for full startup.

Options:
- mode: "compile" (default) — waits for compilation result only (fast)
- mode: "full" — waits for full app startup (Nest application started / Angular Local URL)`,
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Server identifier" },
          timeout: { type: "number", description: "Max wait time in seconds (default: 120)" },
          mode: { type: "string", description: '"compile" (default) or "full"' },
        },
        required: ["name"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "start_dev": {
      const { name: serverName, cwd, cmd, runner } = args;
      const actualRunner = runner || "pnpm";

      if (processes.has(serverName)) {
        const existing = processes.get(serverName);
        if (existing.status === "running") {
          return {
            content: [{
              type: "text",
              text: `⚠️ Server "${serverName}" is already running:

  PID:  ${existing.process?.pid}
  CWD:  ${existing.cwd}
  Cmd:  ${existing.runner} ${existing.cmd}
  Status: dev_status("${serverName}")

Use restart_dev("${serverName}") to restart it, or stop_dev("${serverName}") first.`,
            }],
            isError: true,
          };
        }
        processes.delete(serverName);
        trackers.delete(serverName);
      }

      try {
        const proc = spawnProcess(serverName, cwd, actualRunner, cmd);
        return {
          content: [{
            type: "text",
            text: `Started "${serverName}"\n  Runner: ${actualRunner}\n  Command: ${cmd}\n  CWD: ${cwd}\n  PID: ${proc.pid}`,
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to start "${serverName}": ${err.message}` }],
          isError: true,
        };
      }
    }

    case "dev_output": {
      const { name: serverName, lines, clear } = args;
      const proc = processes.get(serverName);
      if (!proc) {
        return {
          content: [{ type: "text", text: `No server found with name "${serverName}". Use start_dev first or check dev_status.` }],
          isError: true,
        };
      }

      const count = lines ? Math.min(lines, proc.buffer.length) : proc.buffer.length;
      const output = proc.buffer.slice(-count).join("\n") || "[No output yet]";

      if (clear) proc.buffer = [];

      return {
        content: [{ type: "text", text: output }],
      };
    }

    case "stop_dev": {
      const { name: serverName } = args;
      const proc = processes.get(serverName);

      if (!proc) {
        return {
          content: [{ type: "text", text: `No server found with name "${serverName}".` }],
        };
      }

      if (!proc.process) {
        return {
          content: [{ type: "text", text: `"${serverName}" is already stopped (status: ${proc.status}).` }],
        };
      }

      stopProcess(serverName);
      return {
        content: [{ type: "text", text: `Stopped "${serverName}".` }],
      };
    }

    case "restart_dev": {
      const { name: serverName } = args;
      const proc = processes.get(serverName);

      if (!proc) {
        return {
          content: [{ type: "text", text: `No server found with name "${serverName}". Use start_dev first.` }],
          isError: true,
        };
      }

      stopProcess(serverName);
      processes.delete(serverName);
      trackers.delete(serverName);

      const newProc = spawnProcess(serverName, proc.cwd, proc.runner, proc.cmd);
      return {
        content: [{
          type: "text",
          text: `Restarted "${serverName}"\n  Runner: ${newProc.runner}\n  Command: ${newProc.cmd}\n  CWD: ${newProc.cwd}\n  PID: ${newProc.pid}`,
        }],
      };
    }

    case "dev_status": {
      const { name: serverName } = args || {};
      if (serverName) {
        const proc = processes.get(serverName);
        if (!proc) {
          return {
            content: [{ type: "text", text: JSON.stringify({ name: serverName, status: "not_found" }, null, 2) }],
          };
        }
        const tracker = getTracker(serverName);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              name: serverName,
              status: proc.status,
              pid: proc.process?.pid || null,
              exitCode: proc.exitCode ?? null,
              bufferSize: proc.buffer.length,
              cwd: proc.cwd,
              runner: proc.runner,
              cmd: proc.cmd,
              build: {
                state: tracker.state,
                fullStartupDone: tracker.fullStartupDone,
                lastBuild: tracker.lastBuild,
              },
            }, null, 2),
          }],
        };
      }

      const all = {};
      for (const [key, proc] of processes) {
        const tracker = getTracker(key);
        all[key] = {
          status: proc.status,
          pid: proc.process?.pid || null,
          exitCode: proc.exitCode ?? null,
          bufferSize: proc.buffer.length,
          build: {
            state: tracker.state,
            fullStartupDone: tracker.fullStartupDone,
            lastBuild: tracker.lastBuild ? {
              status: tracker.lastBuild.status,
              duration_ms: tracker.lastBuild.duration_ms,
              finishedAt: tracker.lastBuild.finishedAt,
              errors: tracker.lastBuild.errors.length,
              warnings: tracker.lastBuild.warnings.length,
            } : null,
          },
        };
      }
      return {
        content: [{
          type: "text",
          text: Object.keys(all).length
            ? JSON.stringify(all, null, 2)
            : "No servers running.",
        }],
      };
    }

    case "wait_for_recompile": {
      const { name: serverName, timeout } = args;
      const timeoutMs = (timeout || DEFAULT_RECOMPILE_TIMEOUT / 1000) * 1000;
      const proc = processes.get(serverName);

      if (!proc) {
        return {
          content: [{ type: "text", text: JSON.stringify({ status: "error", message: `No server "${serverName}"` }) }],
          isError: true,
        };
      }

      const tracker = getTracker(serverName);

      if (tracker.state === "success" || tracker.state === "failure") {
        return {
          content: [{ type: "text", text: JSON.stringify(tracker.lastBuild, null, 2) }],
        };
      }

      if (tracker.state === "building") {
        const result = await waitForEvent(serverName, timeoutMs, "end");
        if (!result) {
          return { content: [{ type: "text", text: JSON.stringify({ status: "error", message: "Server not found" }) }], isError: true };
        }
        if (result.status === "timeout" && tracker.lastBuild) {
          return { content: [{ type: "text", text: JSON.stringify(tracker.lastBuild, null, 2) }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      if (tracker.state === "idle") {
        const startPromise = waitForEvent(serverName, IDLE_START_TIMEOUT, "start");
        const startResult = await startPromise;

        if (startResult === null) {
          return { content: [{ type: "text", text: JSON.stringify({ status: "error", message: "Server not found" }) }], isError: true };
        }

        if (startResult.status === "timeout") {
          if (tracker.lastBuild) {
            return { content: [{ type: "text", text: JSON.stringify(tracker.lastBuild, null, 2) }] };
          }
          return { content: [{ type: "text", text: JSON.stringify({ status: "idle", message: "No recompilation detected within timeout. Server is idle.", lastBuild: tracker.lastBuild }, null, 2) }] };
        }

        const endResult = await waitForEvent(serverName, timeoutMs, "end");
        if (!endResult) {
          return { content: [{ type: "text", text: JSON.stringify({ status: "error", message: "Server not found" }) }], isError: true };
        }
        if (endResult.status === "timeout" && tracker.lastBuild) {
          return { content: [{ type: "text", text: JSON.stringify(tracker.lastBuild, null, 2) }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(endResult, null, 2) }] };
      }

      return { content: [{ type: "text", text: JSON.stringify({ status: tracker.state, lastBuild: tracker.lastBuild }, null, 2) }] };
    }

    case "wait_for_build": {
      const { name: serverName, timeout, mode } = args;
      const timeoutMs = (timeout || DEFAULT_BUILD_TIMEOUT / 1000) * 1000;
      const buildMode = mode || "compile";
      const proc = processes.get(serverName);

      if (!proc) {
        return {
          content: [{ type: "text", text: JSON.stringify({ status: "error", message: `No server "${serverName}"` }) }],
          isError: true,
        };
      }

      const tracker = getTracker(serverName);

      if (buildMode === "full" && tracker.fullStartupDone) {
        return { content: [{ type: "text", text: JSON.stringify({ status: "success", message: "Server already fully started", ...tracker.lastBuild }, null, 2) }] };
      }

      if (buildMode === "full") {
        const waitMs = Math.min(timeoutMs, 120_000);
        await new Promise(resolve => {
          const check = () => {
            if (tracker.fullStartupDone || tracker.state === "exited") { resolve(); return; }
            setTimeout(check, 200);
          };
          setTimeout(resolve, waitMs);
          check();
        });

        if (!tracker.fullStartupDone) {
          return { content: [{ type: "text", text: JSON.stringify({ status: "timeout", message: "Full startup not detected within timeout", lastBuild: tracker.lastBuild }, null, 2) }] };
        }
        return { content: [{ type: "text", text: JSON.stringify({ status: "success", message: "Full startup complete", ...tracker.lastBuild }, null, 2) }] };
      }

      if (tracker.lastBuild) {
        return { content: [{ type: "text", text: JSON.stringify({ status: tracker.lastBuild.status, ...tracker.lastBuild }, null, 2) }] };
      }

      if (tracker.state === "building") {
        const result = await waitForEvent(serverName, timeoutMs, "end");
        if (!result) {
          return { content: [{ type: "text", text: JSON.stringify({ status: "error", message: "Server not found" }) }], isError: true };
        }
        if (result.status === "timeout" && tracker.lastBuild) {
          return { content: [{ type: "text", text: JSON.stringify(tracker.lastBuild, null, 2) }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      const startRes = await waitForEvent(serverName, 30_000, "start");
      if (!startRes || startRes.status === "timeout") {
        return { content: [{ type: "text", text: JSON.stringify({ status: "timeout", message: "Build not started within timeout" }, null, 2) }] };
      }
      const endRes = await waitForEvent(serverName, timeoutMs, "end");
      if (!endRes) {
        return { content: [{ type: "text", text: JSON.stringify({ status: "error", message: "Server not found" }) }], isError: true };
      }
      if (endRes.status === "timeout" && tracker.lastBuild) {
        return { content: [{ type: "text", text: JSON.stringify(tracker.lastBuild, null, 2) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(endRes, null, 2) }] };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
