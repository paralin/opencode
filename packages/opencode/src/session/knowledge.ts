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
import { Token } from "@/util/token"

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

    const knowledgeDir = path.join(Instance.directory, ".opencode", "knowledge")
    const session = await Session.get(input.sessionID)

    // Calculate max tokens for transcript based on model context limit
    // Reserve tokens for: system prompt (~2K), extraction prompt wrapper (~500), output (~8K), safety margin
    const RESERVED_TOKENS = 15_000
    const maxTranscriptTokens = Math.max(10_000, (model.limit.context || 200_000) - RESERVED_TOKENS)

    const transcript = buildTranscript(input.messages, maxTranscriptTokens)

    const extractionPrompt = {
      role: "user" as const,
      content: [
        {
          type: "text" as const,
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
    }

    let hasError = false

    // Create first assistant message for the extraction
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

    // Single call to processor.process - it handles tool loops internally
    const result = await processor.process({
      user: userMessage,
      agent,
      abort: input.abort,
      sessionID: input.sessionID,
      tools,
      system: [],
      // Only send the extraction prompt with embedded transcript
      // The transcript already contains the conversation content in a summarized format
      // This avoids double-sending the conversation (once via toModelMessage, once in transcript)
      messages: [extractionPrompt],
      model,
    })

    // Collapse the assistant message
    await collapse({
      sessionID: input.sessionID,
      messageID: msg.id,
    })

    if (result === "stop" || processor.message.error) {
      hasError = !!processor.message.error
    }

    if (hasError) return "stop"

    // Collect all extracted files from all assistant messages in this extraction
    const allMsgs = await Session.messages({ sessionID: input.sessionID })
    const extractionMsgs = allMsgs.filter(
      (m) => m.info.role === "assistant" && m.info.agent === "knowledge-extractor" && m.info.summary,
    )
    const allFiles: string[] = []
    for (const m of extractionMsgs) {
      const files = await getExtractedFiles(m.info.id)
      allFiles.push(...files)
    }

    Bus.publish(Event.Extracted, { sessionID: input.sessionID, files: [...new Set(allFiles)] })

    return "stop"
  }

  // Minimum number of recent message pairs to always keep in full
  const MIN_RECENT_EXCHANGES = 10

  function buildTranscript(messages: MessageV2.WithParts[], maxTokens: number): string {
    const compactionSummaries: string[] = []
    let lastCompactionIndex = -1

    // Find all compaction summaries
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

    // Calculate total characters
    let totalChars = 0
    for (const msg of messages) {
      for (const part of msg.parts) {
        if (part.type === "text" && !part.synthetic) totalChars += part.text.length
      }
    }

    const actualTokens = Math.round(totalChars / 4)

    // Determine if we need to truncate based on token limit
    const shouldTruncate = actualTokens > maxTokens

    const formatMessages = (msgs: typeof messages, brief = false) => {
      let result = ""
      for (const msg of msgs) {
        const role = msg.info.role === "user" ? "User" : "Assistant"
        result += `## ${role}\n\n`
        for (const part of msg.parts) {
          if (part.type === "text" && !part.synthetic) {
            result += `${part.text}\n\n`
          } else if (part.type === "tool" && part.state.status === "completed") {
            if (brief) {
              // In brief mode, just note the tool was used
              result += `[Tool: ${part.tool}]\n\n`
            } else {
              result += `\`\`\`\nTool: ${part.tool}\n\`\`\`\n\n`
            }
          }
        }
        result += `---\n\n`
      }
      return result
    }

    // Format older messages more briefly (user prompts only, no tool outputs)
    const formatOlderMessages = (msgs: typeof messages) => {
      let result = ""
      for (const msg of msgs) {
        if (msg.info.role === "user") {
          result += `## User\n\n`
          for (const part of msg.parts) {
            if (part.type === "text" && !part.synthetic) {
              result += `${part.text}\n\n`
            }
          }
          result += `---\n\n`
        } else if (msg.info.role === "assistant") {
          // For assistant messages, just show a brief summary
          const textParts = msg.parts.filter((p) => p.type === "text" && !p.synthetic) as MessageV2.TextPart[]
          const toolParts = msg.parts.filter((p) => p.type === "tool") as MessageV2.ToolPart[]

          result += `## Assistant\n\n`
          if (textParts.length > 0) {
            // Take first 500 chars of text content
            const fullText = textParts.map((p) => p.text).join("\n")
            const truncated = fullText.length > 500 ? fullText.slice(0, 500) + "..." : fullText
            result += `${truncated}\n\n`
          }
          if (toolParts.length > 0) {
            const toolNames = [...new Set(toolParts.map((p) => p.tool))]
            result += `[Used tools: ${toolNames.join(", ")}]\n\n`
          }
          result += `---\n\n`
        }
      }
      return result
    }

    let transcript = ""

    if (!shouldTruncate) {
      // Small enough - include everything
      transcript = formatMessages(messages)
    } else if (lastCompactionIndex > 0 && compactionSummaries.length > 0) {
      // Has compaction summaries - use them for history
      transcript += `## Historical Context (Compaction Summaries)\n\n`
      for (let i = 0; i < compactionSummaries.length; i++) {
        transcript += `### Summary ${i + 1}\n\n${compactionSummaries[i]}\n\n---\n\n`
      }
      transcript += `## Recent Conversation\n\n`
      transcript += formatMessages(messages.slice(lastCompactionIndex + 1))
    } else {
      // No compaction summaries - use smart truncation
      // Keep last N exchanges in full, summarize older ones
      const recentStartIndex = findRecentExchangeStart(messages, MIN_RECENT_EXCHANGES)

      if (recentStartIndex > 0) {
        transcript += `## Earlier Conversation (Summarized)\n\n`
        transcript += formatOlderMessages(messages.slice(0, recentStartIndex))
        transcript += `## Recent Conversation (Full)\n\n`
        transcript += formatMessages(messages.slice(recentStartIndex))
      } else {
        // Not enough messages to split, just format all (should be rare if we're truncating)
        transcript += formatMessages(messages, true)
      }
    }

    // Final safety check - if still too long, hard truncate
    const finalTokens = Token.estimate(transcript)
    if (finalTokens > maxTokens) {
      log.warn("transcript still exceeds limit after truncation", {
        tokens: finalTokens,
        maxTokens,
      })
      // Keep the end (most recent content) and truncate from start
      const maxChars = maxTokens * 4
      if (transcript.length > maxChars) {
        transcript =
          `[Earlier content truncated due to length]\n\n---\n\n` + transcript.slice(transcript.length - maxChars + 100)
      }
    }

    return transcript
  }

  // Find the starting index to keep the last N user/assistant exchanges
  function findRecentExchangeStart(messages: MessageV2.WithParts[], minExchanges: number): number {
    let exchanges = 0
    let lastRole: "user" | "assistant" | null = null

    for (let i = messages.length - 1; i >= 0; i--) {
      const role = messages[i].info.role
      // Count an exchange when we see a user message followed by assistant response
      if (role === "user" && lastRole === "assistant") {
        exchanges++
        if (exchanges >= minExchanges) {
          return i
        }
      }
      lastRole = role
    }
    return 0
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
