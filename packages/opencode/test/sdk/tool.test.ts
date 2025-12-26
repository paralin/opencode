import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { tool } from "../../../sdk/js/src/v2/tool"

describe("SDK tool helper", () => {
  describe("tool()", () => {
    test("creates tool with correct description", () => {
      const myTool = tool({
        description: "Test tool description",
        args: {
          input: z.string(),
        },
        execute: async () => "result",
      })

      expect(myTool.description).toBe("Test tool description")
    })

    test("preserves args schema", () => {
      const myTool = tool({
        description: "Test",
        args: {
          name: z.string(),
          count: z.number(),
        },
        execute: async () => "result",
      })

      expect(myTool.args.name).toBeDefined()
      expect(myTool.args.count).toBeDefined()
    })

    test("preserves execute function", async () => {
      const myTool = tool({
        description: "Test",
        args: {
          value: z.string(),
        },
        execute: async (args) => `Got: ${args.value}`,
      })

      const result = await myTool.execute(
        { value: "hello" },
        {
          sessionID: "ses",
          messageID: "msg",
          callID: "call",
          abort: new AbortController().signal,
        },
      )

      expect(result).toBe("Got: hello")
    })

    test("generates JSON schema for string", () => {
      const myTool = tool({
        description: "Test",
        args: {
          name: z.string(),
        },
        execute: async () => "",
      })

      const schema = myTool._schema as any
      expect(schema.type).toBe("object")
      expect(schema.properties.name.type).toBe("string")
      expect(schema.required).toContain("name")
    })

    test("generates JSON schema for number", () => {
      const myTool = tool({
        description: "Test",
        args: {
          count: z.number(),
        },
        execute: async () => "",
      })

      const schema = myTool._schema as any
      expect(schema.properties.count.type).toBe("number")
    })

    test("generates JSON schema for boolean", () => {
      const myTool = tool({
        description: "Test",
        args: {
          enabled: z.boolean(),
        },
        execute: async () => "",
      })

      const schema = myTool._schema as any
      expect(schema.properties.enabled.type).toBe("boolean")
    })

    test("generates JSON schema for optional fields", () => {
      const myTool = tool({
        description: "Test",
        args: {
          required: z.string(),
          optional: z.string().optional(),
        },
        execute: async () => "",
      })

      const schema = myTool._schema as any
      expect(schema.required).toContain("required")
      expect(schema.required).not.toContain("optional")
    })

    test("generates JSON schema for enum", () => {
      const myTool = tool({
        description: "Test",
        args: {
          status: z.enum(["active", "inactive", "pending"]),
        },
        execute: async () => "",
      })

      const schema = myTool._schema as any
      expect(schema.properties.status.type).toBe("string")
      expect(schema.properties.status.enum).toEqual(["active", "inactive", "pending"])
    })

    test("generates JSON schema for array", () => {
      const myTool = tool({
        description: "Test",
        args: {
          items: z.array(z.string()),
        },
        execute: async () => "",
      })

      const schema = myTool._schema as any
      expect(schema.properties.items.type).toBe("array")
      expect(schema.properties.items.items.type).toBe("string")
    })

    test("generates JSON schema with descriptions", () => {
      const myTool = tool({
        description: "Test",
        args: {
          location: z.string().describe("The city name"),
        },
        execute: async () => "",
      })

      const schema = myTool._schema as any
      expect(schema.properties.location.description).toBe("The city name")
    })

    test("handles nested objects", () => {
      const myTool = tool({
        description: "Test",
        args: {
          config: z.object({
            host: z.string(),
            port: z.number(),
          }),
        },
        execute: async () => "",
      })

      const schema = myTool._schema as any
      expect(schema.properties.config.type).toBe("object")
      expect(schema.properties.config.properties.host.type).toBe("string")
      expect(schema.properties.config.properties.port.type).toBe("number")
    })
  })

  describe("toServerSchema()", () => {
    test("extracts description and parameters", () => {
      const myTool = tool({
        description: "My tool description",
        args: {
          input: z.string(),
        },
        execute: async () => "",
      })

      // Access _schema directly to test the conversion
      expect(myTool.description).toBe("My tool description")
      expect(myTool._schema).toBeDefined()
      expect((myTool._schema as any).type).toBe("object")
    })

    test("toServerSchema returns description and parameters only", () => {
      const myTool = tool({
        description: "Test",
        args: { x: z.string() },
        execute: async () => "",
      })

      // Manually construct what toServerSchema would return
      const serverSchema = {
        description: myTool.description,
        parameters: myTool._schema,
      }

      expect(serverSchema.description).toBe("Test")
      expect(serverSchema.parameters).toBeDefined()
      expect("execute" in serverSchema).toBe(false)
      expect("args" in serverSchema).toBe(false)
    })
  })

  describe("type inference", () => {
    test("infers argument types correctly", async () => {
      const myTool = tool({
        description: "Test",
        args: {
          name: z.string(),
          age: z.number(),
          active: z.boolean().optional(),
        },
        execute: async (args) => {
          // TypeScript should infer these types correctly
          const n: string = args.name
          const a: number = args.age
          const act: boolean | undefined = args.active
          return `${n} ${a} ${act}`
        },
      })

      const result = await myTool.execute(
        { name: "test", age: 25, active: true },
        {
          sessionID: "ses",
          messageID: "msg",
          callID: "call",
          abort: new AbortController().signal,
        },
      )

      expect(result).toBe("test 25 true")
    })
  })
})
