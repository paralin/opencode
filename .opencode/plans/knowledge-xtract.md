# Knowledge-Aware Compaction

## Overview

When compaction occurs, the feature will:

1. Export the session transcript to `.opencode/sess/<session-id>.md`
2. Spawn a sub-agent to extract valuable knowledge from the transcript
3. Move/merge the refined knowledge into `.opencode/knowledge/` files
4. Reference knowledge files in the compacted summary message

---

## Flow

```
Compaction Triggered
        │
        ▼
┌───────────────────────────────────────┐
│ Stage 1: Knowledge Extraction         │
│ ─────────────────────────────────────│
│ 1. Export session to .opencode/sess/  │
│ 2. Spawn knowledge-extractor agent    │
│ 3. Agent reads transcript             │
│ 4. Agent decides:                     │
│    - Create new knowledge file?       │
│    - Merge into existing file?        │
│    - No substantial knowledge?        │
│ 5. Return knowledge file paths        │
└───────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────┐
│ Stage 2: Enhanced Compaction          │
│ ─────────────────────────────────────│
│ 1. Get list of relevant knowledge     │
│    files (newly created + previously  │
│    referenced in session)             │
│ 2. Generate summary with references   │
│    to knowledge files                 │
│ 3. Knowledge files loaded into prompt │
│    only when explicitly referenced    │
└───────────────────────────────────────┘
        │
        ▼
   Continue Session
```

---

## Configuration

Add to `packages/opencode/src/config/config.ts` in the `Info` schema:

```typescript
compaction: z.object({
  extract_knowledge: z
    .boolean()
    .optional()
    .default(false)
    .describe("Extract and persist knowledge when compacting sessions"),
  cleanup_transcripts: z
    .boolean()
    .optional()
    .default(true)
    .describe("Delete session transcripts after knowledge extraction"),
  auto_load_knowledge: z
    .boolean()
    .optional()
    .default(false)
    .describe("Auto-load all knowledge files into system prompt (vs only referenced)"),
}).optional()
```

---

## Directory structure

```
.opencode/
├── sess/                        # Raw session transcripts (temporary)
│   └── ses_abc123.md
├── knowledge/                   # Persistent knowledge files
│   ├── api-design-decisions.md
│   ├── authentication-flow.md
│   └── testing-patterns.md
├── agent/                       # (existing)
├── command/                     # (existing)
└── ...
```

---

## Knowledge file format

Files include frontmatter tracking provenance:

```markdown
---
created: 2025-12-04
source_sessions:
  - ses_abc123
  - ses_def456
last_updated: 2025-12-04
---

# Authentication Flow

Design decisions and learnings about authentication...
```

---

## Create files

### `packages/opencode/src/session/export.ts`

Reusable session export extracted from TUI:

```typescript
export namespace SessionExport {
  export async function toMarkdown(sessionID: string): Promise<string>
  export async function writeToFile(sessionID: string, filepath: string): Promise<void>
}
```

### `packages/opencode/src/session/knowledge.ts`

Knowledge extraction orchestration:

```typescript
export namespace SessionKnowledge {
  export interface ExtractResult {
    knowledgeFiles: string[] // Paths to created/modified knowledge files
    hasSubstantialKnowledge: boolean
  }

  export async function extract(input: {
    sessionID: string
    transcriptPath: string
    model: { providerID: string; modelID: string }
  }): Promise<ExtractResult>

  export async function list(): Promise<string[]>

  export async function load(files: string[]): Promise<string[]>
}
```

### `packages/opencode/src/session/prompt/knowledge-extractor.txt`

```
You are a knowledge extraction specialist. Analyze the conversation transcript and extract valuable, reusable knowledge that would benefit future sessions.

## Extract

**Design Decisions**
- Architectural choices and rationale
- API design patterns
- Trade-offs considered

**Technical Specifications**
- Data structures and schemas
- Protocol/interface specifications
- Configuration patterns

**Bug Resolutions**
- Root causes identified
- Solutions implemented
- Prevention strategies

**Codebase Learnings**
- Project structure insights
- Naming conventions
- Framework-specific patterns
- Important file locations

**User Preferences**
- Coding style preferences
- Tool preferences
- Project-specific rules

## Do not extract

- Step-by-step debugging logs
- Raw tool outputs
- Verbose code dumps (brief references OK)
- Transient discussion
- Routine operations

## Tools available

- `read` - Read transcript and existing knowledge files
- `write` - Create new knowledge files
- `edit` - Merge into existing knowledge files
- `glob` - Find existing knowledge files
- `grep` - Search knowledge file contents

## Process

1. Read the transcript at the provided path
2. Identify substantial knowledge worth preserving
3. Check `.opencode/knowledge/` for existing files that might be merge targets
4. Either:
   a) Create new file with descriptive name (e.g., `authentication-flow.md`)
   b) Merge into existing relevant file
   c) If no substantial knowledge, indicate clearly

Knowledge files must include frontmatter:

---
created: <date>
source_sessions:
  - <session-id>
last_updated: <date>
---

When merging, update `source_sessions` and `last_updated`.

## Response

Return a summary indicating:
- Knowledge files created/modified (paths)
- Whether substantial knowledge was extracted
- Brief description of what was captured
```

---

## Modify files

### `packages/opencode/src/config/config.ts`

Add compaction config schema (see Configuration section above).

### `packages/opencode/src/agent/agent.ts`

Add built-in `knowledge-extractor` agent around line 102:

```typescript
"knowledge-extractor": {
  name: "knowledge-extractor",
  description: "Extracts reusable knowledge from session transcripts. Internal use only.",
  tools: {
    read: true,
    write: true,
    edit: true,
    glob: true,
    grep: true,
    task: false,
    bash: false,
    webfetch: false,
    todoread: false,
    todowrite: false,
  },
  prompt: KNOWLEDGE_EXTRACTOR_PROMPT,
  mode: "subagent",
  builtIn: true,
  permission: {
    edit: "allow",
    bash: { "*": "deny" },
    webfetch: "deny",
  },
}
```

### `packages/opencode/src/session/compaction.ts`

Modify `process()` to integrate knowledge extraction:

```typescript
export async function process(input: {...}) {
  const config = await Config.get()

  let knowledgeFiles: string[] = []

  // Stage 1: Extract knowledge (if enabled)
  if (config.compaction?.extract_knowledge) {
    const sessDir = path.join(Instance.directory, ".opencode", "sess")
    await ensureDir(sessDir)

    const transcriptPath = path.join(sessDir, `${input.sessionID}.md`)
    await SessionExport.writeToFile(input.sessionID, transcriptPath)

    const result = await SessionKnowledge.extract({
      sessionID: input.sessionID,
      transcriptPath,
      model: input.model,
    })

    knowledgeFiles = result.knowledgeFiles

    // Cleanup transcript if configured
    if (config.compaction?.cleanup_transcripts !== false) {
      await Bun.file(transcriptPath).delete()
    }
  }

  // Stage 2: Generate summary with knowledge references
  const knowledgeReference = knowledgeFiles.length > 0
    ? `\n\nRelevant knowledge files: ${knowledgeFiles.join(", ")}`
    : ""

  // Modify summarization prompt to include references
  // ... existing process() logic with enhanced prompt
}
```

### `packages/opencode/src/session/system.ts`

Add function to load knowledge files:

```typescript
export async function knowledge(files?: string[]) {
  const knowledgeDir = path.join(Instance.directory, ".opencode", "knowledge")

  let targets: string[]
  if (files) {
    // Load only specified files
    targets = files.map((f) => (path.isAbsolute(f) ? f : path.join(knowledgeDir, f)))
  } else {
    // Load all knowledge files
    targets = await Array.fromAsync(new Bun.Glob("*.md").scan({ cwd: knowledgeDir, absolute: true })).catch(() => [])
  }

  const contents = await Promise.all(
    targets.map(async (file) => {
      const text = await Bun.file(file)
        .text()
        .catch(() => "")
      if (!text) return ""
      return `Knowledge from: ${file}\n${text}`
    }),
  )

  return contents.filter(Boolean)
}
```

### `packages/opencode/src/session/prompt/compaction.txt`

Enhance to handle knowledge references:

```
You are a helpful AI assistant tasked with summarizing conversations.

When asked to summarize, provide a detailed but concise summary of the conversation.
Focus on information that would be helpful for continuing the conversation, including:
- What was done
- What is currently being worked on
- Which files are being modified
- What needs to be done next
- Key user requests, constraints, or preferences that should persist
- Important technical decisions and why they were made

If knowledge files were created or referenced during this session, include them in your summary:
- List paths to relevant knowledge files
- These will be loaded into context when the session continues

Your summary should be comprehensive enough to provide context but concise enough to be quickly understood.
```

### `packages/opencode/src/session/prompt.ts`

Parse knowledge file references from compacted summary and load them:

```typescript
// When building messages after compaction, check for knowledge references
// in the summary message and load those files via SystemPrompt.knowledge()
```

---

## Decisions

| Question                              | Decision                                                                          |
| ------------------------------------- | --------------------------------------------------------------------------------- |
| Cleanup `.opencode/sess/` transcripts | Configurable via `cleanup_transcripts`, default `true`                            |
| Knowledge loading scope               | Only when referenced in compacted message, configurable via `auto_load_knowledge` |
| Knowledge file format                 | Include frontmatter with created, source_sessions, last_updated                   |
| Auto vs manual compaction behavior    | Same behavior for both                                                            |
| Knowledge merge conflicts             | Always attempt merge, trust agent capability                                      |
| Track source sessions                 | Yes, in frontmatter `source_sessions` array                                       |
