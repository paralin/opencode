import { z } from "zod"

/**
 * Context provided to client-side tool execution.
 */
export type ToolContext = {
  /** The session ID where the tool is being executed */
  sessionID: string
  /** The message ID of the assistant message containing this tool call */
  messageID: string
  /** The unique ID of this tool call */
  callID: string
  /** Abort signal that fires if the session is cancelled */
  abort: AbortSignal
}

/**
 * Definition for a client-side tool.
 * @template Args - Zod schema shape for the tool arguments
 */
export type ClientTool<Args extends z.ZodRawShape = z.ZodRawShape> = {
  /** Description of what the tool does */
  description: string
  /** Zod schema for the tool's arguments */
  args: Args
  /** Function to execute when the tool is called */
  execute: (args: z.infer<z.ZodObject<Args>>, context: ToolContext) => Promise<string>
  /** @internal JSON schema representation for sending to server */
  _schema?: unknown
}

/**
 * Helper function to create a type-safe client-side tool definition.
 *
 * @example
 * ```typescript
 * import { tool } from "@opencode-ai/sdk/v2"
 * import { z } from "zod"
 *
 * const weatherTool = tool({
 *   description: "Get the current weather for a location",
 *   args: {
 *     location: z.string().describe("City name or coordinates"),
 *     units: z.enum(["celsius", "fahrenheit"]).optional(),
 *   },
 *   execute: async (args, context) => {
 *     const weather = await fetchWeather(args.location, args.units)
 *     return `Temperature: ${weather.temp}, Conditions: ${weather.conditions}`
 *   },
 * })
 * ```
 */
export function tool<Args extends z.ZodRawShape>(definition: Omit<ClientTool<Args>, "_schema">): ClientTool<Args> {
  return {
    ...definition,
    _schema: zodToJsonSchema(z.object(definition.args)),
  }
}

/**
 * Convert a Zod schema to JSON Schema format.
 * Uses Zod's built-in toJSONSchema if available, otherwise uses a basic conversion.
 */
function zodToJsonSchema(schema: z.ZodType): unknown {
  // Zod v3.23+ has built-in toJSONSchema
  if ("toJSONSchema" in z && typeof z.toJSONSchema === "function") {
    return z.toJSONSchema(schema)
  }

  // Fallback: try to use the schema's _def to build a basic JSON schema
  // This is a simplified version and may not handle all Zod types
  return convertZodToJsonSchema(schema)
}

/**
 * Basic Zod to JSON Schema converter for environments without z.toJSONSchema
 */
function convertZodToJsonSchema(schema: z.ZodType): unknown {
  const def = (schema as any)._def

  if (!def) {
    return { type: "object" }
  }

  const typeName = def.typeName as string

  switch (typeName) {
    case "ZodString":
      return {
        type: "string",
        ...(def.description ? { description: def.description } : {}),
      }
    case "ZodNumber":
      return {
        type: "number",
        ...(def.description ? { description: def.description } : {}),
      }
    case "ZodBoolean":
      return {
        type: "boolean",
        ...(def.description ? { description: def.description } : {}),
      }
    case "ZodArray":
      return {
        type: "array",
        items: convertZodToJsonSchema(def.type),
        ...(def.description ? { description: def.description } : {}),
      }
    case "ZodObject": {
      const properties: Record<string, unknown> = {}
      const required: string[] = []

      for (const [key, value] of Object.entries(def.shape() as Record<string, z.ZodType>)) {
        properties[key] = convertZodToJsonSchema(value)
        // Check if the field is optional
        if (!isOptional(value)) {
          required.push(key)
        }
      }

      return {
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
        ...(def.description ? { description: def.description } : {}),
      }
    }
    case "ZodOptional":
      return convertZodToJsonSchema(def.innerType)
    case "ZodEnum":
      return {
        type: "string",
        enum: def.values,
        ...(def.description ? { description: def.description } : {}),
      }
    case "ZodLiteral":
      return {
        const: def.value,
        ...(def.description ? { description: def.description } : {}),
      }
    case "ZodUnion":
      return {
        oneOf: def.options.map((opt: z.ZodType) => convertZodToJsonSchema(opt)),
        ...(def.description ? { description: def.description } : {}),
      }
    default:
      // Fallback for unknown types
      return {
        type: "object",
        ...(def.description ? { description: def.description } : {}),
      }
  }
}

/**
 * Check if a Zod type is optional
 */
function isOptional(schema: z.ZodType): boolean {
  const def = (schema as any)._def
  if (!def) return false
  return def.typeName === "ZodOptional" || def.typeName === "ZodNullable"
}

/**
 * Extract the server-compatible tool schema from a ClientTool.
 * This returns just the description and parameters for sending to the server.
 */
export function toServerSchema(tool: ClientTool): { description: string; parameters: unknown } {
  return {
    description: tool.description,
    parameters: tool._schema,
  }
}
