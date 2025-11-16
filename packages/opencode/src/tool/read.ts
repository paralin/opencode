import z from "zod"
import * as fs from "fs"
import * as path from "path"
import { Tool } from "./tool"
import { LSP } from "../lsp"
import { FileTime } from "../file/time"
import DESCRIPTION from "./read.txt"
import { Filesystem } from "../util/filesystem"
import { Instance } from "../project/instance"
import { Provider } from "../provider/provider"
import { Identifier } from "../id/id"
import { Permission } from "../permission"
import { Agent } from "@/agent/agent"
import { iife } from "@/util/iife"

const DEFAULT_READ_LIMIT = 2000
const MAX_LINE_LENGTH = 2000

export const ReadTool = Tool.define("read", {
  description: DESCRIPTION,
  parameters: z.object({
    filePath: z.string().describe("The path to the file to read"),
    offset: z.coerce.number().describe("The line number to start reading from (0-based)").optional(),
    limit: z.coerce.number().describe("The number of lines to read (defaults to 2000)").optional(),
  }),
  async execute(params, ctx) {
    let filepath = params.filePath
    if (!path.isAbsolute(filepath)) {
      filepath = path.join(process.cwd(), filepath)
    }
    const title = path.relative(Instance.worktree, filepath)
    const agent = await Agent.get(ctx.agent)

    if (!ctx.extra?.["bypassCwdCheck"] && !Filesystem.contains(Instance.directory, filepath)) {
      const parentDir = path.dirname(filepath)
      if (agent.permission.external_directory === "ask") {
        await Permission.ask({
          type: "external_directory",
          pattern: [parentDir, path.join(parentDir, "*")],
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          callID: ctx.callID,
          title: `Access file outside working directory: ${filepath}`,
          metadata: {
            filepath,
            parentDir,
          },
        })
      } else if (agent.permission.external_directory === "deny") {
        throw new Permission.RejectedError(
          ctx.sessionID,
          "external_directory",
          ctx.callID,
          {
            filepath: filepath,
            parentDir,
          },
          `File ${filepath} is not in the current working directory`,
        )
      }
    }

    const block = iife(() => {
      const whitelist = [".env.sample", ".example"]

      if (whitelist.some((w) => filepath.endsWith(w))) return false
      if (filepath.includes(".env")) return true

      return false
    })

    if (block) {
      throw new Error(`The user has blocked you from reading ${filepath}, DO NOT make further attempts to read it`)
    }

    const file = Bun.file(filepath)
    if (!(await file.exists())) {
      const dir = path.dirname(filepath)
      const base = path.basename(filepath)

      const dirEntries = fs.readdirSync(dir)
      const suggestions = dirEntries
        .filter(
          (entry) =>
            entry.toLowerCase().includes(base.toLowerCase()) || base.toLowerCase().includes(entry.toLowerCase()),
        )
        .map((entry) => path.join(dir, entry))
        .slice(0, 3)

      if (suggestions.length > 0) {
        throw new Error(`File not found: ${filepath}\n\nDid you mean one of these?\n${suggestions.join("\n")}`)
      }

      throw new Error(`File not found: ${filepath}`)
    }

    const isImage = isImageFile(filepath)
    const supportsImages = await (async () => {
      if (!ctx.extra?.["providerID"] || !ctx.extra?.["modelID"]) return false
      const providerID = ctx.extra["providerID"] as string
      const modelID = ctx.extra["modelID"] as string
      const model = await Provider.getModel(providerID, modelID).catch(() => undefined)
      if (!model) return false
      return model.info.modalities?.input?.includes("image") ?? false
    })()
    if (isImage) {
      if (!supportsImages) {
        throw new Error(`Failed to read image: ${filepath}, model may not be able to read images`)
      }
      const mime = file.type
      const stat = await file.stat()
      const fileSize = stat.size
      const dimensions = await getImageDimensions(file, mime)
      const sizeKB = (fileSize / 1024).toFixed(2)

      const msg = `Image file details:\n- Path: ${filepath}\n- Type: ${isImage}\n- Size: ${sizeKB} KB${dimensions ? `\n- Dimensions: ${dimensions.width}x${dimensions.height}` : ""}\n\nThe image content has been attached and can be analyzed.`

      return {
        title,
        output: msg,
        metadata: {
          preview: `Image: ${path.basename(filepath)} (${sizeKB} KB)`,
        },
        attachments: [
          {
            id: Identifier.ascending("part"),
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            type: "file",
            mime,
            url: `data:${mime};base64,${Buffer.from(await file.bytes()).toString("base64")}`,
          },
        ],
      }
    }

    const isBinary = await isBinaryFile(filepath, file)
    if (isBinary) throw new Error(`Cannot read binary file: ${filepath}`)

    const limit = params.limit ?? DEFAULT_READ_LIMIT
    const offset = params.offset || 0
    const lines = await file.text().then((text) => text.split("\n"))
    const raw = lines.slice(offset, offset + limit).map((line) => {
      return line.length > MAX_LINE_LENGTH ? line.substring(0, MAX_LINE_LENGTH) + "..." : line
    })
    const content = raw.map((line, index) => {
      return `${(index + offset + 1).toString().padStart(5, "0")}| ${line}`
    })
    const preview = raw.slice(0, 20).join("\n")

    let output = "<file>\n"
    output += content.join("\n")

    const totalLines = lines.length
    const lastReadLine = offset + content.length
    const hasMoreLines = totalLines > lastReadLine

    if (hasMoreLines) {
      output += `\n\n(File has more lines. Use 'offset' parameter to read beyond line ${lastReadLine})`
    } else {
      output += `\n\n(End of file - total ${totalLines} lines)`
    }
    output += "\n</file>"

    // just warms the lsp client
    LSP.touchFile(filepath, false)
    FileTime.read(ctx.sessionID, filepath)

    return {
      title,
      output,
      metadata: {
        preview,
      },
    }
  },
})

function isImageFile(filePath: string): string | false {
  const ext = path.extname(filePath).toLowerCase()
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "JPEG"
    case ".png":
      return "PNG"
    case ".gif":
      return "GIF"
    case ".bmp":
      return "BMP"
    case ".webp":
      return "WebP"
    default:
      return false
  }
}

async function getImageDimensions(file: Bun.BunFile, mime: string): Promise<{ width: number; height: number } | null> {
  const buffer = await file.arrayBuffer()
  const bytes = new Uint8Array(buffer)

  if (mime === "image/png" || mime.includes("png")) {
    if (bytes.length < 24) return null
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
      const width = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19]
      const height = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23]
      return { width, height }
    }
  }

  if (mime === "image/jpeg" || mime.includes("jpeg") || mime.includes("jpg")) {
    if (bytes.length < 4) return null
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      let offset = 2
      while (offset < bytes.length - 9) {
        if (bytes[offset] !== 0xff) break
        const marker = bytes[offset + 1]
        if (marker === 0xc0 || marker === 0xc2) {
          const height = (bytes[offset + 5] << 8) | bytes[offset + 6]
          const width = (bytes[offset + 7] << 8) | bytes[offset + 8]
          return { width, height }
        }
        const segmentLength = (bytes[offset + 2] << 8) | bytes[offset + 3]
        offset += segmentLength + 2
      }
    }
  }

  if (mime === "image/gif" || mime.includes("gif")) {
    if (bytes.length < 10) return null
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
      const width = bytes[6] | (bytes[7] << 8)
      const height = bytes[8] | (bytes[9] << 8)
      return { width, height }
    }
  }

  if (mime === "image/webp" || mime.includes("webp")) {
    if (bytes.length < 30) return null
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
      if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
        if (bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38) {
          const width = (bytes[26] | (bytes[27] << 8) | (bytes[28] << 16)) + 1
          const height = (bytes[29] | (bytes[30] << 8) | (bytes[31] << 16)) + 1
          return { width, height }
        }
      }
    }
  }

  return null
}

async function isBinaryFile(filepath: string, file: Bun.BunFile): Promise<boolean> {
  const ext = path.extname(filepath).toLowerCase()
  // binary check for common non-text extensions
  switch (ext) {
    case ".zip":
    case ".tar":
    case ".gz":
    case ".exe":
    case ".dll":
    case ".so":
    case ".class":
    case ".jar":
    case ".war":
    case ".7z":
    case ".doc":
    case ".docx":
    case ".xls":
    case ".xlsx":
    case ".ppt":
    case ".pptx":
    case ".odt":
    case ".ods":
    case ".odp":
    case ".bin":
    case ".dat":
    case ".obj":
    case ".o":
    case ".a":
    case ".lib":
    case ".wasm":
    case ".pyc":
    case ".pyo":
      return true
    default:
      break
  }

  const stat = await file.stat()
  const fileSize = stat.size
  if (fileSize === 0) return false

  const bufferSize = Math.min(4096, fileSize)
  const buffer = await file.arrayBuffer()
  if (buffer.byteLength === 0) return false
  const bytes = new Uint8Array(buffer.slice(0, bufferSize))

  let nonPrintableCount = 0
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) return true
    if (bytes[i] < 9 || (bytes[i] > 13 && bytes[i] < 32)) {
      nonPrintableCount++
    }
  }
  // If >30% non-printable characters, consider it binary
  return nonPrintableCount / bytes.length > 0.3
}
