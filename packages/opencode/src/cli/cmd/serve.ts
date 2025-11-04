import { Server } from "../../server/server"
import { cmd } from "./cmd"
import { bootstrap } from "../bootstrap"
import path from "path"

export const ServeCommand = cmd({
  command: "serve",
  builder: (yargs) =>
    yargs
      .option("port", {
        alias: ["p"],
        type: "number",
        describe: "port to listen on",
        default: 0,
      })
      .option("hostname", {
        type: "string",
        describe: "hostname to listen on",
        default: "127.0.0.1",
      })
      .option("dir", {
        describe: "directory to run in",
        type: "string",
      }),
  describe: "starts a headless opencode server",
  handler: async (args) => {
    const cwd = args.dir ? path.resolve(args.dir) : process.cwd()
    const hostname = args.hostname
    const port = args.port
    await bootstrap(cwd, async () => {
      const server = Server.listen({
        port,
        hostname,
        directory: cwd,
      })
      console.log(`opencode server listening on http://${server.hostname}:${server.port}`)
      await new Promise(() => {})
      await server.stop()
    })
  },
})
