import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { UI } from "../ui"
import { EOL } from "os"
import { Global } from "@opencode-ai/core/global"
import { Config } from "@/config/config"
import { Network } from "../../util/network"
import path from "path"
import { AppRuntime } from "@/effect/app-runtime"

export const ConfigCommand = cmd({
  command: "config",
  describe: "manage opencode configuration",
  builder: (yargs: Argv) => {
    return yargs
      .command(
        "offline [value]",
        "get or set offline mode (disables external network access except LLM APIs)",
        (yargs) =>
          yargs.positional("value", {
            describe: "set offline mode: true, false, on, off",
            type: "string",
          }),
        async (args) => {
          const globalConfigPath = path.join(Global.Path.config, "opencode.json")

          if (args.value === undefined) {
            // Get current value
            const config = await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.getGlobal()))
            const offline = config.network?.offline ?? true
            process.stdout.write(`offline: ${offline}`)
            process.stdout.write(EOL)
            return
          }

          // Set value
          const value = args.value.toLowerCase()
          const offline = value === "true" || value === "on" || value === "1"

          if (!["true", "false", "on", "off", "1", "0"].includes(value)) {
            UI.error(`Invalid value: ${args.value}. Use true/false, on/off, or 1/0.`)
            return
          }

          // Read existing config
          const file = Bun.file(globalConfigPath)
          const existing = await file.json().catch(() => ({}))

          // Update config
          const updated = {
            ...existing,
            network: {
              ...(existing.network || {}),
              offline,
            },
          }

          await Bun.write(globalConfigPath, JSON.stringify(updated, null, 2))
          Network.setOffline(offline)

          UI.println(
            UI.Style.TEXT_SUCCESS_BOLD + `Offline mode ${offline ? "enabled" : "disabled"}` + UI.Style.TEXT_NORMAL,
          )
          if (offline) {
            process.stdout.write(
              "External network features (sharing, auto-updates, LSP downloads, models.dev sync) are disabled.",
            )
          } else {
            process.stdout.write("All network features are enabled.")
          }
          process.stdout.write(EOL)
        },
      )
      .demandCommand(1, "You must specify a subcommand")
  },
  handler: async () => {
    // This won't be called due to demandCommand
  },
})
