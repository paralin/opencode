---
created: 2025-12-06
source_sessions:
  - ses_50914869bffeGnRtA8TqLvmjoh
  - ses_507bb2caeffe68UQIrqDiOty5E
last_updated: 2025-12-08
---

# Child Session Patterns

## Eager Completion Marking

When spawning child sessions for async work, set completion markers BEFORE awaiting results:

```typescript
// Create child session
const childSession = await Session.create({ ... })

// Mark attempted IMMEDIATELY (prevents infinite retries on restart)
await updatePart({ childSessionID: childSession.id })

// Then do the work
try {
  const result = await SessionPrompt.prompt({ sessionID: childSession.id })
  await updatePart({ childSessionID: childSession.id, files: result.files })
} catch (error) {
  // Already marked attempted, won't retry forever
}
```

**Why**: If the child session hangs or crashes, the completion marker prevents infinite retries on restart.

## UI State Clarity

Don't set result fields to empty arrays before completion:

```typescript
// BAD: Can't tell "in-progress" from "completed with no results"
await updatePart({ files: [] }) // Set eagerly
// ... later ...
await updatePart({ files: actualResults })

// GOOD: undefined means in-progress, [] means completed with no results
await updatePart({ files: undefined }) // Initially
// ... later ...
await updatePart({ files: actualResults || [] }) // On completion
```

Or use explicit status fields: `status: 'pending' | 'completed' | 'failed'`

## Standard Subtask Pattern

Prefer SubtaskPart + Task tool over custom part types:

```typescript
// Server creates SubtaskPart
await Session.updatePart({
  type: "subtask",
  prompt: "Extract knowledge from session",
  description: "Extract knowledge",
  agent: "knowledge-extractor",
})
```

Benefits:

- Automatic UI integration
- Standard OpenAPI/SDK generation
- No custom message schemas needed

## OpenAPI/SDK Workflow

After modifying server routes:

1. Regenerate OpenAPI: `bun dev generate` (in opencode package)
2. Build SDK: `cd packages/sdk/js && bun ./script/build.ts`
3. Verify method exists: Check `sdk.client.session.methodName()` in generated code

## Type Narrowing

Use type predicates for discriminated unions:

```typescript
// BAD
const subtask = parts.find((p) => p.type === "subtask") as SubtaskPart

// GOOD
const isSubtaskPart = (p: Part): p is SubtaskPart => p.type === "subtask"
const subtask = parts.find(isSubtaskPart)
```

In SolidJS, narrow at memo level, not inside `Show` callbacks.

## Config Schema Changes

When removing config keys:

- Update config schema validation
- Update default/example configs
- Document migration path

## Knowledge extraction flow (architectural decision)

When the user runs `/knowledge` we follow the standard subtask pattern (not a custom ExtractionPart):

- TUI: calls sdk.client.session.knowledge({ path: { id }, body: { providerID, modelID } })
- Server: creates a transcript at `.opencode/sess/{sessionID}.md`
- Server: creates a SubtaskPart with prompt/instructions for `knowledge-extractor` agent
- Task tool: spawns a child session and runs the `knowledge-extractor` agent
- Agent: reads the transcript and writes one or more `.opencode/knowledge/*.md` files
- Subtask completion: UI receives updates via the normal subtask lifecycle (progress/completion)

Why: prefer the standard SubtaskPart + Task tool because it integrates with UI, OpenAPI/SDK generation, and existing session tooling. It keeps server & client behavior consistent and avoids custom part schemas.

## UI & lifecycle gotchas

- Don't set result fields to empty arrays before completion. Use `undefined` to mean "still pending" and `[]` to mean "completed with no results", or include an explicit `status` field (`pending | completed | failed`).
- If you must mark a child session as attempted to prevent retries on restarts, set the `childSessionID` eagerly but do not set `files` eagerly. Instead, set `files` only on final completion.

Example (recommended):

```ts
const child = await Session.create(...)
await updatePart({ childSessionID: child.id }) // mark attempted, prevents retries
// do the work
const result = await SessionPrompt.prompt({ sessionID: child.id })
await updatePart({ childSessionID: child.id, files: result.files || [] }) // final update
```

## Endpoint & OpenAPI gotchas

- Avoid placing endpoint logic in an unrelated route (e.g. putting /session/:id/knowledge work inside /session/:id/summarize). This causes the SDK to lack the expected method and mixes concerns.
- After adding or changing routes:
  1. Run `bun dev generate` from the opencode package to regenerate the OpenAPI spec
  2. Build the SDK: `cd packages/sdk/js && bun ./script/build.ts`
  3. Verify the generated client: search for `sdk.client.session.methodName` in `sdk.gen.ts`
  4. Rebuild TUI/package consumers so they pick up the updated SDK

## Debugging missing SDK methods

If sdk.client.session.knowledge() isn't present:

- Check server.ts to confirm the route is defined at the expected path and method
- Confirm `openapi.json` contains the new path
- Re-run OpenAPI generation + SDK build (steps above)
- If the TUI still can't call the method, rebuild the TUI and confirm imports

## Type narrowing rules (SolidJS / TypeScript)

- Prefer type predicate functions to narrow discriminated unions instead of `as` casts:

```ts
const isSubtaskPart = (p: Part): p is SubtaskPart => p.type === "subtask"
const part = parts.find(isSubtaskPart)
```

- In SolidJS, narrow at the memo declaration level rather than inside the `Show` callback. This avoids having to use runtime guards in the render path.

## Prompt vs loop in the codebase

- SessionPrompt.prompt() internally calls `loop()` and waits for completion; it is a convenient API for the common case of creating a user message and waiting for the assistant reply.
- Use Task tool / SubtaskPart patterns when delegating to a sub-agent; don't implement a custom session flow unless you need special behavior.

## Knowledge auto-load (when to restore & how it worked)

- The prior system had `SystemPrompt.knowledge()` in `system.ts` and a `knowledge.auto_load` config option that would:
  - Scan `.opencode/knowledge/*.md` files
  - Load each file into the system prompt with a header `Knowledge from: {filepath}\n{content}`

- This creates a learning loop (extraction → knowledge files → auto-load into prompts). If you restore it, consider:
  - Loading only relevant files (by session tags, keyword match, or a relevance filter) to avoid exceeding prompt size
  - Adding caching & change detection (don't reload all files on every prompt generation)
  - Adding an opt-in `knowledge.auto_load` config and documenting migration when removing the key

## File rendering in UI

- `ExtractionFile` values are objects (e.g. `{ path, summary }`) not strings. Render `file.path` rather than `file`.

---
