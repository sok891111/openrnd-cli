/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
  type ExecuteOptions,
} from './tools.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import { Storage } from '../config/storage.js';

export const MANAGE_SKILL_TOOL_NAME = 'manage_skill';
export const MANAGE_SKILL_DISPLAY_NAME = 'Manage Skill';

const MANAGE_SKILL_DESCRIPTION = `Create, list, or delete openrnd skills.
Skills are markdown files that give the model specialized knowledge and workflows.
They live in ~/.openrnd/skills/<name>/SKILL.md and are auto-loaded on startup.

Use this tool when the user says things like:
- "스킬 만들어줘 — 웹 크롤링 자동화"
- "Create a skill for summarizing Slack threads"
- "스킬 목록 보여줘"
- "xxx 스킬 삭제해줘"
- "Update the xxx skill"

After creating or deleting a skill, it takes effect on the NEXT openrnd session start.
In an active interactive session the user can type /skills reload to apply immediately.

Skill body guidelines:
- Write clear, concise instructions in markdown
- Include example inputs/outputs if helpful
- Keep under 500 lines; reference external files for large content
- The description field is the primary trigger — make it specific about WHEN to use this skill`;

interface ManageSkillParams {
  action: 'create' | 'update' | 'delete' | 'list';
  name?: string;
  description?: string;
  body?: string;
  scope?: 'user' | 'workspace';
}

const MANAGE_SKILL_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['create', 'update', 'delete', 'list'],
      description:
        '"create" to make a new skill, "update" to modify an existing one, "delete" to remove, "list" to show all installed skills.',
    },
    name: {
      type: 'string',
      description:
        'Skill identifier in kebab-case (e.g. "web-crawler", "slack-summarizer"). Required for create/update/delete.',
    },
    description: {
      type: 'string',
      description:
        'One-line description shown to the model when deciding whether to activate this skill. Be specific about triggers. Required for create.',
    },
    body: {
      type: 'string',
      description:
        'Full markdown content of the SKILL.md body (everything after the frontmatter). Required for create; optional for update (replaces existing body).',
    },
    scope: {
      type: 'string',
      enum: ['user', 'workspace'],
      description:
        '"user" stores in ~/.openrnd/skills/ (default, available in all projects). "workspace" stores in .openrnd/skills/ (current project only).',
    },
  },
  required: ['action'],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSkillsDir(scope: 'user' | 'workspace'): string {
  if (scope === 'workspace') {
    return path.join(process.cwd(), '.openrnd', 'skills');
  }
  return Storage.getUserSkillsDir();
}

function toKebabCase(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildSkillFileContent(
  name: string,
  description: string,
  body: string,
): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body.trimStart()}\n`;
}

function parseSkillFile(
  filePath: string,
): { name: string; description: string } | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return null;
    const fm = match[1];
    const nameM = fm.match(/^name:\s*(.+)$/m);
    const descM = fm.match(/^description:\s*(.+)$/m);
    return {
      name: nameM ? nameM[1].trim() : path.basename(path.dirname(filePath)),
      description: descM ? descM[1].trim() : '',
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

class ManageSkillInvocation extends BaseToolInvocation<
  ManageSkillParams,
  ToolResult
> {
  constructor(params: ManageSkillParams, messageBus: MessageBus) {
    super(
      params,
      messageBus,
      MANAGE_SKILL_TOOL_NAME,
      MANAGE_SKILL_DISPLAY_NAME,
    );
  }

  override getDescription(): string {
    const { action, name } = this.params;
    if (action === 'create') return `Create skill: ${name ?? '(unnamed)'}`;
    if (action === 'update') return `Update skill: ${name ?? '(unnamed)'}`;
    if (action === 'delete') return `Delete skill: ${name ?? '(unnamed)'}`;
    return 'List skills';
  }

  override async execute(_options: ExecuteOptions): Promise<ToolResult> {
    const { action, scope = 'user' } = this.params;
    const skillsDir = getSkillsDir(scope);

    switch (action) {
      case 'list': {
        const skills: Array<{
          name: string;
          description: string;
          path: string;
        }> = [];

        // User skills
        const userDir = Storage.getUserSkillsDir();
        if (fs.existsSync(userDir)) {
          for (const entry of fs.readdirSync(userDir, {
            withFileTypes: true,
          })) {
            if (!entry.isDirectory()) continue;
            const skillFile = path.join(userDir, entry.name, 'SKILL.md');
            if (fs.existsSync(skillFile)) {
              const parsed = parseSkillFile(skillFile);
              skills.push({
                name: parsed?.name ?? entry.name,
                description: parsed?.description ?? '',
                path: `~/.openrnd/skills/${entry.name}`,
              });
            }
          }
        }

        // Workspace skills
        const wsDir = path.join(process.cwd(), '.openrnd', 'skills');
        if (fs.existsSync(wsDir)) {
          for (const entry of fs.readdirSync(wsDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const skillFile = path.join(wsDir, entry.name, 'SKILL.md');
            if (fs.existsSync(skillFile)) {
              const parsed = parseSkillFile(skillFile);
              skills.push({
                name: parsed?.name ?? entry.name,
                description: parsed?.description ?? '',
                path: `.openrnd/skills/${entry.name}`,
              });
            }
          }
        }

        if (skills.length === 0) {
          const msg =
            'No custom skills installed yet.\n\nUse `manage_skill` with action "create" to add one.';
          return { llmContent: msg, returnDisplay: msg };
        }

        const lines = skills.map(
          (s) => `- **${s.name}** (\`${s.path}\`): ${s.description}`,
        );
        const msg = `**Installed skills (${skills.length}):**\n${lines.join('\n')}`;
        return { llmContent: msg, returnDisplay: msg };
      }

      case 'create':
      case 'update': {
        const { name, description, body } = this.params;

        if (!name) {
          return {
            llmContent: 'Error: "name" is required.',
            returnDisplay: 'Error: name required',
            error: { message: 'name required' },
          };
        }

        const skillName = toKebabCase(name);
        const skillDir = path.join(skillsDir, skillName);
        const skillFile = path.join(skillDir, 'SKILL.md');
        const exists = fs.existsSync(skillFile);

        if (action === 'create' && exists) {
          // Allow overwrite but warn
        }

        // For update, read existing content to merge
        let finalDescription = description ?? '';
        let finalBody = body ?? '';

        if (action === 'update' && exists) {
          const existing = fs.readFileSync(skillFile, 'utf-8');
          const parsed = parseSkillFile(skillFile);
          if (!finalDescription && parsed?.description) {
            finalDescription = parsed.description;
          }
          if (!finalBody) {
            const bodyMatch = existing.match(
              /^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/,
            );
            finalBody = bodyMatch ? bodyMatch[1] : '';
          }
        }

        if (action === 'create' && !finalDescription) {
          return {
            llmContent: 'Error: "description" is required for action "create".',
            returnDisplay: 'Error: description required',
            error: { message: 'description required' },
          };
        }
        if (action === 'create' && !finalBody) {
          return {
            llmContent: 'Error: "body" is required for action "create".',
            returnDisplay: 'Error: body required',
            error: { message: 'body required' },
          };
        }

        if (!fs.existsSync(skillDir)) {
          fs.mkdirSync(skillDir, { recursive: true });
        }

        const content = buildSkillFileContent(
          skillName,
          finalDescription,
          finalBody,
        );
        fs.writeFileSync(skillFile, content, 'utf-8');

        const verb = exists ? 'updated' : 'created';
        const reloadHint =
          'Type `/skills reload` in interactive mode, or restart openrnd to activate.';
        const msg = `✅ Skill **${skillName}** ${verb} at \`${skillFile}\`.\n\n${reloadHint}`;
        return { llmContent: msg, returnDisplay: msg };
      }

      case 'delete': {
        const { name } = this.params;
        if (!name) {
          return {
            llmContent: 'Error: "name" is required for action "delete".',
            returnDisplay: 'Error: name required',
            error: { message: 'name required' },
          };
        }

        const skillName = toKebabCase(name);
        const skillDir = path.join(skillsDir, skillName);

        if (!fs.existsSync(skillDir)) {
          const msg = `Skill "${skillName}" not found in ${scope} skills (${skillsDir}).`;
          return { llmContent: msg, returnDisplay: msg };
        }

        fs.rmSync(skillDir, { recursive: true, force: true });
        const msg = `✅ Skill **${skillName}** deleted from ${scope} skills.\n\nType \`/skills reload\` or restart openrnd to apply.`;
        return { llmContent: msg, returnDisplay: msg };
      }
      default: {
        const exhaustive: never = action;
        return {
          llmContent: `Unknown action: ${String(exhaustive)}`,
          returnDisplay: `Unknown action: ${String(exhaustive)}`,
          error: { message: `Unknown action: ${String(exhaustive)}` },
        };
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Tool class
// ---------------------------------------------------------------------------

export class ManageSkillTool extends BaseDeclarativeTool<
  ManageSkillParams,
  ToolResult
> {
  constructor(messageBus: MessageBus) {
    super(
      MANAGE_SKILL_TOOL_NAME,
      MANAGE_SKILL_DISPLAY_NAME,
      MANAGE_SKILL_DESCRIPTION,
      Kind.Other,
      MANAGE_SKILL_SCHEMA,
      messageBus,
      true,
      false,
    );
  }

  protected createInvocation(
    params: ManageSkillParams,
    messageBus: MessageBus,
  ): ToolInvocation<ManageSkillParams, ToolResult> {
    return new ManageSkillInvocation(params, messageBus);
  }
}
