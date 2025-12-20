# `/knowledge` Feature Rework: In-line Extraction

## Status: IMPLEMENTED

All parts have been completed:

- [x] Part 1: Schema changes in `message-v2.ts`
- [x] Part 2: Created `knowledge.ts` with `SessionKnowledge` namespace
- [x] Part 3: Updated `prompt.ts` to handle extraction parts
- [x] Part 4: Simplified `server.ts` extract-knowledge endpoint
- [x] Part 5: Updated TUI `session/index.tsx` for extraction divider and collapsed text
- [x] Part 6: Regenerated SDK types

## Overview

Rework `/knowledge` to run in-line (like compaction) instead of spawning a sub-agent. After completion, collapse the assistant's response to a brief summary while preserving the full content in storage.

## Current Implementation (To Be Replaced)

Currently, `/knowledge` works by:

1. TUI triggers `command.trigger("session.knowledge")`
2. Server builds transcript, creates `SubtaskPart` pointing to `knowledge-extractor` agent
3. Prompt loop spawns a **child session** (sub-agent)
4. User must navigate to child session to see progress

## Target Implementation (Like Compaction)

1. User types `/knowledge`
2. TUI triggers `session.knowledge` command
3. Server calls `SessionKnowledge.create()` → creates user message with `ExtractionPart`
4. Prompt loop detects `ExtractionPart`, calls `SessionKnowledge.process()`
5. Knowledge extractor runs **in-line** with tools (read/write/edit/glob/grep/list)
6. Model extracts knowledge, writes to `.opencode/knowledge/`
7. After completion, `collapse()` updates text parts with brief summary
8. Loop exits (returns "stop") - does NOT continue previous conversation
9. TUI shows:
   - Divider: `─── Knowledge Extract ───`
   - Collapsed summary: "Updated knowledge in .opencode/knowledge/auth-flow.md"

---

## Part 1: Schema Changes (`message-v2.ts`)

### 1.1 Add `ExtractionPart`

After `CompactionPart` definition (around line 156):

```typescript
export const ExtractionPart = PartBase.extend({
  type: z.literal("extraction"),
}).meta({
  ref: "ExtractionPart",
})
export type ExtractionPart = z.infer<typeof ExtractionPart>
```

### 1.2 Add to Part union

Add `ExtractionPart` to the discriminated union (around line 327):

```typescript
export const Part = z.discriminatedUnion("type", [
  TextPart,
  SubtaskPart,
  ReasoningPart,
  FilePart,
  ToolPart,
  StepStartPart,
  StepFinishPart,
  SnapshotPart,
  PatchPart,
  AgentPart,
  RetryPart,
  CompactionPart,
  ExtractionPart, // ADD THIS
])
```

### 1.3 Add `collapsed` field to `TextPart`

Add optional field to store collapsed content (around line 61):

```typescript
export const TextPart = PartBase.extend({
  type: z.literal("text"),
  text: z.string(),
  synthetic: z.boolean().optional(),
  ignored: z.boolean().optional(),
  collapsed: z.string().optional(), // Summary to display when collapsed
  time: z
    .object({
      start: z.number(),
      end: z.number().optional(),
    })
    .optional(),
  metadata: z.record(z.string(), z.any()).optional(),
}).meta({
  ref: "TextPart",
})
```

When `collapsed` is set:

- **TUI**: Show `collapsed` value instead of `text`
- **LLM context**: Skip this part entirely

### 1.4 Update `toModelMessage` for extraction

Add handling similar to compaction in `toModelMessage` function (around line 448):

```typescript
if (part.type === "extraction") {
  userMessage.parts.push({
    type: "text",
    text: "Extract knowledge from this session and update knowledge files.",
  })
}
```

And skip collapsed text parts from LLM context (around line 434):

```typescript
if (part.type === "text" && !part.ignored && !part.collapsed)
```

---

## Part 2: Create `SessionKnowledge` Namespace (`knowledge.ts`)

Create new file: `packages/opencode/src/session/knowledge.ts`

### 2.1 Imports and Setup

```typescript
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
```

### 2.2 `create()` function

Similar to `SessionCompaction.create()`:

```typescript
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
```

### 2.3 `process()` function

Core extraction logic:

```typescript
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

  // Build transcript for knowledge extraction
  const transcript = buildTranscript(input.messages)
  const knowledgeDir = path.join(Instance.directory, ".opencode", "knowledge")

  const msg = (await Session.updateMessage({
    id: Identifier.ascending("message"),
    role: "assistant",
    parentID: input.parentID,
    sessionID: input.sessionID,
    mode: "knowledge-extractor",
    agent: "knowledge-extractor",
    summary: true, // Mark as summary to affect context filtering
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

  // Resolve tools for knowledge-extractor agent
  const tools = await resolveKnowledgeTools({
    agent,
    sessionID: input.sessionID,
    model,
    processor,
  })

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
  const files = await getExtractedFiles(input.sessionID, msg.id)
  Bus.publish(Event.Extracted, { sessionID: input.sessionID, files })

  return "stop" // Always stop after knowledge extraction
}
```

### 2.4 `buildTranscript()` helper

```typescript
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
```

### 2.5 `collapse()` helper

After extraction completes, collapse assistant message text parts:

```typescript
async function collapse(input: { sessionID: string; messageID: string }) {
  const parts = await MessageV2.parts(input.messageID)
  const files = await getExtractedFiles(input.sessionID, input.messageID)

  // Build summary text
  const summary =
    files.length > 0
      ? `Updated knowledge in ${files.map((f) => path.relative(Instance.directory, f)).join(", ")}`
      : "No knowledge files updated"

  // Find and update text parts
  for (const part of parts) {
    if (part.type === "text" && !part.synthetic && part.text.trim()) {
      await Session.updatePart({
        ...part,
        collapsed: summary,
      })
      break // Only collapse the first substantive text part
    }
  }
}
```

### 2.6 `getExtractedFiles()` helper

Extract file paths from tool calls:

```typescript
async function getExtractedFiles(sessionID: string, messageID: string): Promise<string[]> {
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

  return [...new Set(files)] // Deduplicate
}
```

### 2.7 `resolveKnowledgeTools()` helper

Resolve only the tools allowed for knowledge extraction:

```typescript
async function resolveKnowledgeTools(input: {
  agent: Agent.Info
  model: Provider.Model
  sessionID: string
  processor: SessionProcessor.Info
}) {
  // Import resolveTools logic or call it with restricted tool set
  // The knowledge-extractor agent already has tool restrictions defined:
  // read, write, edit, glob, grep, list = true
  // bash, webfetch, task, todoread, todowrite, websearch, codesearch = false
  // This will be handled by the existing resolveTools function using agent.tools
  // Just need to import and use it
}
```

Note: We can reuse the existing `resolveTools` from `prompt.ts` - just need to export it or duplicate the logic.

---

## Part 3: Prompt Loop Changes (`prompt.ts`)

### 3.1 Import SessionKnowledge

At top of file:

```typescript
import { SessionKnowledge } from "./knowledge"
```

### 3.2 Add extraction part detection

Update task detection (around line 259):

```typescript
const isExtractionPart = (p: MessageV2.Part): p is MessageV2.ExtractionPart => p.type === "extraction"
const task = msg.parts.filter(
  (part) => part.type === "compaction" || part.type === "subtask" || part.type === "extraction",
)
```

Or add `ExtractionPart` type predicate and include in the filter.

### 3.3 Add extraction processing

After compaction handling (around line 456), add:

```typescript
// pending extraction
if (task?.type === "extraction") {
  const result = await SessionKnowledge.process({
    messages: msgs,
    parentID: lastUser.id,
    abort,
    sessionID,
  })
  if (result === "stop") break
  continue
}
```

---

## Part 4: Server Changes (`server.ts`)

### 4.1 Import SessionKnowledge

At top of file:

```typescript
import { SessionKnowledge } from "../session/knowledge"
```

### 4.2 Simplify extract-knowledge endpoint

Replace current implementation (lines 1114-1250) with:

```typescript
.post(
  "/session/:id/extract-knowledge",
  describeRoute({
    description: "Extract knowledge from the session",
    operationId: "session.extractKnowledge",
    responses: {
      200: {
        description: "Knowledge extraction initiated",
        content: {
          "application/json": {
            schema: resolver(z.boolean()),
          },
        },
      },
      ...errors(400, 404),
    },
  }),
  validator(
    "param",
    z.object({
      id: z.string().meta({ description: "Session ID" }),
    }),
  ),
  validator(
    "json",
    z.object({
      providerID: z.string(),
      modelID: z.string(),
    }),
  ),
  async (c) => {
    const id = c.req.valid("param").id
    const body = c.req.valid("json")

    // Get current agent from last user message
    const msgs = await Session.messages({ sessionID: id })
    let currentAgent = "build"
    for (let i = msgs.length - 1; i >= 0; i--) {
      const info = msgs[i].info
      if (info.role === "user") {
        currentAgent = info.agent || "build"
        break
      }
    }

    await SessionKnowledge.create({
      sessionID: id,
      agent: currentAgent,
      model: {
        providerID: body.providerID,
        modelID: body.modelID,
      },
    })

    await SessionPrompt.loop(id)
    return c.json(true)
  },
)
```

---

## Part 5: TUI Changes (`session/index.tsx`)

### 5.1 Add extraction divider in `UserMessage`

Add memo (around line 1028):

```typescript
const extraction = createMemo(() => props.parts.find((x) => x.type === "extraction"))
```

Add rendering after compaction Show block (around line 1102):

```typescript
<Show when={extraction()}>
  <box
    marginTop={1}
    border={["top"]}
    title=" Knowledge Extract "
    titleAlignment="center"
    borderColor={theme.borderActive}
  />
</Show>
```

### 5.2 Handle collapsed text parts in `TextPart` component

Modify `TextPart` function (around line 1213):

```typescript
function TextPart(props: { last: boolean; part: TextPart; message: AssistantMessage }) {
  const ctx = use()
  const { theme, syntax } = useTheme()

  // Use collapsed text if available, otherwise use full text
  const displayText = createMemo(() => props.part.collapsed ?? props.part.text)
  const isCollapsed = createMemo(() => !!props.part.collapsed)

  return (
    <Show when={displayText().trim()}>
      <box id={"text-" + props.part.id} paddingLeft={3} marginTop={1} flexShrink={0}>
        <code
          filetype="markdown"
          drawUnstyledText={false}
          streaming={true}
          syntaxStyle={syntax()}
          content={displayText().trim()}
          conceal={ctx.conceal()}
          fg={isCollapsed() ? theme.textMuted : theme.text}
        />
      </box>
    </Show>
  )
}
```

---

## Part 6: SDK Regeneration

After all schema changes, regenerate SDK:

```bash
cd packages/sdk/js && bun ./script/build.ts
```

---

## File Changes Summary

| File                                                         | Action     | Changes                                                                                           |
| ------------------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------- |
| `packages/opencode/src/session/message-v2.ts`                | Modify     | Add `ExtractionPart`, add `collapsed` to `TextPart`, update `Part` union, update `toModelMessage` |
| `packages/opencode/src/session/knowledge.ts`                 | **Create** | `SessionKnowledge` namespace with `create()`, `process()`, `collapse()`, helpers                  |
| `packages/opencode/src/session/prompt.ts`                    | Modify     | Import `SessionKnowledge`, add extraction part detection and processing                           |
| `packages/opencode/src/server/server.ts`                     | Modify     | Import `SessionKnowledge`, simplify extract-knowledge endpoint                                    |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` | Modify     | Add extraction divider, handle collapsed text display                                             |
| `packages/sdk/js/`                                           | Regenerate | SDK types after schema changes                                                                    |

---

## Implementation Order

1. **message-v2.ts** - Schema changes first (ExtractionPart, collapsed field)
2. **knowledge.ts** - New file with SessionKnowledge namespace
3. **prompt.ts** - Add extraction handling to prompt loop
4. **server.ts** - Simplify endpoint to use SessionKnowledge
5. **session/index.tsx** - TUI changes for rendering
6. **SDK** - Regenerate after all changes
7. **Test** - Manual testing of /knowledge command

---

## Behavior Summary

| Aspect                  | Before (Sub-agent)         | After (In-line)     |
| ----------------------- | -------------------------- | ------------------- |
| Execution               | Child session              | Same session        |
| Progress visibility     | Navigate to child          | See in current chat |
| After completion        | Child session persists     | Collapsed summary   |
| Continues previous task | Yes (via parent)           | No (stops)          |
| Context pollution       | Minimal (separate session) | Minimal (collapsed) |
