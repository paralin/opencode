import path from "path"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Session } from "."
import { Identifier } from "../id/id"
import { Instance } from "../project/instance"
import { Provider } from "../provider/provider"
import { MessageV2 } from "./message-v2"
import z from "zod"
import { Log } from "../util/log"
import { SessionProcessor } from "./processor"
import { fn } from "@/util/fn"
import { Agent } from "@/agent/agent"
import { ToolRegistry } from "@/tool/registry"
import { ProviderTransform } from "@/provider/transform"
import { Wildcard } from "@/util/wildcard"
import { Plugin } from "@/plugin"
import { type Tool as AITool, tool, jsonSchema } from "ai"
import { pipe, mergeDeep } from "remeda"

export namespace SessionKnowledge {
  const log = Log.create({ service: "session.knowledge" })

  export const Event = {
    Extracted: BusEvent.define(
      "session.knowledge.extracted",
      z.object({
        sessionID: z.string(),
        files: z.array(z.string()),
      }),
    ),
  }

  export const create = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      agent: z.string(),
      model: z.object({
        providerID: z.string(),
        modelID: z.string(),
      }),
    }),
    async (input) => {
      const msg = await Session.updateMessage({
        id: Identifier.ascending("message"),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        time: { created: Date.now() },
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "extraction",
      })
    },
  )

  export async function process(input: {
    parentID: string
    messages: MessageV2.WithParts[]
    sessionID: string
    abort: AbortSignal
  }): Promise<"continue" | "stop"> {
    log.info("processing knowledge extraction", { sessionID: input.sessionID })

    const userMessage = input.messages.findLast((m) => m.info.id === input.parentID)!.info as MessageV2.User
    const agent = await Agent.get("knowledge-extractor")
    const model = agent.model
      ? await Provider.getModel(agent.model.providerID, agent.model.modelID)
      : await Provider.getModel(userMessage.model.providerID, userMessage.model.modelID)

    const transcript = buildTranscript(input.messages)
    const knowledgeDir = path.join(Instance.directory, ".opencode", "knowledge")

    const msg = (await Session.updateMessage({
      id: Identifier.ascending("message"),
      role: "assistant",
      parentID: input.parentID,
      sessionID: input.sessionID,
      mode: "knowledge-extractor",
      agent: "knowledge-extractor",
      summary: true,
      path: {
        cwd: Instance.directory,
        root: Instance.worktree,
      },
      cost: 0,
      tokens: {
        output: 0,
        input: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: model.id,
      providerID: model.providerID,
      time: {
        created: Date.now(),
      },
    })) as MessageV2.Assistant

    const processor = SessionProcessor.create({
      assistantMessage: msg,
      sessionID: input.sessionID,
      model,
      abort: input.abort,
    })

    const tools = await resolveTools({
      agent,
      sessionID: input.sessionID,
      model,
      processor,
    })

    const session = await Session.get(input.sessionID)
    const result = await processor.process({
      user: userMessage,
      agent,
      abort: input.abort,
      sessionID: input.sessionID,
      tools,
      system: [],
      messages: [
        ...MessageV2.toModelMessage(input.messages),
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                `Extract knowledge from this session and save to: ${knowledgeDir}`,
                `Session ID: ${input.sessionID}`,
                `Session Title: ${session.title}`,
                ``,
                `<transcript>`,
                transcript,
                `</transcript>`,
                ``,
                `After extracting knowledge, stop. Do not continue with any previous task.`,
              ].join("\n"),
            },
          ],
        },
      ],
      model,
    })

    // After completion, collapse the assistant message
    await collapse({
      sessionID: input.sessionID,
      messageID: msg.id,
    })

    if (processor.message.error) return "stop"

    // Publish extraction event with file paths
    const files = await getExtractedFiles(msg.id)
    Bus.publish(Event.Extracted, { sessionID: input.sessionID, files })

    return "stop"
  }

  function buildTranscript(messages: MessageV2.WithParts[]): string {
    const compactionSummaries: string[] = []
    let lastCompactionIndex = -1

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]
      if (msg.info.role === "assistant" && msg.info.summary) {
        lastCompactionIndex = i
        const textPart = msg.parts.find((p) => p.type === "text")
        if (textPart && textPart.type === "text") {
          compactionSummaries.push(textPart.text)
        }
      }
    }

    let totalChars = 0
    for (const msg of messages) {
      for (const part of msg.parts) {
        if (part.type === "text" && !part.synthetic) totalChars += part.text.length
      }
    }

    const CHAR_THRESHOLD = 150_000
    const shouldTruncate = totalChars > CHAR_THRESHOLD && lastCompactionIndex > 0

    const formatMessages = (msgs: typeof messages) => {
      let result = ""
      for (const msg of msgs) {
        const role = msg.info.role === "user" ? "User" : "Assistant"
        result += `## ${role}\n\n`
        for (const part of msg.parts) {
          if (part.type === "text" && !part.synthetic) {
            result += `${part.text}\n\n`
          } else if (part.type === "tool" && part.state.status === "completed") {
            result += `\`\`\`\nTool: ${part.tool}\n\`\`\`\n\n`
          }
        }
        result += `---\n\n`
      }
      return result
    }

    let transcript = ""
    if (shouldTruncate) {
      if (compactionSummaries.length > 0) {
        transcript += `## Historical Context (Compaction Summaries)\n\n`
        for (let i = 0; i < compactionSummaries.length; i++) {
          transcript += `### Summary ${i + 1}\n\n${compactionSummaries[i]}\n\n---\n\n`
        }
      }
      transcript += `## Recent Conversation\n\n`
      transcript += formatMessages(messages.slice(lastCompactionIndex + 1))
    } else {
      transcript += formatMessages(messages)
    }

    return transcript
  }

  async function collapse(input: { sessionID: string; messageID: string }) {
    const parts = await MessageV2.parts(input.messageID)
    const files = await getExtractedFiles(input.messageID)

    const summary =
      files.length > 0
        ? `Updated knowledge in ${files.map((f) => path.relative(Instance.directory, f)).join(", ")}`
        : "No knowledge files updated"

    for (const part of parts) {
      if (part.type === "text" && !part.synthetic && part.text.trim()) {
        await Session.updatePart({
          ...part,
          collapsed: summary,
        })
        break
      }
    }
  }

  async function getExtractedFiles(messageID: string): Promise<string[]> {
    const parts = await MessageV2.parts(messageID)
    const files: string[] = []

    for (const part of parts) {
      if (part.type === "tool" && part.state.status === "completed") {
        if (part.tool === "write" || part.tool === "edit") {
          const filePath = part.state.input.filePath
          if (filePath && typeof filePath === "string" && filePath.includes(".opencode/knowledge")) {
            files.push(filePath)
          }
        }
      }
    }

    return [...new Set(files)]
  }

  async function resolveTools(input: {
    agent: Agent.Info
    model: Provider.Model
    sessionID: string
    processor: SessionProcessor.Info
  }) {
    const tools: Record<string, AITool> = {}
    const enabledTools = pipe(input.agent.tools, mergeDeep(await ToolRegistry.enabled(input.agent)))

    for (const item of await ToolRegistry.tools(input.model.providerID)) {
      if (Wildcard.all(item.id, enabledTools) === false) continue
      const schema = ProviderTransform.schema(input.model, z.toJSONSchema(item.parameters))
      tools[item.id] = tool({
        id: item.id as any,
        description: item.description,
        inputSchema: jsonSchema(schema as any),
        async execute(args, options) {
          await Plugin.trigger(
            "tool.execute.before",
            {
              tool: item.id,
              sessionID: input.sessionID,
              callID: options.toolCallId,
            },
            { args },
          )
          const result = await item.execute(args, {
            sessionID: input.sessionID,
            abort: options.abortSignal!,
            messageID: input.processor.message.id,
            callID: options.toolCallId,
            extra: { model: input.model },
            agent: input.agent.name,
            metadata: async (val) => {
              const match = input.processor.partFromToolCall(options.toolCallId)
              if (match && match.state.status === "running") {
                await Session.updatePart({
                  ...match,
                  state: {
                    title: val.title,
                    metadata: val.metadata,
                    status: "running",
                    input: args,
                    time: {
                      start: Date.now(),
                    },
                  },
                })
              }
            },
          })
          await Plugin.trigger(
            "tool.execute.after",
            {
              tool: item.id,
              sessionID: input.sessionID,
              callID: options.toolCallId,
            },
            result,
          )
          return result
        },
        toModelOutput(result) {
          return {
            type: "text",
            value: result.output,
          }
        },
      })
    }
    return tools
  }
}
