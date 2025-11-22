import { Effect } from "effect"
import { Server } from "../../server/server"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@opencode-ai/core/flag/flag"
import path from "path"
import { Wildcard } from "@/util/wildcard"

export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) =>
    withNetworkOptions(yargs).option("tools", {
      type: "string",
      describe:
        "comma-separated tool patterns to enable/disable (e.g., '-*,read,write,webfetch' to only enable those three)",
    }),
  describe: "starts a headless opencode server",
  // Server loads instances per-request via x-opencode-directory header — no
  // need for an ambient project InstanceContext at startup.
  instance: false,
  handler: Effect.fn("Cli.serve")(function* (args) {
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = yield* resolveNetworkOptions(args)
    const tools = Wildcard.parseToolsPattern(args.tools)
    const server = yield* Effect.promise(() =>
      Server.listen({
        ...opts,
        directory: typeof args.dir === "string" ? path.resolve(args.dir) : process.cwd(),
        tools,
      }),
    )
    console.log(`opencode server listening on http://${server.hostname}:${server.port}`)

    yield* Effect.never
  }),
})
