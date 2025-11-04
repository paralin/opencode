## IMPORTANT

- Try to keep things in one function unless composable or reusable
- DO NOT do unnecessary destructuring of variables
- DO NOT use `else` statements unless necessary
- DO NOT use `try`/`catch` if it can be avoided
- AVOID `try`/`catch` where possible
- AVOID `else` statements
- AVOID using `any` type
- AVOID `let` statements
- PREFER single word variable names where possible
- Use as many bun apis as possible like Bun.file()

## Debugging

- To test opencode in the `packages/opencode` directory you can run `bun dev`

## Tool Calling

- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE. Here is an example illustrating how to execute 3 parallel file reads in this chat environment:

json
{
"recipient_name": "multi_tool_use.parallel",
"parameters": {
"tool_uses": [
{
"recipient_name": "functions.read",
"parameters": {
"filePath": "path/to/file.tsx"
}
},
{
"recipient_name": "functions.read",
"parameters": {
"filePath": "path/to/file.ts"
}
},
{
"recipient_name": "functions.read",
"parameters": {
"filePath": "path/to/file.md"
}
}
]
}
}
},
{
"recipient_name": "functions.read",
"parameters": {
"filePath": "path/to/file.ts"
}
},
{
"recipient_name": "functions.read",
"parameters": {
"filePath": "path/to/file.md"
}
}
]
}
}

# OpenCode Package Specific Guidelines

## Build/Test Commands

- **Install**: `bun install`
- **Run**: `bun run index.ts`
- **Typecheck**: `bun run typecheck` (npm run typecheck)
- **Test**: `bun test` (runs all tests)
- **Single test**: `bun test test/tool/tool.test.ts` (specific test file)

## Code Style

- **Runtime**: Bun with TypeScript ESM modules
- **Imports**: Use relative imports for local modules, named imports preferred
- **Types**: Zod schemas for validation, TypeScript interfaces for structure
- **Naming**: camelCase for variables/functions, PascalCase for classes/namespaces
- **Error handling**: Use Result patterns, avoid throwing exceptions in tools
- **File structure**: Namespace-based organization (e.g., `Tool.define()`, `Session.create()`)

## Architecture

- **Tools**: Implement `Tool.Info` interface with `execute()` method
- **Context**: Pass `sessionID` in tool context, use `App.provide()` for DI
- **Validation**: All inputs validated with Zod schemas
- **Logging**: Use `Log.create({ service: "name" })` pattern
- **Storage**: Use `Storage` namespace for persistence
- **API Client**: Go TUI communicates with TypeScript server via stainless SDK. When adding/modifying server endpoints in `packages/opencode/src/server/server.ts`, ask the user to generate a new client SDK to proceed with client-side changes.

## TUI Command System

The TUI has a dual command system for session interactions:

1. **Command Dialog** (`src/cli/cmd/tui/component/dialog-command.tsx`):
   - Global command palette accessible via keybind (default: `ctrl+shift+p`)
   - Commands registered via `command.register()` in route components
   - Each command has: `title`, `value` (unique ID), `keybind`, `category`, `onSelect` handler
   - Commands can be triggered programmatically via `command.trigger("command.value")`

2. **Slash Commands** (`src/cli/cmd/tui/component/prompt/autocomplete.tsx`):
   - Autocomplete suggestions when typing `/` in the prompt
   - Most slash commands map directly to command dialog entries via `command.trigger()`
   - Custom commands (from `src/command/`) are also exposed as slash commands
   - Pattern: Add autocomplete entry that calls `command.trigger("session.action")`

**Adding a new session command**:

1. Register command in session route's `command.register()` callback (lines ~170-470 in `src/cli/cmd/tui/routes/session/index.tsx`)
2. Add corresponding slash command entry in autocomplete (lines ~202-240 in `src/cli/cmd/tui/component/prompt/autocomplete.tsx`)
3. Add keybind to config if needed (`src/config/config.ts`)
4. Implement handler logic in `onSelect` callback (typically calls SDK client methods)

**Example Pattern**:

```typescript
// In session route
command.register(() => [{
  title: "Export session",
  value: "session.export",
  keybind: "session_export",
  category: "Session",
  onSelect: (dialog) => {
    // Implementation here
    dialog.clear()
  }
}])

// In autocomplete
{
  display: "/export",
  description: "export session transcript",
  onSelect: () => command.trigger("session.export")
}
```

## CLI Commands

Standalone CLI commands are defined in `src/cli/cmd/*.ts` using the `cmd()` helper:

- Use `yargs` for command definition and argument parsing
- Must call `bootstrap(cwd, callback)` to initialize app context
- Access session data via `Session` namespace methods: `Session.get()`, `Session.list()`, `Session.messages()`
- Use `@clack/prompts` for interactive CLI prompts
- Use `UI` namespace for error handling (`UI.error()`, `UI.CancelledError`)

**Pattern**:

```typescript
export const MyCommand = cmd({
  command: "mycommand [arg]",
  describe: "description",
  builder: (yargs) => yargs.positional("arg", {...}),
  handler: async (args) => {
    const cwd = args.dir ? path.resolve(args.dir) : process.cwd()
    await bootstrap(cwd, async () => {
      // Implementation with full app context
    })
  }
})
```

## TUI-Server Communication

The TUI (Go-based UI) communicates with the TypeScript server via an auto-generated SDK client:

- Server endpoints defined in `src/server/server.ts` using `hono-openapi` and `describeRoute()`
- TUI accesses via `sdk.client.*` methods (e.g., `sdk.client.session.revert()`)
- API follows RESTful patterns with `path` (route params) and `body` (request payload) properties
- Server routes use Zod schemas for validation and OpenAPI spec generation

**Important**: When adding/modifying server endpoints, the SDK client must be regenerated (ask user to do this) before implementing TUI-side changes.

**Endpoint Pattern**:

```typescript
// Server side (src/server/server.ts)
describeRoute({
  method: "post",
  path: "/session/{id}/action",
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { "application/json": { schema: MySchema } } }
  },
  responses: { 200: { ... } }
})

// TUI side (after SDK regeneration)
sdk.client.session.action({
  path: { id: sessionID },
  body: { ...data }
})
```

## Configuration & Keybinds

Configuration system defined in `src/config/config.ts`:

- Config files: `opencode.jsonc` or `opencode.json` (supports JSONC format with comments)
- Hierarchy: Global config (`~/.opencode/config`) → Project configs (searched up from cwd)
- Keybinds defined in Zod schemas with defaults (e.g., `session_export: "<leader>x"`)
- Custom commands, agents, plugins, and modes loaded from `.opencode/` directories
- Config merging uses `mergeDeep` strategy - local configs override global

**Adding a new keybind**:

1. Add to appropriate Zod schema in `src/config/config.ts` (search for `KeybindsConfig`)
2. Reference by key in TUI command registration: `keybind: "my_keybind"`
3. TUI automatically handles keybind display and activation via `useKeybind()` hook

## Session Data Access

Session data accessed via `Session` namespace methods:

- `Session.get(id)` - Get session metadata (title, timestamps, share info, revert state)
- `Session.list()` - Async iterator of all sessions
- `Session.messages(id)` - Get all messages with parts (text, files, tool calls, results)
- Messages contain: `info` (metadata like role, timestamps) and `parts` (content chunks)
- Part types: `text`, `file`, `tool_call`, `tool_result` with `synthetic` flag for generated content
