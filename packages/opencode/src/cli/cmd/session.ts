import type { Argv } from "yargs"
import { Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { Session } from "@/session/session"
import { SessionID } from "../../session/schema"
import { UI } from "../ui"
import { Locale } from "@/util/locale"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Filesystem } from "@/util/filesystem"
import { Process } from "@/util/process"
import { NotFoundError } from "@/storage/storage"
import { EOL } from "os"
import path from "path"
import { which } from "../../util/which"
import * as prompts from "@clack/prompts"
import { formatTranscript } from "./tui/util/transcript"

function pagerCmd(): string[] {
  const lessOptions = ["-R", "-S"]
  if (process.platform !== "win32") {
    return ["less", ...lessOptions]
  }

  // user could have less installed via other options
  const lessOnPath = which("less")
  if (lessOnPath) {
    if (Filesystem.stat(lessOnPath)?.size) return [lessOnPath, ...lessOptions]
  }

  if (Flag.OPENCODE_GIT_BASH_PATH) {
    const less = path.join(Flag.OPENCODE_GIT_BASH_PATH, "..", "..", "usr", "bin", "less.exe")
    if (Filesystem.stat(less)?.size) return [less, ...lessOptions]
  }

  const git = which("git")
  if (git) {
    const less = path.join(git, "..", "..", "usr", "bin", "less.exe")
    if (Filesystem.stat(less)?.size) return [less, ...lessOptions]
  }

  // Fall back to Windows built-in more (via cmd.exe)
  return ["cmd", "/c", "more"]
}

export const SessionCommand = cmd({
  command: "session",
  describe: "manage sessions",
  builder: (yargs: Argv) =>
    yargs.command(SessionListCommand).command(SessionDeleteCommand).command(SessionExportCommand).demandCommand(),
  async handler() {},
})

export const SessionDeleteCommand = effectCmd({
  command: "delete <sessionID>",
  describe: "delete a session",
  builder: (yargs) =>
    yargs.positional("sessionID", {
      describe: "session ID to delete",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.session.delete")(function* (args) {
    const svc = yield* Session.Service
    const sessionID = SessionID.make(args.sessionID)
    yield* svc
      .remove(sessionID)
      .pipe(Effect.catchIf(NotFoundError.isInstance, () => fail(`Session not found: ${args.sessionID}`)))
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Session ${args.sessionID} deleted` + UI.Style.TEXT_NORMAL)
  }),
})

export const SessionListCommand = effectCmd({
  command: "list",
  describe: "list sessions",
  builder: (yargs) =>
    yargs
      .option("max-count", {
        alias: "n",
        describe: "limit to N most recent sessions",
        type: "number",
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      }),
  handler: Effect.fn("Cli.session.list")(function* (args) {
    const sessions = yield* Session.Service.use((svc) => svc.list({ roots: true, limit: args.maxCount }))

    if (sessions.length === 0) return

    const output = args.format === "json" ? formatSessionJSON(sessions) : formatSessionTable(sessions)

    const shouldPaginate = process.stdout.isTTY && !args.maxCount && args.format === "table"

    if (shouldPaginate) {
      yield* Effect.promise(async () => {
        const proc = Process.spawn(pagerCmd(), {
          stdin: "pipe",
          stdout: "inherit",
          stderr: "inherit",
        })

        if (!proc.stdin) {
          console.log(output)
          return
        }

        proc.stdin.write(output)
        proc.stdin.end()
        await proc.exited
      })
    } else {
      console.log(output)
    }
  }),
})

function formatSessionTable(sessions: Session.Info[]): string {
  const lines: string[] = []

  const maxIdWidth = Math.max(20, ...sessions.map((s) => s.id.length))
  const maxTitleWidth = Math.max(25, ...sessions.map((s) => s.title.length))

  const header = `Session ID${" ".repeat(maxIdWidth - 10)}  Title${" ".repeat(maxTitleWidth - 5)}  Updated`
  lines.push(header)
  lines.push("─".repeat(header.length))
  for (const session of sessions) {
    const truncatedTitle = Locale.truncate(session.title, maxTitleWidth)
    const timeStr = Locale.todayTimeOrDateTime(session.time.updated)
    const line = `${session.id.padEnd(maxIdWidth)}  ${truncatedTitle.padEnd(maxTitleWidth)}  ${timeStr}`
    lines.push(line)
  }

  return lines.join(EOL)
}

function formatSessionJSON(sessions: Session.Info[]): string {
  const jsonData = sessions.map((session) => ({
    id: session.id,
    title: session.title,
    updated: session.time.updated,
    created: session.time.created,
    projectId: session.projectID,
    directory: session.directory,
  }))
  return JSON.stringify(jsonData, null, 2)
}

export const SessionExportCommand = effectCmd({
  command: "export [sessionID]",
  describe: "export session transcript to file",
  builder: (yargs: Argv) => {
    return yargs
      .positional("sessionID", {
        describe: "session id to export",
        type: "string",
      })
      .option("output", {
        alias: "o",
        describe: "output file path",
        type: "string",
      })
      .option("format", {
        alias: "f",
        describe: "output format",
        type: "string",
        choices: ["markdown", "json"],
        default: "markdown",
      })
      .option("thinking", {
        describe: "include thinking/reasoning blocks",
        type: "boolean",
        default: true,
      })
      .option("tool-details", {
        describe: "include tool input/output details",
        type: "boolean",
        default: true,
      })
      .option("assistant-metadata", {
        describe: "include assistant metadata (agent, model, duration)",
        type: "boolean",
        default: true,
      })
      .option("turn", {
        describe: "export only the Nth turn (0-indexed from start, negative from end: -1 = last)",
        type: "number",
      })
  },
  handler: Effect.fn("Cli.session.export")(function* (args) {
    const svc = yield* Session.Service
    let sessionID = args.sessionID ? SessionID.make(args.sessionID) : undefined

    if (!sessionID) {
      prompts.intro("Export session", {
        output: process.stderr,
      })

      const sessions = yield* svc.list()

      if (sessions.length === 0) {
        prompts.log.error("No sessions found", {
          output: process.stderr,
        })
        prompts.outro("Done", {
          output: process.stderr,
        })
        return
      }

      sessions.sort((a, b) => b.time.updated - a.time.updated)

      const selectedSession = yield* Effect.promise(() =>
        prompts.autocomplete({
          message: "Select session to export",
          maxItems: 10,
          options: sessions.map((session) => ({
            label: session.title,
            value: session.id,
            hint: `${new Date(session.time.updated).toLocaleString()} • ${session.id.slice(-8)}`,
          })),
          output: process.stderr,
        }),
      )

      if (prompts.isCancel(selectedSession)) {
        return yield* Effect.die(new UI.CancelledError())
      }

      sessionID = SessionID.make(selectedSession as string)
    }

    const sessionInfo = yield* svc
      .get(sessionID!)
      .pipe(Effect.catchIf(NotFoundError.isInstance, () => fail(`Session not found: ${sessionID}`)))

    let content: string
    let defaultExtension: string

    let sessionMessages = yield* svc
      .messages({ sessionID: sessionID! })
      .pipe(Effect.catchIf(NotFoundError.isInstance, () => fail(`Session not found: ${sessionID}`)))

    // Filter to a specific turn if --turn is specified.
    // A turn is a user+assistant message pair. Turn 0 is the first pair,
    // turn -1 is the last pair, etc.
    if (args.turn !== undefined) {
      const turns: Array<{ start: number; end: number }> = []
      let turnStart = 0
      for (let i = 0; i < sessionMessages.length; i++) {
        if (sessionMessages[i].info.role === "assistant") {
          turns.push({ start: turnStart, end: i + 1 })
          turnStart = i + 1
        }
      }
      if (turnStart < sessionMessages.length) {
        turns.push({ start: turnStart, end: sessionMessages.length })
      }

      const idx = args.turn < 0 ? turns.length + args.turn : args.turn
      if (idx < 0 || idx >= turns.length) {
        return yield* fail(`Turn ${args.turn} out of range (session has ${turns.length} turn(s))`)
      }
      const turn = turns[idx]!
      sessionMessages = sessionMessages.slice(turn.start, turn.end)
    }

    if (args.format === "json") {
      const exportData = {
        info: sessionInfo,
        messages: sessionMessages.map((msg) => ({
          info: msg.info,
          parts: msg.parts,
        })),
      }
      content = JSON.stringify(exportData, null, 2)
      defaultExtension = "json"
    } else {
      content = formatTranscript(sessionInfo, sessionMessages, {
        thinking: args.thinking,
        toolDetails: args["tool-details"],
        assistantMetadata: args["assistant-metadata"],
      })
      defaultExtension = "md"
    }

    const outputPath = args.output
      ? args.output
      : yield* Effect.gen(function* () {
          const defaultFilename = `session-${sessionInfo.id.slice(0, 8)}.${defaultExtension}`
          const filenameInput = yield* Effect.promise(() =>
            prompts.text({
              message: "Export filename",
              defaultValue: defaultFilename,
              output: process.stderr,
            }),
          )

          if (prompts.isCancel(filenameInput)) {
            return yield* Effect.die(new UI.CancelledError())
          }

          return filenameInput.trim()
        })

    yield* Effect.promise(() => Bun.write(outputPath, content))

    prompts.outro(`Session exported to ${outputPath}`, {
      output: process.stderr,
    })
  }),
})
