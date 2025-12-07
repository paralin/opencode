import path from "path"
import { Session } from "."
import { Agent } from "../agent/agent"
import { Identifier } from "../id/id"
import { Instance } from "../project/instance"
import { Log } from "../util/log"
import { SessionPrompt } from "./prompt"
import { Bus } from "../bus"
import { MessageV2 } from "./message-v2"
import { SessionTranscript } from "./transcript"
import { Storage } from "../storage/storage"
import z from "zod"
import { fn } from "@/util/fn"

export namespace SessionKnowledge {
  const log = Log.create({ service: "session.knowledge" })

  export const Event = {
    Extracted: Bus.event(
      "session.knowledge.extracted",
      z.object({
        sessionID: z.string(),
        files: z.array(z.string()),
      }),
    ),
  }

  export interface KnowledgeFile {
    path: string
    summary?: string
  }

  export interface ExtractResult {
    knowledgeFiles: KnowledgeFile[]
    childSessionID: string
  }

  /**
   * Create an extraction part - triggers extraction in the prompt loop.
   */
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
        time: {
          created: Date.now(),
        },
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "extraction",
        extraction: {},
      })
    },
  )

  /**
   * Process extraction - called by the prompt loop when it detects an extraction part.
   * Stateless design: completion is determined by the prompt loop checking for an
   * assistant message after the extraction part, not by a status field.
   */
  export async function process(input: {
    parentID: string
    messages: MessageV2.WithParts[]
    sessionID: string
    model: {
      providerID: string
      modelID: string
    }
    agent: string
    abort: AbortSignal
  }): Promise<"continue" | "stop"> {
    log.info("processing knowledge extraction", { sessionID: input.sessionID })

    // Find the extraction part
    const isExtractionPart = (p: MessageV2.Part): p is MessageV2.ExtractionPart => p.type === "extraction"
    let extractionPart: MessageV2.ExtractionPart | undefined
    for (const msg of input.messages) {
      const part = msg.parts.find(isExtractionPart)
      if (part) {
        extractionPart = part
        break
      }
    }

    if (!extractionPart) {
      log.error("extraction part not found")
      return "stop"
    }

    // Stateless pattern: Skip if extraction already completed (has childSessionID)
    if (extractionPart.extraction.childSessionID) {
      log.info("extraction already completed", { childSessionID: extractionPart.extraction.childSessionID })
      return "stop"
    }

    await ensureDirectories()

    // Write transcript
    const dir = path.join(Instance.directory, ".opencode", "sess")
    const transcriptPath = path.join(dir, `${input.sessionID}.md`)
    await SessionTranscript.writeToFile(input.sessionID, transcriptPath)

    // Run extraction agent with error handling
    try {
      const result = await extract({
        extractionPart,
        sessionID: input.sessionID,
        transcriptPath,
        model: input.model,
        abort: input.abort,
      })

      // Update extraction part with final results (childSessionID already set in extract())
      await Session.updatePart({
        ...extractionPart,
        extraction: {
          childSessionID: result.childSessionID,
          files: result.knowledgeFiles,
        },
      })

      Bus.publish(Event.Extracted, {
        sessionID: input.sessionID,
        files: result.knowledgeFiles.map((f) => f.path),
      })
    } catch (error) {
      log.error("extraction failed", { error, sessionID: input.sessionID })
      // Child session ID is already set by extract(), marking it as attempted
      // Files will remain empty, indicating failure
      // User can check child session for details or manually retry with /knowledge
    }

    return "stop"
  }

  async function extract(input: {
    extractionPart: MessageV2.ExtractionPart
    sessionID: string
    transcriptPath: string
    model: { providerID: string; modelID: string }
    abort: AbortSignal
  }): Promise<ExtractResult> {
    log.info("extracting knowledge", { sessionID: input.sessionID })

    const agent = await Agent.get("knowledge-extractor")
    if (!agent) {
      const msg = "knowledge-extractor agent not found"
      log.error(msg)
      throw new Error(msg)
    }

    const session = await Session.create({
      parentID: input.sessionID,
      title: `Knowledge extraction (@${agent.name} subagent)`,
    })

    // Update parent extraction part with childSessionID immediately
    // This prevents re-processing if the extraction fails or hangs
    await Session.updatePart({
      ...input.extractionPart,
      extraction: {
        childSessionID: session.id,
      },
    })

    // Subscribe to tool updates from child session
    const summary: Array<{ tool: string; title?: string }> = []
    const unsubscribe = Bus.subscribe(MessageV2.Event.PartUpdated, async (evt) => {
      const part = evt.properties.part
      if (part.sessionID !== session.id) return
      if (part.type !== "tool") return
      if (part.state.status !== "completed") return

      const toolName = part.tool
      const title = part.state.title || undefined

      const exists = summary.some((s) => s.tool === toolName && s.title === title)
      if (!exists) {
        summary.push({ tool: toolName, title })

        // Fetch current part state to preserve status
        const current = await Storage.read<MessageV2.ExtractionPart>([
          "part",
          input.extractionPart.messageID,
          input.extractionPart.id,
        ])
        if (!current || current.type !== "extraction") return

        await Session.updatePart({
          ...current,
          extraction: {
            ...current.extraction,
            summary: [...summary],
          },
        })
      }
    })

    try {
      const messageID = Identifier.ascending("message")
      const prompt = buildExtractionPrompt(input.transcriptPath, input.sessionID)

      // Set up abort handler to cancel child session
      const abortHandler = () => {
        log.info("aborting child session", { childSessionID: session.id })
        SessionPrompt.cancel(session.id)
      }
      input.abort.addEventListener("abort", abortHandler)

      try {
        const result = await SessionPrompt.prompt({
          messageID,
          sessionID: session.id,
          model: input.model,
          agent: agent.name,
          tools: agent.tools,
          parts: [{ type: "text", text: prompt }],
        })

        const text = result.parts.findLast((x) => x.type === "text")?.text ?? ""
        const parsed = parseExtractionResult(text)
        return { ...parsed, childSessionID: session.id }
      } finally {
        input.abort.removeEventListener("abort", abortHandler)
      }
    } finally {
      unsubscribe()
    }
  }

  function buildExtractionPrompt(transcriptPath: string, sessionID: string): string {
    return [
      `Extract knowledge from the following session transcript.`,
      ``,
      `Transcript path: ${transcriptPath}`,
      `Session ID: ${sessionID}`,
      `Knowledge directory: ${path.join(Instance.directory, ".opencode", "knowledge")}`,
      ``,
      `Instructions:`,
      `1. Read the transcript file`,
      `2. Identify valuable, reusable knowledge (design decisions, bug resolutions, patterns)`,
      `3. If no valuable knowledge is found, return empty result`,
      `4. Check existing knowledge files in .opencode/knowledge/`,
      `5. Create new or merge into existing knowledge files`,
      `6. Return structured result with KNOWLEDGE_RESULT format`,
    ].join("\n")
  }

  function parseExtractionResult(text: string): Omit<ExtractResult, "childSessionID"> {
    const match = text.match(
      /KNOWLEDGE_RESULT:\s*\nfiles:\s*\[(.*?)\]\s*\nsubstantial:\s*(true|false)\s*\nfile_summaries:([\s\S]*?)(?:```|$)/s,
    )
    if (!match) {
      log.warn("could not parse knowledge result", { text: text.slice(-500) })
      return { knowledgeFiles: [] }
    }

    const filesStr = match[1].trim()
    const substantial = match[2] === "true"

    // If not substantial, return empty even if files were somehow listed
    if (!substantial) {
      log.info("no substantial knowledge found")
      return { knowledgeFiles: [] }
    }

    const filePaths = filesStr
      ? filesStr
          .split(",")
          .map((f) => f.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean)
      : []

    // Parse file_summaries section
    const summariesSection = match[3] || ""
    const summaryMap = new Map<string, string>()
    const summaryLines = summariesSection.split("\n").filter((line) => line.trim().startsWith("-"))
    for (const line of summaryLines) {
      const summaryMatch = line.match(/^-\s*([^:]+):\s*(.+)$/)
      if (summaryMatch) {
        const filepath = summaryMatch[1].trim()
        const desc = summaryMatch[2].trim()
        summaryMap.set(filepath, desc)
      }
    }

    const files: KnowledgeFile[] = filePaths.map((filepath) => ({
      path: filepath,
      summary: summaryMap.get(filepath),
    }))

    log.info("parsed knowledge result", { files, substantial })
    return { knowledgeFiles: files }
  }

  export async function list(): Promise<string[]> {
    const dir = path.join(Instance.directory, ".opencode", "knowledge")
    const glob = new Bun.Glob("*.md")
    const files = await Array.fromAsync(glob.scan({ cwd: dir, absolute: true })).catch(() => [])
    return files
  }

  export async function load(files: string[]): Promise<string[]> {
    const contents = await Promise.all(
      files.map(async (file) => {
        const filepath = path.isAbsolute(file) ? file : path.join(Instance.directory, file)
        const text = await Bun.file(filepath)
          .text()
          .catch(() => "")
        if (!text) return ""
        return `Knowledge from: ${filepath}\n${text}`
      }),
    )
    return contents.filter(Boolean)
  }

  async function ensureDirectories(): Promise<void> {
    const sessDir = path.join(Instance.directory, ".opencode", "sess")
    const knowledgeDir = path.join(Instance.directory, ".opencode", "knowledge")

    await Bun.write(path.join(sessDir, ".gitkeep"), "")
    await Bun.write(path.join(knowledgeDir, ".gitkeep"), "")
  }
}
