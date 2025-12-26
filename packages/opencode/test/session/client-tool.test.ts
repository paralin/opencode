import { describe, expect, test } from "bun:test"
import path from "path"
import { ClientTool } from "../../src/session/client-tool"
import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

describe("ClientTool", () => {
  describe("isClientTool", () => {
    test("returns true for valid client tool definition", () => {
      const def = {
        description: "Test tool",
        parameters: { type: "object", properties: {} },
      }
      expect(ClientTool.isClientTool(def)).toBe(true)
    })

    test("returns false for boolean", () => {
      expect(ClientTool.isClientTool(true)).toBe(false)
      expect(ClientTool.isClientTool(false)).toBe(false)
    })

    test("returns false for null/undefined", () => {
      expect(ClientTool.isClientTool(null)).toBe(false)
      expect(ClientTool.isClientTool(undefined)).toBe(false)
    })

    test("returns false for object missing description", () => {
      const def = { parameters: {} }
      expect(ClientTool.isClientTool(def)).toBe(false)
    })

    test("returns false for object missing parameters", () => {
      const def = { description: "Test" }
      expect(ClientTool.isClientTool(def)).toBe(false)
    })

    test("returns false for object with non-string description", () => {
      const def = { description: 123, parameters: {} }
      expect(ClientTool.isClientTool(def)).toBe(false)
    })
  })

  describe("execute and handleResult", () => {
    test("resolves when result is provided", async () => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const sessionID = "test-session"
          const messageID = "test-message"
          const toolID = "test-tool"
          const callID = "test-call-1"

          const executePromise = ClientTool.execute(sessionID, messageID, toolID, { foo: "bar" }, callID, 5000)

          // Simulate client responding
          await new Promise((resolve) => setTimeout(resolve, 10))
          const handled = ClientTool.handleResult(sessionID, {
            callID,
            result: "tool result",
          })

          expect(handled).toBe(true)
          const result = await executePromise
          expect(result).toBe("tool result")
        },
      })
    })

    test("rejects when error is provided", async () => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const sessionID = "test-session"
          const messageID = "test-message"
          const toolID = "test-tool"
          const callID = "test-call-2"

          const executePromise = ClientTool.execute(sessionID, messageID, toolID, {}, callID, 5000)

          await new Promise((resolve) => setTimeout(resolve, 10))
          ClientTool.handleResult(sessionID, {
            callID,
            error: "tool failed",
          })

          await expect(executePromise).rejects.toThrow("tool failed")
        },
      })
    })

    test("returns false for unknown callID", async () => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const handled = ClientTool.handleResult("session", {
            callID: "unknown-call-id",
            result: "result",
          })
          expect(handled).toBe(false)
        },
      })
    })

    test("returns false for session mismatch", async () => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const callID = "test-call-3"

          // Start execution with one session (don't await, we'll cancel it)
          const promise = ClientTool.execute("session-1", "msg", "tool", {}, callID, 5000)

          await new Promise((resolve) => setTimeout(resolve, 10))

          // Try to handle with different session
          const handled = ClientTool.handleResult("session-2", {
            callID,
            result: "result",
          })

          expect(handled).toBe(false)

          // Clean up - cancel and catch the expected rejection
          ClientTool.cancelPending("session-1")
          await expect(promise).rejects.toThrow("Session cancelled")
        },
      })
    })

    test("times out after specified duration", async () => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const callID = "test-call-timeout"
          const executePromise = ClientTool.execute("session", "msg", "tool", {}, callID, 50)

          await expect(executePromise).rejects.toThrow("timed out")
        },
      })
    })

    test("resolves with empty string when result is undefined", async () => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const callID = "test-call-empty"
          const executePromise = ClientTool.execute("session", "msg", "tool", {}, callID, 5000)

          await new Promise((resolve) => setTimeout(resolve, 10))
          ClientTool.handleResult("session", { callID })

          const result = await executePromise
          expect(result).toBe("")
        },
      })
    })
  })

  describe("cancelPending", () => {
    test("cancels all pending calls for session", async () => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const sessionID = "cancel-test-session"

          const promise1 = ClientTool.execute(sessionID, "msg", "tool1", {}, "call-1", 5000)
          const promise2 = ClientTool.execute(sessionID, "msg", "tool2", {}, "call-2", 5000)

          // Add catch handlers before canceling to prevent unhandled rejection
          const catchPromise1 = promise1.catch((e) => e)
          const catchPromise2 = promise2.catch((e) => e)

          await new Promise((resolve) => setTimeout(resolve, 10))
          ClientTool.cancelPending(sessionID)

          const error1 = await catchPromise1
          const error2 = await catchPromise2

          expect(error1).toBeInstanceOf(Error)
          expect(error1.message).toBe("Session cancelled")
          expect(error2).toBeInstanceOf(Error)
          expect(error2.message).toBe("Session cancelled")
        },
      })
    })

    test("only cancels calls for specified session", async () => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const promise1 = ClientTool.execute("session-a", "msg", "tool", {}, "call-a", 5000)
          const promise2 = ClientTool.execute("session-b", "msg", "tool", {}, "call-b", 5000)

          await new Promise((resolve) => setTimeout(resolve, 10))
          ClientTool.cancelPending("session-a")

          await expect(promise1).rejects.toThrow("Session cancelled")

          // session-b should still be pending, handle it
          ClientTool.handleResult("session-b", { callID: "call-b", result: "ok" })
          const result = await promise2
          expect(result).toBe("ok")
        },
      })
    })
  })

  describe("events", () => {
    test("emits tool.client.call event on execute", async () => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          let eventReceived = false
          let receivedData: any

          const unsub = Bus.subscribe(ClientTool.Event.Call, (event) => {
            eventReceived = true
            receivedData = event.properties
          })

          const callID = "event-test-call"
          const promise = ClientTool.execute("ses", "msg", "mytool", { arg: "value" }, callID, 5000)

          await new Promise((resolve) => setTimeout(resolve, 50))
          unsub()

          expect(eventReceived).toBe(true)
          expect(receivedData.sessionID).toBe("ses")
          expect(receivedData.messageID).toBe("msg")
          expect(receivedData.toolID).toBe("mytool")
          expect(receivedData.callID).toBe(callID)
          expect(receivedData.args).toEqual({ arg: "value" })

          // Clean up - cancel and catch the expected rejection
          ClientTool.cancelPending("ses")
          await expect(promise).rejects.toThrow("Session cancelled")
        },
      })
    })

    test("emits tool.client.result event on handleResult", async () => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          let eventReceived = false
          let receivedData: any

          const unsub = Bus.subscribe(ClientTool.Event.Result, (event) => {
            eventReceived = true
            receivedData = event.properties
          })

          const callID = "result-event-call"
          ClientTool.execute("ses", "msg", "tool", {}, callID, 5000)

          await new Promise((resolve) => setTimeout(resolve, 10))
          ClientTool.handleResult("ses", { callID, result: "done" })

          await new Promise((resolve) => setTimeout(resolve, 50))
          unsub()

          expect(eventReceived).toBe(true)
          expect(receivedData.sessionID).toBe("ses")
          expect(receivedData.callID).toBe(callID)
          expect(receivedData.result).toBe("done")
        },
      })
    })
  })

  describe("Definition schema", () => {
    test("validates correct definition", () => {
      const def = {
        description: "A test tool",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string" },
          },
        },
      }
      const result = ClientTool.Definition.safeParse(def)
      expect(result.success).toBe(true)
    })

    test("rejects missing description", () => {
      const def = {
        parameters: {},
      }
      const result = ClientTool.Definition.safeParse(def)
      expect(result.success).toBe(false)
    })

    test("rejects missing parameters", () => {
      const def = {
        description: "Test",
      }
      const result = ClientTool.Definition.safeParse(def)
      expect(result.success).toBe(false)
    })
  })
})
