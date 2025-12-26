import type { OpencodeClient } from "./gen/sdk.gen.js"
import type { TextPartInput, FilePartInput, SessionPromptResponse } from "./gen/types.gen.js"
import { type ClientTool as ClientToolDef, type ToolContext, toServerSchema } from "./tool.js"

/**
 * Options for prompting with client-side tools.
 */
export type PromptWithToolsOptions = {
  /** The session ID to send the prompt to */
  sessionID: string
  /** The message parts to send */
  parts: Array<TextPartInput | FilePartInput>
  /** Tools to enable/disable or client-side tool definitions */
  tools?: Record<string, ClientToolDef | boolean>
  /** Model to use for the response */
  model?: { providerID: string; modelID: string }
  /** Agent to use */
  agent?: string
  /** Custom system prompt */
  system?: string
  /** If true, don't wait for a response */
  noReply?: boolean
  /** Abort signal to cancel the request */
  signal?: AbortSignal
  /** Callback for when a client tool is about to be executed */
  onToolCall?: (toolID: string, args: unknown) => void
  /** Callback for when a client tool execution completes */
  onToolResult?: (toolID: string, result: string | Error) => void
}

/**
 * Result from promptWithTools.
 */
export type PromptWithToolsResult = {
  /** The response from the server */
  response: SessionPromptResponse
}

/**
 * Error thrown when a client tool execution fails.
 */
export class ClientToolError extends Error {
  constructor(
    public readonly toolID: string,
    public readonly callID: string,
    message: string,
  ) {
    super(`Client tool '${toolID}' (call ${callID}) failed: ${message}`)
    this.name = "ClientToolError"
  }
}

/**
 * Send a prompt with client-side tools support.
 *
 * This function extends the basic prompt functionality to support tools that
 * execute client-side. When the LLM requests a client-side tool, this function
 * will:
 * 1. Execute the tool locally
 * 2. Send the result back to the server
 * 3. Continue streaming the response
 *
 * @example
 * ```typescript
 * import { createOpencodeClient, promptWithTools, tool } from "@opencode-ai/sdk/v2"
 * import { z } from "zod"
 *
 * const client = createOpencodeClient()
 *
 * const echoTool = tool({
 *   description: "Echo the input back",
 *   args: { message: z.string() },
 *   execute: async (args) => `Echo: ${args.message}`,
 * })
 *
 * const result = await promptWithTools(client, {
 *   sessionID: "ses_xxx",
 *   parts: [{ type: "text", text: "Please echo 'hello world'" }],
 *   tools: { echo: echoTool },
 * })
 * ```
 */
export async function promptWithTools(
  client: OpencodeClient,
  options: PromptWithToolsOptions,
): Promise<PromptWithToolsResult> {
  const { tools, signal, onToolCall, onToolResult, ...rest } = options
  const abortController = new AbortController()

  // Link the abort controller to the provided signal
  if (signal) {
    signal.addEventListener("abort", () => abortController.abort())
  }

  // Separate client tools from enable/disable flags
  const clientTools: Record<string, ClientToolDef> = {}
  const serverTools: Record<string, { description: string; parameters: unknown } | boolean> = {}

  for (const [id, value] of Object.entries(tools ?? {})) {
    if (typeof value === "boolean") {
      serverTools[id] = value
    } else {
      clientTools[id] = value
      serverTools[id] = toServerSchema(value)
    }
  }

  // Subscribe to events before sending the prompt
  const eventSource = await subscribeToEvents(client, options.sessionID, {
    signal: abortController.signal,
    async onToolCall(event) {
      const tool = clientTools[event.toolID]
      if (!tool) {
        // Not a client tool, ignore
        return
      }

      onToolCall?.(event.toolID, event.args)

      const context: ToolContext = {
        sessionID: options.sessionID,
        messageID: event.messageID,
        callID: event.callID,
        abort: abortController.signal,
      }

      try {
        const result = await tool.execute(event.args as Record<string, unknown>, context)
        onToolResult?.(event.toolID, result)

        // Send result back to server
        await client.session.toolResult({
          sessionID: options.sessionID,
          callID: event.callID,
          result,
        })
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        onToolResult?.(event.toolID, new Error(errorMessage))

        // Send error back to server
        await client.session.toolResult({
          sessionID: options.sessionID,
          callID: event.callID,
          error: errorMessage,
        })
      }
    },
  })

  try {
    // Send the prompt with tool schemas
    const response = await client.session.prompt({
      ...rest,
      tools: serverTools as Record<string, boolean | { description: string; parameters: Record<string, unknown> }>,
    })

    return { response: response.data! }
  } finally {
    // Clean up event subscription
    eventSource.close()
  }
}

/**
 * Internal: Subscribe to session events to handle tool calls.
 */
async function subscribeToEvents(
  client: OpencodeClient,
  _sessionID: string,
  options: {
    signal: AbortSignal
    onToolCall: (event: { toolID: string; callID: string; messageID: string; args: unknown }) => Promise<void>
  },
): Promise<{ close: () => void }> {
  // Get the base URL from the client
  const baseUrl = (client as any)._options?.baseUrl || "http://localhost:4096"

  // Connect to the event stream
  const eventSource = new EventSource(`${baseUrl}/event`)

  eventSource.onmessage = async (event) => {
    const data = JSON.parse(event.data)

    // Handle client tool call events
    if (data.type === "tool.client.call") {
      await options.onToolCall({
        toolID: data.properties.toolID,
        callID: data.properties.callID,
        messageID: data.properties.messageID,
        args: data.properties.args,
      })
    }
  }

  options.signal.addEventListener("abort", () => {
    eventSource.close()
  })

  return {
    close: () => eventSource.close(),
  }
}
