import z from "zod"
import { Tool } from "./tool"

export const DescribeTool = Tool.define("describe", {
  description:
    "Set a description for the next operation. Use this before editing or writing files to explain what you're doing.",
  parameters: z.object({
    description: z.string().describe("Brief description of what you're about to do"),
  }),
  async execute(params, _ctx) {
    return {
      title: params.description,
      output: `Description set: ${params.description}`,
      metadata: {},
    }
  },
})
