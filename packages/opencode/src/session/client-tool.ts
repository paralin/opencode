import z from "zod"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Log } from "@/util/log"
import { Instance } from "@/project/instance"

/**
 * Client Tool Execution Bridge
 *
 * This module handles the execution of client-side tools. When the LLM requests
 * a client-side tool, the server emits a ToolCall event and waits for the client
 * to respond with the result via the tool_result endpoint.
 */
export namespace ClientTool {
  const log = Log.create({ service: "client-tool" })

  // Default timeout for client tool execution (5 minutes)
  const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

  /**
   * Schema for client-side tool definitions
   */
  export const Definition = z
    .object({
      description: z.string(),
      parameters: z.record(z.string(), z.any()),
    })
    .meta({
      ref: "ClientToolDefinition",
    })
  export type Definition = z.infer<typeof Definition>

  /**
   * Event emitted when a client-side tool needs to be executed
   */
  export const Event = {
    Call: BusEvent.define(
      "tool.client.call",
      z.object({
        sessionID: z.string(),
        messageID: z.string(),
        toolID: z.string(),
        callID: z.string(),
        args: z.unknown(),
      }),
    ),
    Result: BusEvent.define(
      "tool.client.result",
      z.object({
        sessionID: z.string(),
        callID: z.string(),
        result: z.string().optional(),
        error: z.string().optional(),
      }),
    ),
  }

  /**
   * Schema for tool result submission
   */
  export const ResultInput = z.object({
    callID: z.string().describe("The tool call ID"),
    result: z.string().optional().describe("The result of the tool execution"),
    error: z.string().optional().describe("Error message if the tool execution failed"),
  })
  export type ResultInput = z.infer<typeof ResultInput>

  // Pending tool calls waiting for client response
  const state = Instance.state(
    () => {
      const pending = new Map<
        string,
        {
          resolve: (result: string) => void
          reject: (error: Error) => void
          timeout: Timer
          sessionID: string
        }
      >()
      return { pending }
    },
    async (current) => {
      // Clean up pending calls on instance dispose
      for (const [callID, handler] of current.pending.entries()) {
        clearTimeout(handler.timeout)
        handler.reject(new Error("Instance disposed"))
        current.pending.delete(callID)
      }
    },
  )

  /**
   * Execute a client-side tool.
   * This emits an event for the client to handle and waits for the response.
   */
  export async function execute(
    sessionID: string,
    messageID: string,
    toolID: string,
    args: unknown,
    callID: string,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<string> {
    log.info("executing client tool", { sessionID, toolID, callID })

    // Emit event to client
    await Bus.publish(Event.Call, {
      sessionID,
      messageID,
      toolID,
      callID,
      args,
    })

    // Wait for client response
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const s = state()
        s.pending.delete(callID)
        log.error("client tool execution timed out", { sessionID, toolID, callID })
        reject(new Error(`Client tool execution timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      state().pending.set(callID, { resolve, reject, timeout, sessionID })
    })
  }

  /**
   * Handle the result of a client-side tool execution.
   * Called by the tool_result endpoint when the client responds.
   */
  export function handleResult(sessionID: string, input: ResultInput) {
    const { callID, result, error } = input
    log.info("handling client tool result", { sessionID, callID, hasError: !!error })

    const s = state()
    const handler = s.pending.get(callID)

    if (!handler) {
      log.warn("no pending handler for tool call", { callID })
      return false
    }

    // Verify the session matches
    if (handler.sessionID !== sessionID) {
      log.warn("session mismatch for tool call", {
        callID,
        expected: handler.sessionID,
        received: sessionID,
      })
      return false
    }

    clearTimeout(handler.timeout)
    s.pending.delete(callID)

    if (error) {
      handler.reject(new Error(error))
    } else {
      handler.resolve(result ?? "")
    }

    // Publish result event for any subscribers
    Bus.publish(Event.Result, {
      sessionID,
      callID,
      result,
      error,
    })

    return true
  }

  /**
   * Cancel all pending tool calls for a session.
   * Called when a session is aborted or cancelled.
   */
  export function cancelPending(sessionID: string) {
    const s = state()
    for (const [callID, handler] of s.pending.entries()) {
      if (handler.sessionID === sessionID) {
        clearTimeout(handler.timeout)
        handler.reject(new Error("Session cancelled"))
        s.pending.delete(callID)
        log.info("cancelled pending client tool", { sessionID, callID })
      }
    }
  }

  /**
   * Check if a tool definition is a client-side tool (has parameters object)
   * vs a simple enable/disable boolean.
   */
  export function isClientTool(value: unknown): value is Definition {
    return (
      typeof value === "object" &&
      value !== null &&
      "description" in value &&
      "parameters" in value &&
      typeof (value as Definition).description === "string"
    )
  }
}
