# live-console

MCP server for [OpenCode](https://opencode.ai) that manages dev server processes in background and provides structured build feedback to the AI agent.

> **Optimizado para NestJS y Angular.** Funciona con cualquier dev server de Node.js, pero los patrones de detección de compilación están afinados para estos dos frameworks.

## Features

- **Background process management** — start, stop, restart dev servers
- **Structured build results** — `wait_for_recompile` blocks until rebuild finishes and returns `{status, errors[], warnings[], duration_ms}`
- **Pattern-based build tracking** — detects compilation cycles for NestJS and Angular automatically
- **Error/warning extraction** — parses TypeScript errors (`TS####`) and Angular warnings (`NG####`)
- **Auto-cleanup** — child processes are killed when OpenCode closes or the MCP server terminates
- **Duplicate detection** — alerts when trying to start an already-running server
- **Self-documenting** — `get_usage_guide` tool returns the full usage guide to the AI agent

## Tools

| Tool | Description |
|---|---|
| `start_dev` | Start a dev server in background |
| `dev_output` | Get recent output from a server |
| `stop_dev` | Stop a running server |
| `restart_dev` | Restart a server with same params |
| `dev_status` | Detailed status + last build info |
| `wait_for_recompile` | Block until recompilation completes |
| `wait_for_build` | Block until initial build or full startup |
| `get_usage_guide` | Returns full usage guide to the AI agent |

## Installation

### 1. Clone the repo

```bash
git clone https://github.com/rey9606/live-console.git ~/.config/opencode/MCP/live-console
cd ~/.config/opencode/MCP/live-console
npm install
```

### 2. Add to `opencode.json`

Global (`~/.config/opencode/opencode.json`) or per-project:

```json
{
  "mcp": {
    "live-console": {
      "type": "local",
      "command": ["node", "~/.config/opencode/MCP/live-console/index.mjs"],
      "enabled": true
    }
  }
}
```

### 3. Restart OpenCode

The tools will appear with the `live-console_` prefix.

## Usage

### Start a server and wait for full startup

```javascript
start_dev({
  name: "nest-server",
  cwd: "/path/to/nest-project",
  cmd: "run start:dev"
})

wait_for_build({ name: "nest-server", mode: "full", timeout: 120 })
```

### After code changes, verify compilation

```javascript
// Agent edits files...
wait_for_recompile({ name: "nest-server", timeout: 30 })
// → { status: "success", duration_ms: 800, errors: [], warnings: [...], output: "Found 0 errors..." }
```

### Handle compilation errors

```javascript
wait_for_recompile({ name: "nest-server" })
// → { status: "failure", duration_ms: 400,
//     errors: [{ file: "src/app.module.ts:79:1", code: "TS2304", message: "Cannot find name 'asdsd'." }],
//     warnings: [] }
```

### Check server status

```javascript
dev_status()
// → { "nest-server": { status: "running", build: { state: "idle", lastBuild: { status: "success", ... } } } }
```

### Raw output (debug)

```javascript
dev_output({ name: "nest-server", lines: 20 })
```

## Build detection patterns

| Framework | Build Start | Build Result | Full Startup |
|---|---|---|---|
| **NestJS** | `Starting compilation in watch mode...` / `File change detected...` | `Found 0/N errors. Watching for file changes.` | `Nest application successfully started` |
| **Angular** | `Changes detected. Rebuilding...` / `> Building...` | `Page reload sent to client(s).` / `Application bundle generation failed.` | `➜  Local: http://...` |

## Supported frameworks

Actualmente optimizado para **NestJS** y **Angular** (los patrones de build start/end/full startup están ajustados para estos dos). Funciona con cualquier dev server de Node.js, pero la detección de ciclos de compilación puede no capturar todos los casos en otros frameworks.

## Requirements

- Node.js 18+
- OpenCode with MCP support
- `@modelcontextprotocol/sdk` (installed via `npm install`)
