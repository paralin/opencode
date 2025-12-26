# Client-Side Tools for OpenCode SDK

This document outlines the plan to add support for passing custom tools directly via the SDK's `prompt()` method, with execution happening client-side.

## Overview

Currently, tools in OpenCode must be defined on the filesystem (`.opencode/tool/*.ts`) or via plugins. This feature allows SDK users to define tools inline when calling `prompt()`, with the tool execution happening in the client's process rather than on the server.

### Key Design Decisions

- **Scope**: Tools are prompt-scoped (only available for a single `prompt()` call)
- **Execution**: Client-side (in the SDK user's process)
- **Schema**: Zod-based parameter definitions
- **Streaming**: Support streaming until tool execution, then resume after tool returns

## API Design

```typescript
import { createOpencodeClient, tool } from "@opencode-ai/sdk"
import { z } from "zod"

const client = createOpencodeClient()

// Define tools using the `tool()` helper (similar to plugin API)
const weatherTool = tool({
  description: "Get the current weather for a location",
  args: {
    location: z.string().describe("City name or coordinates"),
    units: z.enum(["celsius", "fahrenheit"]).optional(),
  },
  execute: async (args, context) => {
    const weather = await fetchWeather(args.location, args.units)
    return `Temperature: ${weather.temp}, Conditions: ${weather.conditions}`
  },
})

const calculatorTool = tool({
  description: "Perform mathematical calculations",
  args: {
    expression: z.string().describe("Mathematical expression to evaluate"),
  },
  execute: async (args) => {
    return String(eval(args.expression)) // simplified example
  },
})

// Pass tools to prompt()
const response = await client.session.prompt({
  path: { sessionID: "ses_xxx" },
  body: {
    parts: [{ type: "text", text: "What's the weather in Tokyo?" }],
    tools: {
      weather: weatherTool,
      calculator: calculatorTool,
    },
  },
})
```

### Tool Definition Interface

```typescript
import { z } from "zod"

type ToolContext = {
  sessionID: string
  messageID: string
  callID: string
  abort: AbortSignal
}

type ToolDefinition<Args extends z.ZodRawShape = z.ZodRawShape> = {
  description: string
  args: Args
  execute: (args: z.infer<z.ZodObject<Args>>, context: ToolContext) => Promise<string>
}

// Helper function to create type-safe tools
function tool<Args extends z.ZodRawShape>(definition: ToolDefinition<Args>): ToolDefinition<Args>
```

## Architecture

### Communication Flow

```
┌─────────────┐                    ┌─────────────┐                    ┌─────────────┐
│   SDK       │                    │   Server    │                    │   LLM       │
│   Client    │                    │             │                    │             │
└──────┬──────┘                    └──────┬──────┘                    └──────┬──────┘
       │                                  │                                  │
       │  1. prompt() with tools          │                                  │
       │─────────────────────────────────>│                                  │
       │     (tool schemas only)          │                                  │
       │                                  │                                  │
       │                                  │  2. Request with tools           │
       │                                  │─────────────────────────────────>│
       │                                  │                                  │
       │  3. Stream text/reasoning        │  3. Stream response              │
       │<─────────────────────────────────│<─────────────────────────────────│
       │                                  │                                  │
       │                                  │  4. Tool call (weather)          │
       │                                  │<─────────────────────────────────│
       │                                  │                                  │
       │  5. Tool call event              │                                  │
       │<─────────────────────────────────│                                  │
       │                                  │                                  │
       │  6. Execute tool locally         │                                  │
       │  ─────────────────────────>      │                                  │
       │                                  │                                  │
       │  7. Tool result                  │                                  │
       │─────────────────────────────────>│                                  │
       │                                  │                                  │
       │                                  │  8. Continue with result         │
       │                                  │─────────────────────────────────>│
       │                                  │                                  │
       │  9. Stream final response        │  9. Final response               │
       │<─────────────────────────────────│<─────────────────────────────────│
       │                                  │                                  │
```

### Protocol Design

The prompt endpoint needs to support bidirectional communication for tool calls. Two approaches:

#### Option A: WebSocket-based (Recommended)

Convert the prompt endpoint to use WebSocket for full-duplex communication:

```typescript
// Client -> Server messages
type ClientMessage =
  | { type: "prompt"; data: PromptInput }
  | { type: "tool_result"; callID: string; result: string }
  | { type: "tool_error"; callID: string; error: string }
  | { type: "cancel" }

// Server -> Client messages
type ServerMessage =
  | { type: "text"; delta: string }
  | { type: "tool_call"; callID: string; tool: string; args: unknown }
  | { type: "done"; message: AssistantMessage }
  | { type: "error"; error: Error }
```

#### Option B: SSE with POST callback

Keep SSE for streaming, add a callback endpoint for tool results:

- Server streams events including `tool_call` events
- Client POSTs tool results to `/session/:id/tool_result`
- Server continues streaming after receiving result

### Handling Multiple Tool Calls

LLMs may request multiple tool calls in parallel. The SDK should:

1. Receive all pending tool calls
2. Execute them concurrently (unless dependencies exist)
3. Send all results back
4. Server continues with all results

## Implementation Plan

### Phase 1: Core Infrastructure

#### 1.1 Server: Tool Definition Schema

**File**: `packages/opencode/src/session/prompt.ts`

Add schema for client-side tool definitions:

```typescript
const ClientToolSchema = z.object({
  description: z.string(),
  parameters: z.record(z.unknown()), // JSON Schema
})

export const PromptInput = z.object({
  // ... existing fields
  tools: z
    .union([
      z.record(z.string(), z.boolean()), // existing: enable/disable
      z.record(z.string(), ClientToolSchema), // new: inline definitions
      z.record(z.string(), z.union([z.boolean(), ClientToolSchema])), // mixed
    ])
    .optional(),
})
```

#### 1.2 Server: Tool Resolution

**File**: `packages/opencode/src/session/prompt.ts`

Modify `resolveTools()` to handle client-side tools:

```typescript
async function resolveTools(input: {
  // ... existing params
  clientTools?: Record<string, { description: string; parameters: unknown }>
}) {
  const tools: Record<string, AITool> = {}

  // Add server-side tools (existing logic)
  for (const item of await ToolRegistry.tools(input.model.providerID)) {
    // ... existing
  }

  // Add client-side tools (new)
  for (const [id, def] of Object.entries(input.clientTools ?? {})) {
    tools[id] = tool({
      id: id as any,
      description: def.description,
      inputSchema: jsonSchema(def.parameters as any),
      async execute(args, options) {
        // Emit event for client to handle
        return executeClientTool(id, args, options)
      },
    })
  }

  return tools
}
```

#### 1.3 Server: Client Tool Execution Bridge

**File**: `packages/opencode/src/session/client-tool.ts` (new)

```typescript
export namespace ClientTool {
  // Pending tool calls waiting for client response
  const pending = new Map<
    string,
    {
      resolve: (result: string) => void
      reject: (error: Error) => void
    }
  >()

  export async function execute(sessionID: string, toolID: string, args: unknown, callID: string): Promise<string> {
    // Emit event to client
    Bus.publish(Event.ToolCall, { sessionID, toolID, args, callID })

    // Wait for client response
    return new Promise((resolve, reject) => {
      pending.set(callID, { resolve, reject })
      // Add timeout handling
    })
  }

  export function handleResult(callID: string, result: string) {
    const handler = pending.get(callID)
    if (handler) {
      handler.resolve(result)
      pending.delete(callID)
    }
  }

  export function handleError(callID: string, error: string) {
    const handler = pending.get(callID)
    if (handler) {
      handler.reject(new Error(error))
      pending.delete(callID)
    }
  }
}
```

#### 1.4 Server: Tool Result Endpoint

**File**: `packages/opencode/src/server/server.ts`

```typescript
.post(
  "/session/:sessionID/tool_result",
  describeRoute({
    summary: "Submit tool result",
    description: "Submit the result of a client-side tool execution",
    operationId: "session.toolResult",
    // ...
  }),
  validator("json", z.object({
    callID: z.string(),
    result: z.string().optional(),
    error: z.string().optional(),
  })),
  async (c) => {
    const { sessionID } = c.req.valid("param")
    const { callID, result, error } = c.req.valid("json")

    if (error) {
      ClientTool.handleError(callID, error)
    } else {
      ClientTool.handleResult(callID, result!)
    }

    return c.json({ ok: true })
  },
)
```

#### 1.5 Server: Tool Call Event

**File**: `packages/opencode/src/bus.ts` or event definitions

Add new event type for tool calls:

```typescript
export const ToolCallEvent = z.object({
  type: z.literal("tool.call"),
  properties: z.object({
    sessionID: z.string(),
    toolID: z.string(),
    callID: z.string(),
    args: z.unknown(),
  }),
})
```

### Phase 2: SDK Implementation

#### 2.1 SDK: Tool Helper Function

**File**: `packages/sdk/js/src/v2/tool.ts` (new)

```typescript
import { z } from "zod"

export type ToolContext = {
  sessionID: string
  messageID: string
  callID: string
  abort: AbortSignal
}

export type ClientTool<Args extends z.ZodRawShape = z.ZodRawShape> = {
  description: string
  args: Args
  execute: (args: z.infer<z.ZodObject<Args>>, context: ToolContext) => Promise<string>
  // Internal: JSON schema version for sending to server
  _schema?: unknown
}

export function tool<Args extends z.ZodRawShape>(definition: Omit<ClientTool<Args>, "_schema">): ClientTool<Args> {
  return {
    ...definition,
    _schema: zodToJsonSchema(z.object(definition.args)),
  }
}

function zodToJsonSchema(schema: z.ZodType): unknown {
  // Use zod-to-json-schema or built-in z.toJSONSchema()
  return z.toJSONSchema(schema)
}
```

#### 2.2 SDK: Extended Prompt Method

**File**: `packages/sdk/js/src/v2/client.ts`

Create a higher-level prompt method that handles client tools:

```typescript
export type PromptWithToolsOptions = {
  sessionID: string
  parts: Array<TextPartInput | FilePartInput>
  tools?: Record<string, ClientTool | boolean>
  model?: { providerID: string; modelID: string }
  agent?: string
  // ... other options
}

export async function promptWithTools(client: OpencodeClient, options: PromptWithToolsOptions): Promise<PromptResult> {
  const { tools, ...rest } = options

  // Separate client tools from enable/disable flags
  const clientTools: Record<string, ClientTool> = {}
  const toolFlags: Record<string, boolean> = {}

  for (const [id, value] of Object.entries(tools ?? {})) {
    if (typeof value === "boolean") {
      toolFlags[id] = value
    } else {
      clientTools[id] = value
      toolFlags[id] = true // Enable the tool
    }
  }

  // Convert client tools to server format (schemas only)
  const toolSchemas = Object.fromEntries(
    Object.entries(clientTools).map(([id, tool]) => [id, { description: tool.description, parameters: tool._schema }]),
  )

  // Start prompt with tool schemas
  const eventSource = client.session.promptStream({
    path: { sessionID: options.sessionID },
    body: {
      parts: options.parts,
      tools: { ...toolFlags, ...toolSchemas },
      model: options.model,
      agent: options.agent,
    },
  })

  // Handle events including tool calls
  return handlePromptStream(client, eventSource, clientTools, options.sessionID)
}

async function handlePromptStream(
  client: OpencodeClient,
  eventSource: EventSource,
  clientTools: Record<string, ClientTool>,
  sessionID: string,
): Promise<PromptResult> {
  const abortController = new AbortController()

  for await (const event of eventSource) {
    if (event.type === "tool.call") {
      const { toolID, callID, args } = event.properties
      const tool = clientTools[toolID]

      if (tool) {
        try {
          const result = await tool.execute(args, {
            sessionID,
            messageID: event.properties.messageID,
            callID,
            abort: abortController.signal,
          })

          // Send result back to server
          await client.session.toolResult({
            path: { sessionID },
            body: { callID, result },
          })
        } catch (error) {
          await client.session.toolResult({
            path: { sessionID },
            body: { callID, error: String(error) },
          })
        }
      }
    }

    // Handle other event types (text, done, error)
  }
}
```

#### 2.3 SDK: Type Exports

**File**: `packages/sdk/js/src/v2/index.ts`

```typescript
export { tool, type ClientTool, type ToolContext } from "./tool"
export { promptWithTools, type PromptWithToolsOptions } from "./client"
```

### Phase 3: Integration & Testing

#### 3.1 Update SDK Build

**File**: `packages/sdk/js/script/build.ts`

Ensure new files are included in the build.

#### 3.2 Add Tests

**File**: `packages/sdk/js/test/tool.test.ts`

```typescript
import { describe, it, expect } from "bun:test"
import { tool } from "../src/v2/tool"
import { z } from "zod"

describe("tool helper", () => {
  it("should create a tool with correct schema", () => {
    const myTool = tool({
      description: "Test tool",
      args: {
        input: z.string(),
        count: z.number().optional(),
      },
      execute: async (args) => `Received: ${args.input}`,
    })

    expect(myTool.description).toBe("Test tool")
    expect(myTool._schema).toBeDefined()
  })
})
```

#### 3.3 Integration Test

**File**: `packages/opencode/test/sdk/client-tools.test.ts`

```typescript
import { describe, it, expect } from "bun:test"
import { createOpencodeClient, tool, promptWithTools } from "@opencode-ai/sdk"
import { z } from "zod"

describe("client-side tools", () => {
  it("should execute client-side tool and return result", async () => {
    const client = createOpencodeClient()

    const echoTool = tool({
      description: "Echo the input",
      args: { message: z.string() },
      execute: async (args) => `Echo: ${args.message}`,
    })

    const session = await client.session.create({ body: {} })

    const result = await promptWithTools(client, {
      sessionID: session.data!.id,
      parts: [{ type: "text", text: "Please echo 'hello world'" }],
      tools: { echo: echoTool },
    })

    expect(result.text).toContain("Echo: hello world")
  })
})
```

## Migration & Compatibility

### Backward Compatibility

The existing `tools: Record<string, boolean>` API remains fully supported. The server detects whether a tool value is a boolean (enable/disable) or an object (tool definition) and handles accordingly.

### Future Enhancements

1. **Tool result streaming**: Allow tools to stream partial results back
2. **Tool metadata**: Support progress updates and status during execution
3. **Tool dependencies**: Declare dependencies between tools for ordered execution
4. **Persistent tools**: Option to register tools at the client level for reuse across prompts

## Open Questions

1. **Timeout handling**: What's the default timeout for client tool execution? How is it configured?
2. **Abort propagation**: How do we cleanly abort a running client tool when the session is cancelled?
3. **Validation errors**: Should the server validate tool args against the schema before sending to client?
4. **Tool naming conflicts**: What happens if a client tool ID conflicts with a server tool ID?

## File Changes Summary

### New Files

- `packages/opencode/src/session/client-tool.ts` - Server-side client tool execution bridge
- `packages/sdk/js/src/v2/tool.ts` - Tool helper and types

### Modified Files

- `packages/opencode/src/session/prompt.ts` - Extended PromptInput schema, resolveTools()
- `packages/opencode/src/server/server.ts` - New tool_result endpoint, tool_call event
- `packages/opencode/src/bus.ts` - New event type
- `packages/sdk/js/src/v2/client.ts` - promptWithTools() function
- `packages/sdk/js/src/v2/index.ts` - Exports
- `packages/sdk/js/script/build.ts` - Build configuration
