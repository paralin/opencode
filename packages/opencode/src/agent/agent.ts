import { Config } from "../config/config"
import z from "zod"
import { Provider } from "../provider/provider"
import { generateObject, type ModelMessage } from "ai"
import { SystemPrompt } from "../session/system"
import { Instance } from "../project/instance"
import { mergeDeep } from "remeda"
import { Log } from "../util/log"

const log = Log.create({ service: "agent" })

import PROMPT_GENERATE from "./generate.txt"
import PROMPT_COMPACTION from "./prompt/compaction.txt"
import PROMPT_EXPLORE from "./prompt/explore.txt"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import PROMPT_TITLE from "./prompt/title.txt"

export namespace Agent {
  export const Info = z
    .object({
      name: z.string(),
      description: z.string().optional(),
      mode: z.enum(["subagent", "primary", "all"]),
      native: z.boolean().optional(),
      hidden: z.boolean().optional(),
      default: z.boolean().optional(),
      topP: z.number().optional(),
      temperature: z.number().optional(),
      color: z.string().optional(),
      permission: z.object({
        edit: Config.Permission,
        bash: z.record(z.string(), Config.Permission),
        webfetch: Config.Permission.optional(),
        doom_loop: Config.Permission.optional(),
        external_directory: Config.Permission.optional(),
      }),
      model: z
        .object({
          modelID: z.string(),
          providerID: z.string(),
        })
        .optional(),
      prompt: z.string().optional(),
      tools: z.record(z.string(), z.boolean()),
      options: z.record(z.string(), z.any()),
      maxSteps: z.number().int().positive().optional(),
    })
    .meta({
      ref: "Agent",
    })
  export type Info = z.infer<typeof Info>

  const state = Instance.state(async () => {
    const cfg = await Config.get()
    const defaultTools = cfg.tools ?? {}
    const defaultPermission: Info["permission"] = {
      edit: "allow",
      bash: {
        "*": "allow",
      },
      webfetch: "allow",
      doom_loop: "ask",
      external_directory: "ask",
    }
    const agentPermission = mergeAgentPermissions(defaultPermission, cfg.permission ?? {})

    const planPermission = mergeAgentPermissions(
      {
        edit: "deny",
        bash: {
          "cut*": "allow",
          "diff*": "allow",
          "du*": "allow",
          "file *": "allow",
          "find * -delete*": "ask",
          "find * -exec*": "ask",
          "find * -fprint*": "ask",
          "find * -fls*": "ask",
          "find * -fprintf*": "ask",
          "find * -ok*": "ask",
          "find *": "allow",
          "git diff*": "allow",
          "git log*": "allow",
          "git show*": "allow",
          "git status*": "allow",
          "git branch": "allow",
          "git branch -v": "allow",
          "grep*": "allow",
          "head*": "allow",
          "less*": "allow",
          "ls*": "allow",
          "more*": "allow",
          "pwd*": "allow",
          "rg*": "allow",
          "sort --output=*": "ask",
          "sort -o *": "ask",
          "sort*": "allow",
          "stat*": "allow",
          "tail*": "allow",
          "tree -o *": "ask",
          "tree*": "allow",
          "uniq*": "allow",
          "wc*": "allow",
          "whereis*": "allow",
          "which*": "allow",
          "*": "ask",
        },
        webfetch: "allow",
      },
      cfg.permission ?? {},
    )

    const result: Record<string, Info> = {
      build: {
        name: "build",
        tools: { ...defaultTools },
        options: {},
        permission: agentPermission,
        mode: "primary",
        native: true,
      },
      plan: {
        name: "plan",
        options: {},
        permission: planPermission,
        tools: {
          ...defaultTools,
        },
        mode: "primary",
        native: true,
      },
      general: {
        name: "general",
        description: `General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.`,
        tools: {
          todoread: false,
          todowrite: false,
          ...defaultTools,
        },
        options: {},
        permission: agentPermission,
        mode: "subagent",
        native: true,
        hidden: true,
      },
      explore: {
        name: "explore",
        tools: {
          todoread: false,
          todowrite: false,
          edit: false,
          write: false,
          ...defaultTools,
        },
        description: `Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.`,
        prompt: PROMPT_EXPLORE,
        options: {},
        permission: agentPermission,
        mode: "subagent",
        native: true,
      },
      compaction: {
        name: "compaction",
        mode: "primary",
        native: true,
        hidden: true,
        prompt: PROMPT_COMPACTION,
        tools: {
          "*": false,
        },
        options: {},
        permission: agentPermission,
      },
      title: {
        name: "title",
        mode: "primary",
        options: {},
        native: true,
        hidden: true,
        permission: agentPermission,
        prompt: PROMPT_TITLE,
        tools: {},
      },
      summary: {
        name: "summary",
        mode: "primary",
        options: {},
        native: true,
        hidden: true,
        permission: agentPermission,
        prompt: PROMPT_SUMMARY,
        tools: {},
      },
      "knowledge-extractor": {
        name: "knowledge-extractor",
        description: "Extracts reusable knowledge from sessions into markdown files",
        tools: {
          read: true,
          write: true,
          edit: true,
          glob: true,
          grep: true,
          list: true,
          bash: false,
          webfetch: false,
          task: false,
          todoread: false,
          todowrite: false,
          websearch: false,
          codesearch: false,
        },
        prompt: [
          `You are a knowledge extraction specialist. Your role is to preserve valuable planning and insights from session transcripts.`,
          ``,
          `## Context`,
          `The session transcript is provided directly in your prompt within <transcript> tags. For long sessions, this may be truncated to include:`,
          `- Historical Context (compaction summaries from earlier parts)`,
          `- Recent Conversation (the most recent exchanges)`,
          ``,
          `Focus your knowledge extraction on the Recent Conversation section. Compaction summaries provide context but may also contain reusable knowledge worth preserving.`,
          ``,
          `## Your Process`,
          `1. Review the transcript in your prompt`,
          `2. Identify valuable knowledge worth preserving`,
          `3. Check existing knowledge files with Glob/Read`,
          `4. Decide: update existing file OR create new file (see guidelines below)`,
          `5. Use Edit to update or Write to create`,
          `6. Return a summary of files created/updated`,
          ``,
          `## When to Update vs Create New File`,
          `**Update existing file** when the new knowledge:`,
          `- Is about THE SAME system/feature the file documents`,
          `- Adds details, corrections, or new cases for that specific topic`,
          `- Example: Adding a new edge case to "auth-flow.md" about the auth system`,
          ``,
          `**Create new file** when the new knowledge:`,
          `- Is about a DIFFERENT system/feature, even if tangentially related`,
          `- Would require changing the file's title/scope to fit`,
          `- Example: Knowledge about "knowledge-extractor truncation" does NOT belong in "async-patterns.md" just because both mention sessions`,
          ``,
          `**Key test**: Read the existing file's title and first section. If your new content requires a different title to make sense, create a new file.`,
          ``,
          `## Key Principle: Preserve, Don't Rewrite`,
          `The transcript often contains beautifully structured plans and reasoning. Your job is to:`,
          `- Extract and preserve valuable content largely verbatim`,
          `- Remove noise (tool outputs, debugging, ephemeral details)`,
          `- Make minimal edits for flow and clarity`,
          ``,
          `Do NOT heavily summarize good content. The assistant already did the hard work.`,
          ``,
          `## What to Keep`,
          `- Architectural decisions and rationale`,
          `- Planning sections with reasoning`,
          `- Clarifying questions and answers`,
          `- Non-obvious patterns and conventions`,
          `- Bug root causes and prevention strategies`,
          `- Gotchas that would otherwise be re-discovered`,
          `- Knowledge from compaction summaries (decisions, patterns, insights)`,
          ``,
          `## What to Exclude`,
          `- Raw tool outputs (file contents, grep results, etc.)`,
          `- Debugging back-and-forth that led nowhere`,
          `- Session-specific implementation logs`,
          `- Generic programming knowledge`,
          `- Ephemeral details (what we did, what to do next)`,
          `- Task status updates from compaction summaries`,
          ``,
          `## When to Skip Entirely`,
          `If the session has no planning/decision content worth preserving, respond "No knowledge worth extracting from this session."`,
          ``,
          `## File Format`,
          `Write knowledge files with YAML frontmatter:`,
          `\`\`\`markdown`,
          `---`,
          `created: YYYY-MM-DD`,
          `source_sessions:`,
          `  - <session-id>`,
          `---`,
          ``,
          `# Topic Title`,
          ``,
          `Content here...`,
          `\`\`\``,
          ``,
          `## Naming Convention`,
          `Use descriptive kebab-case: draggable-tabs-design.md, api-patterns.md, auth-flow.md`,
        ].join("\n"),
        options: {},
        permission: {
          edit: "allow",
          bash: { "*": "deny" },
          webfetch: "deny",
          doom_loop: "deny",
          external_directory: "ask",
        },
        mode: "subagent",
        native: true,
      },
    }
    for (const [key, value] of Object.entries(cfg.agent ?? {})) {
      if (value.disable) {
        delete result[key]
        continue
      }
      let item = result[key]
      if (!item)
        item = result[key] = {
          name: key,
          mode: "all",
          permission: agentPermission,
          options: {},
          tools: {},
          native: false,
        }
      const {
        name,
        model,
        prompt,
        tools,
        description,
        temperature,
        top_p,
        mode,
        permission,
        color,
        maxSteps,
        ...extra
      } = value
      item.options = {
        ...item.options,
        ...extra,
      }
      if (model) item.model = Provider.parseModel(model)
      if (prompt) item.prompt = prompt
      if (tools)
        item.tools = {
          ...item.tools,
          ...tools,
        }
      item.tools = {
        ...defaultTools,
        ...item.tools,
      }
      if (description) item.description = description
      if (temperature != undefined) item.temperature = temperature
      if (top_p != undefined) item.topP = top_p
      if (mode) item.mode = mode
      if (color) item.color = color
      // just here for consistency & to prevent it from being added as an option
      if (name) item.name = name
      if (maxSteps != undefined) item.maxSteps = maxSteps

      if (permission ?? cfg.permission) {
        item.permission = mergeAgentPermissions(cfg.permission ?? {}, permission ?? {})
      }
    }

    // Mark the default agent
    const defaultName = cfg.default_agent ?? "build"
    const defaultCandidate = result[defaultName]
    if (defaultCandidate && defaultCandidate.mode !== "subagent") {
      defaultCandidate.default = true
    } else {
      // Fall back to "build" if configured default is invalid
      if (result["build"]) {
        result["build"].default = true
      }
    }

    const hasPrimaryAgents = Object.values(result).filter((a) => a.mode !== "subagent" && !a.hidden).length > 0
    if (!hasPrimaryAgents) {
      throw new Config.InvalidError({
        path: "config",
        message: "No primary agents are available. Please configure at least one agent with mode 'primary' or 'all'.",
      })
    }

    return result
  })

  export async function get(agent: string) {
    return state().then((x) => x[agent])
  }

  export async function list() {
    return state().then((x) => Object.values(x))
  }

  export async function defaultAgent(): Promise<string> {
    const agents = await state()
    const defaultCandidate = Object.values(agents).find((a) => a.default)
    return defaultCandidate?.name ?? "build"
  }

  export async function generate(input: { description: string; model?: { providerID: string; modelID: string } }) {
    const cfg = await Config.get()
    const defaultModel = input.model ?? (await Provider.defaultModel())
    const model = await Provider.getModel(defaultModel.providerID, defaultModel.modelID)
    const language = await Provider.getLanguage(model)
    const system = SystemPrompt.header(defaultModel.providerID)
    system.push(PROMPT_GENERATE)
    const existing = await list()
    const result = await generateObject({
      experimental_telemetry: {
        isEnabled: cfg.experimental?.openTelemetry,
        metadata: {
          userId: cfg.username ?? "unknown",
        },
      },
      temperature: 0.3,
      messages: [
        ...system.map(
          (item): ModelMessage => ({
            role: "system",
            content: item,
          }),
        ),
        {
          role: "user",
          content: `Create an agent configuration based on this request: \"${input.description}\".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing.map((i) => i.name).join(", ")}\n  Return ONLY the JSON object, no other text, do not wrap in backticks`,
        },
      ],
      model: language,
      schema: z.object({
        identifier: z.string(),
        whenToUse: z.string(),
        systemPrompt: z.string(),
      }),
    })
    return result.object
  }
}

function mergeAgentPermissions(basePermission: any, overridePermission: any): Agent.Info["permission"] {
  if (typeof basePermission.bash === "string") {
    basePermission.bash = {
      "*": basePermission.bash,
    }
  }
  if (typeof overridePermission.bash === "string") {
    overridePermission.bash = {
      "*": overridePermission.bash,
    }
  }
  const merged = mergeDeep(basePermission ?? {}, overridePermission ?? {}) as any
  let mergedBash
  if (merged.bash) {
    if (typeof merged.bash === "string") {
      mergedBash = {
        "*": merged.bash,
      }
    } else if (typeof merged.bash === "object") {
      mergedBash = mergeDeep(
        {
          "*": "allow",
        },
        merged.bash,
      )
    }
  }

  const result: Agent.Info["permission"] = {
    edit: merged.edit ?? "allow",
    webfetch: merged.webfetch ?? "allow",
    bash: mergedBash ?? { "*": "allow" },
    doom_loop: merged.doom_loop,
    external_directory: merged.external_directory,
  }

  return result
}
