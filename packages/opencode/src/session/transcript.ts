import { Session } from "."
import type { MessageV2 } from "./message-v2"

export namespace SessionTranscript {
  export async function toMarkdown(sessionID: string): Promise<string> {
    const session = await Session.get(sessionID)
    const msgs = await Session.messages({ sessionID })

    const lines: string[] = [
      `# ${session.title}`,
      ``,
      `**Session ID:** ${session.id}`,
      `**Created:** ${new Date(session.time.created).toLocaleString()}`,
      `**Updated:** ${new Date(session.time.updated).toLocaleString()}`,
      ``,
      `---`,
      ``,
    ]

    for (const msg of msgs) {
      const role = msg.info.role === "user" ? "User" : "Assistant"
      lines.push(`## ${role}`, ``)

      for (const part of msg.parts) {
        if (part.type === "text" && !part.synthetic) {
          lines.push(part.text, ``)
        } else if (part.type === "tool") {
          lines.push(formatToolPart(part))
        }
      }

      lines.push(`---`, ``)
    }

    return lines.join("\n")
  }

  function formatToolPart(part: MessageV2.ToolPart): string {
    const lines = [`\`\`\``, `Tool: ${part.tool}`]

    if (part.state.status === "completed") {
      lines.push(`Input: ${JSON.stringify(part.state.input, null, 2)}`)
      if (part.state.output && part.state.output.length < 2000) {
        lines.push(`Output: ${part.state.output}`)
      }
    }

    lines.push(`\`\`\``, ``)
    return lines.join("\n")
  }

  export async function writeToFile(sessionID: string, filepath: string): Promise<void> {
    const markdown = await toMarkdown(sessionID)
    await Bun.write(filepath, markdown)
  }
}
