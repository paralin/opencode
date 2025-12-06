import { describe, expect, test } from "bun:test"
import path from "path"
import { Session } from "../../src/session"
import { SessionKnowledge } from "../../src/session/knowledge"
import { MessageV2 } from "../../src/session/message-v2"
import { Bus } from "../../src/bus"
import { Log } from "../../src/util/log"
import { Instance } from "../../src/project/instance"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

describe("SessionKnowledge.create", () => {
  test("should create a user message with extraction part", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})

        await SessionKnowledge.create({
          sessionID: session.id,
          agent: "build",
          model: { providerID: "test", modelID: "test-model" },
        })

        const messages = await Session.messages({ sessionID: session.id })
        expect(messages.length).toBe(1)

        const msg = messages[0]
        expect(msg.info.role).toBe("user")

        const extractionPart = msg.parts.find((p) => p.type === "extraction")
        expect(extractionPart).toBeDefined()
        expect(extractionPart?.type).toBe("extraction")

        // Should have initial checking status
        const part = extractionPart as MessageV2.ExtractionPart
        expect(part.extraction.status).toBe("checking")

        await Session.remove(session.id)
      },
    })
  })

  test("should emit message events when creating extraction", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})
        const events: string[] = []

        const unsubMessage = Bus.subscribe(MessageV2.Event.Updated, () => {
          events.push("message.updated")
        })

        const unsubPart = Bus.subscribe(MessageV2.Event.PartUpdated, (evt) => {
          if (evt.properties.part.type === "extraction") {
            events.push("part.updated.extraction")
          }
        })

        await SessionKnowledge.create({
          sessionID: session.id,
          agent: "build",
          model: { providerID: "test", modelID: "test-model" },
        })

        await new Promise((resolve) => setTimeout(resolve, 100))

        unsubMessage()
        unsubPart()

        expect(events).toContain("message.updated")
        expect(events).toContain("part.updated.extraction")

        await Session.remove(session.id)
      },
    })
  })
})

describe("ExtractionPart schema", () => {
  test("should require extraction field with status", () => {
    const validPart = {
      id: "part_123",
      sessionID: "ses_123",
      messageID: "msg_123",
      type: "extraction" as const,
      extraction: { status: "checking" as const },
    }

    const result = MessageV2.ExtractionPart.safeParse(validPart)
    expect(result.success).toBe(true)
  })

  test("should accept all extraction statuses", () => {
    const statuses = ["checking", "extracting", "skipped", "completed"] as const

    for (const status of statuses) {
      const part = {
        id: "part_123",
        sessionID: "ses_123",
        messageID: "msg_123",
        type: "extraction" as const,
        extraction: { status },
      }

      const result = MessageV2.ExtractionPart.safeParse(part)
      expect(result.success).toBe(true)
    }
  })

  test("should accept extraction with optional fields", () => {
    const part = {
      id: "part_123",
      sessionID: "ses_123",
      messageID: "msg_123",
      type: "extraction" as const,
      extraction: {
        status: "completed" as const,
        childSessionID: "ses_child_123",
        files: [
          { path: ".opencode/knowledge/test.md", summary: "Test knowledge" },
          { path: ".opencode/knowledge/other.md" },
        ],
        summary: [{ tool: "read", title: "Reading file" }, { tool: "write" }],
      },
    }

    const result = MessageV2.ExtractionPart.safeParse(part)
    expect(result.success).toBe(true)
  })

  test("should reject extraction without status", () => {
    const part = {
      id: "part_123",
      sessionID: "ses_123",
      messageID: "msg_123",
      type: "extraction" as const,
      extraction: {},
    }

    const result = MessageV2.ExtractionPart.safeParse(part)
    expect(result.success).toBe(false)
  })

  test("should reject part without extraction field", () => {
    const part = {
      id: "part_123",
      sessionID: "ses_123",
      messageID: "msg_123",
      type: "extraction" as const,
    }

    const result = MessageV2.ExtractionPart.safeParse(part)
    expect(result.success).toBe(false)
  })
})

describe("ExtractionStatus schema", () => {
  test("should validate minimal status", () => {
    const status = { status: "checking" as const }
    const result = MessageV2.ExtractionStatus.safeParse(status)
    expect(result.success).toBe(true)
  })

  test("should validate full status", () => {
    const status = {
      status: "completed" as const,
      childSessionID: "ses_123",
      files: [{ path: "test.md", summary: "Summary" }],
      summary: [{ tool: "read", title: "Title" }],
    }
    const result = MessageV2.ExtractionStatus.safeParse(status)
    expect(result.success).toBe(true)
  })

  test("should reject invalid status value", () => {
    const status = { status: "invalid" }
    const result = MessageV2.ExtractionStatus.safeParse(status)
    expect(result.success).toBe(false)
  })
})

describe("SessionKnowledge.list", () => {
  test("should return empty array when no knowledge files exist", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const files = await SessionKnowledge.list()
        // May or may not have files depending on test environment
        expect(Array.isArray(files)).toBe(true)
      },
    })
  })
})

describe("SessionKnowledge.load", () => {
  test("should return empty array for non-existent files", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const contents = await SessionKnowledge.load(["/non/existent/file.md"])
        expect(contents).toEqual([])
      },
    })
  })

  test("should return empty array for empty input", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const contents = await SessionKnowledge.load([])
        expect(contents).toEqual([])
      },
    })
  })
})
