# live-console

MCP server for [OpenCode](https://opencode.ai) that manages dev server processes in background and provides structured build feedback to the AI agent.

> **Optimizado para NestJS y Angular.** Funciona con cualquier dev server de Node.js, pero los patrones de detección de compilación están afinados para estos dos frameworks.

## Features

- **Background process management** — start, stop, restart dev servers
- **Structured build results** — `watch` blocks until rebuild finishes and returns `{status, errors[], warnings[], duration_ms}`
- **Pattern-based build tracking** — detects compilation cycles for NestJS and Angular automatically
- **Error/warning extraction** — parses TypeScript errors (`TS####`) and Angular warnings (`NG####`)
- **Auto-cleanup** — child processes are killed when OpenCode closes or the MCP server terminates
- **Duplicate detection** — alerts when trying to start an already-running server
- **Script validation** — `start_dev` validates cmd against `package.json`, rejects one-shot builds with suggestions
- **Self-documenting errors** — validation errors include the full usage guide inline

## Tools

| Tool | Description |
|---|---|
| `start_dev` | Start a dev server in background (rejects one-shot builds) |
| `watch` | Get compilation result or raw output. Auto-detects state |
| `stop_dev` | Stop a running server |
| `restart_dev` | Restart a server with same params |
| `dev_status` | Detailed status + last build info |
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
start_dev({ name: "nest", cwd: "/project/nest", cmd: "run start:dev" })
watch({ name: "nest", startup: true, timeout: 120 })
```

### After code changes, verify compilation

```javascript
// Agent edits files...
watch({ name: "nest", timeout: 30 })
// → { status: "success", duration_ms: 800, errors: [], warnings: [...], output: "Found 0 errors..." }
```

### Handle compilation errors

```javascript
watch({ name: "nest" })
// → { status: "failure", duration_ms: 400,
//     errors: [{ file: "src/app.module.ts:79:1", code: "TS2304", message: "Cannot find name 'asdsd'." }],
//     warnings: [] }
```

### Raw output (debug, non-blocking)

```javascript
watch({ name: "nest", lines: 20 })
```

### Check server status

```javascript
dev_status()
// → { "nest": { status: "running", build: { state: "idle", lastBuild: { status: "success", ... } } } }
```

### What NOT to do (start_dev rejects these)

```javascript
start_dev({ name: "x", cmd: "build" })        // ❌ one-shot build
start_dev({ name: "x", cmd: "ng build --prod" }) // ❌ not a package.json script
start_dev({ name: "x", cmd: "test" })          // ❌ one-shot test
```

Use bash directly for one-shot commands:

```bash
pnpm build
pnpm test
pnpm lint
```

## watch() behaviour

| Call | What it does |
|---|---|
| `watch({name:"angular"})` | Compilation result (waits if building, returns last if idle) |
| `watch({name:"angular", startup:true})` | Waits for full app startup (Nest/Angular URL) |
| `watch({name:"angular", lines:20})` | Last 20 lines raw output (non-blocking) |
| `watch({name:"angular", lines:20, clear:true})` | Same + clears buffer |

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
