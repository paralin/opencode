export * from "./client.js"
export * from "./server.js"
export { tool, toServerSchema, type ClientTool, type ToolContext } from "./tool.js"
export * from "./prompt-with-tools.js"

import { createOpencodeClient } from "./client.js"
import { createOpencodeServer } from "./server.js"
import type { ServerOptions } from "./server.js"

export async function createOpencode(options?: ServerOptions) {
  const server = await createOpencodeServer({
    ...options,
  })

  const client = createOpencodeClient({
    baseUrl: server.url,
  })

  return {
    client,
    server,
  }
}
