import type { ToolDefinition } from "./types";
import { loadSkillReference } from "../skills/loader";

export const loadSkillReferenceTool: ToolDefinition = {
  name: "load_skill_reference",
  description:
    "Load a reference file from an installed assistant skill. " +
    "Use this to read detailed documentation or examples that a skill provides.",
  parameters: {
    type: "object",
    properties: {
      skillSlug: {
        type: "string",
        description: "The slug of the skill to load a reference from",
      },
      filename: {
        type: "string",
        description: "The filename of the reference to load (e.g., 'wolfram-advanced.md')",
      },
    },
    required: ["skillSlug", "filename"],
  },
  async execute(args) {
    const skillSlug = String(args.skillSlug);
    const filename = String(args.filename);

    const content = await loadSkillReference(skillSlug, filename);
    if (!content) {
      return {
        success: false,
        data: null,
        displayText: `Reference '${filename}' not found for skill '${skillSlug}'`,
      };
    }

    return {
      success: true,
      data: { filename, content },
      displayText: content,
    };
  },
};
