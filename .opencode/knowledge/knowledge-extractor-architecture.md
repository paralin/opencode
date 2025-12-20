---
created: 2025-12-18
source_sessions:
  - ses_4cedf380dffewklwZdNGSOB5SQ
---

# Knowledge Extractor Architecture

## Handling Long Session Transcripts

**Problem**: Exporting a session with many compactions produces a very long transcript that can blow out the knowledge-extractor agent's context window.

**Solution**: Smart transcript truncation with inline context passing.

### Design Decisions

1. **Inline context, not file I/O**: Pass transcript directly in the prompt within `<transcript>` tags. Don't write a file for the agent to read - this avoids the agent trying to load an enormous file.

2. **Detect compaction boundaries**: Scan messages for assistant messages with `summary: true` flag (indicates compaction summary).

3. **Estimate size**: Calculate total character count as proxy for tokens (~4 chars per token).

4. **Truncation algorithm** (when transcript >150k chars AND has compactions):
   - Extract all compaction summaries (text content from `summary: true` messages)
   - Find the index of the most recent compaction
   - Include "Historical Context" section with all compaction summaries
   - Include "Recent Conversation" section with only messages AFTER the last compaction
   - Add a note that transcript was truncated

5. **Short sessions**: Get full transcript inline (no truncation needed).

### Rationale

- Compaction summaries capture the essence of earlier conversation (high-level context)
- Recent messages after last compaction contain the actual knowledge to extract
- Passing inline avoids file read that could blow context before agent even starts
- Focus extraction effort on recent conversation where knowledge actually lives

**Key insight**: Compaction summaries ARE knowledge worth preserving too. The agent should extract valuable patterns/decisions from summaries as well as recent conversation.

## Knowledge File Organization

When updating vs creating knowledge files, the key test is:

**Update existing file** when the new knowledge:

- Is about THE SAME system/feature the file documents
- Adds details, corrections, or new cases for that specific topic

**Create new file** when the new knowledge:

- Is about a DIFFERENT system/feature, even if tangentially related
- Would require changing the file's title/scope to fit

**Key test**: Read the existing file's title and first section. If your new content requires a different title to make sense, create a new file.
