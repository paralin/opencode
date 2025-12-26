## client-tools

goal is to let sdk users define custom tools that execute in their process rather than on the server

### api

```
POST /session/:sessionID/tool_result
{
  callID: string
  result?: string
  error?: string
}
```

### types

```typescript
type ClientTool = {
  description: string
  parameters: Record<string, unknown> // JSON Schema
}
```

### prompt input

tools field accepts either boolean (enable/disable) or ClientTool definition:

```typescript
tools?: Record<string, boolean | ClientTool>
```

### events

```
tool.client.call
{
  sessionID: string
  messageID: string
  toolID: string
  callID: string
  args: unknown
}

tool.client.result
{
  sessionID: string
  callID: string
  result?: string
  error?: string
}
```

### flow

1. client sends prompt with tool schemas (execute function stays client-side)
2. server registers tools with LLM
3. LLM requests tool call
4. server emits `tool.client.call` event
5. client executes tool locally
6. client POSTs result to `/session/:sessionID/tool_result`
7. server continues with result

### storage

only boolean flags stored in message, not full tool definitions
