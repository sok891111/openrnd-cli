/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
import { getErrorMessage, isNodeError } from '../utils/errors.js';

const execFileAsync = promisify(execFile);

export const MANAGE_SKILL_TOOL_NAME = 'manage_skill';
export const MANAGE_SKILL_DISPLAY_NAME = 'Manage Skill';

const MANAGE_SKILL_DESCRIPTION = `Create, install, list, or delete openrnd skills.
Skills are markdown files that give the model specialized knowledge and workflows.
They live in ~/.openrnd/skills/<name>/SKILL.md and are auto-loaded on startup.

Use this tool when the user says things like:
- "스킬 만들어줘 — 웹 크롤링 자동화"
- "Create a skill for summarizing Slack threads"
- "스킬 목록 보여줘"
- "xxx 스킬 삭제해줘"
- "Update the xxx skill"
- "이 bitbucket repo 에서 스킬 설치해줘 — ssh://git@..." (action "install")
- "Install a skill from this git repo: git@github.com:org/repo.git"

For installing from a git repository (including internal Bitbucket/GitHub over
ssh:// or git@ URLs), use action "install" with the "repository" field. The repo
is cloned via the system \`git\` (so existing SSH keys / known_hosts are used).

After creating or deleting a skill, it takes effect on the NEXT openrnd session start.
In an active interactive session the user can type /skills reload to apply immediately.

Skill body guidelines:
- Write clear, concise instructions in markdown
- Include example inputs/outputs if helpful
- Keep under 500 lines; reference external files for large content
- The description field is the primary trigger — make it specific about WHEN to use this skill`;

interface ManageSkillParams {
  action: 'create' | 'update' | 'delete' | 'list' | 'install';
  name?: string;
  description?: string;
  body?: string;
  repository?: string;
  ref?: string;
  scope?: 'user' | 'workspace';
}

const MANAGE_SKILL_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['create', 'update', 'delete', 'list', 'install'],
      description:
        '"create" to make a new skill, "update" to modify an existing one, "delete" to remove, "list" to show all installed skills, "install" to clone a skill from a git repository (http(s)://, ssh://, or git@host:path URLs).',
    },
    name: {
      type: 'string',
      description:
        'Skill identifier in kebab-case (e.g. "web-crawler", "slack-summarizer"). Required for create/update/delete. Optional for install (derived from the repository name when omitted).',
    },
    repository: {
      type: 'string',
      description:
        'Git repository URL to install the skill from. Supports https:// as well as SSH forms like "ssh://git@bitbucket.example.com/team/repo.git" or "git@bitbucket.example.com:team/repo.git". Required for action "install".',
    },
    ref: {
      type: 'string',
      description:
        'Optional git branch, tag, or commit to check out after cloning (install only). Defaults to the repository default branch.',
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

/**
 * Derive a skill name from a git repository URL.
 * Handles https://, ssh://, and scp-like "git@host:team/repo.git" forms.
 */
function repoNameFromUrl(repository: string): string {
  let tail = repository.trim();
  // scp-like syntax: git@host:team/repo.git -> team/repo.git
  const scpMatch = tail.match(/^[^/]+@[^/:]+:(.+)$/);
  if (scpMatch) {
    tail = scpMatch[1];
  }
  // Strip trailing slashes, then take the last path segment.
  tail = tail.replace(/\/+$/, '');
  const segment = tail.split('/').pop() ?? tail;
  return toKebabCase(segment.replace(/\.git$/i, ''));
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
    const { action, name, repository } = this.params;
    if (action === 'create') return `Create skill: ${name ?? '(unnamed)'}`;
    if (action === 'update') return `Update skill: ${name ?? '(unnamed)'}`;
    if (action === 'delete') return `Delete skill: ${name ?? '(unnamed)'}`;
    if (action === 'install')
      return `Install skill from: ${repository ?? '(no repository)'}`;
    return 'List skills';
  }

  override async execute(options: ExecuteOptions): Promise<ToolResult> {
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

      case 'install': {
        const { repository, ref } = this.params;

        if (!repository || !repository.trim()) {
          return {
            llmContent:
              'Error: "repository" is required for action "install" (e.g. an https:// or ssh:// git URL).',
            returnDisplay: 'Error: repository required',
            error: { message: 'repository required' },
          };
        }

        const repoUrl = repository.trim();
        const skillName = this.params.name
          ? toKebabCase(this.params.name)
          : repoNameFromUrl(repoUrl);

        if (!skillName) {
          return {
            llmContent: `Error: could not derive a skill name from "${repoUrl}". Pass an explicit "name".`,
            returnDisplay: 'Error: could not derive skill name',
            error: { message: 'could not derive skill name' },
          };
        }

        const skillDir = path.join(skillsDir, skillName);

        if (fs.existsSync(skillDir)) {
          return {
            llmContent: `Error: a skill named "${skillName}" already exists at ${skillDir}. Delete it first or pass a different "name".`,
            returnDisplay: `Error: skill "${skillName}" already exists`,
            error: { message: `skill "${skillName}" already exists` },
          };
        }

        if (!fs.existsSync(skillsDir)) {
          fs.mkdirSync(skillsDir, { recursive: true });
        }

        // Clone via the system git so existing SSH keys / known_hosts and
        // credential helpers are reused. This is what makes ssh:// and git@
        // (internal Bitbucket) URLs work.
        // Shared environment + spawn options so neither the clone nor the
        // checkout can block on an interactive prompt or run unbounded.
        // BatchMode/StrictHostKeyChecking are *appended* to any existing
        // GIT_SSH_COMMAND so a pre-set value (common in corporate setups)
        // doesn't silently disable the non-interactive guard.
        const baseSshCommand = process.env['GIT_SSH_COMMAND'] ?? 'ssh';
        const gitExecOptions = {
          env: {
            ...process.env,
            // Never block on an interactive password prompt — fail fast
            // instead of hanging the turn (which looked like a silent exit).
            GIT_TERMINAL_PROMPT: '0',
            GIT_SSH_COMMAND: `${baseSshCommand} -o BatchMode=yes -o StrictHostKeyChecking=accept-new`,
          },
          timeout: 120_000,
          // Honor turn cancellation (ESC) so the child git process is killed
          // instead of being orphaned while the turn appears to hang.
          signal: options.abortSignal,
        };

        try {
          await execFileAsync(
            'git',
            ['clone', '--depth', '1', repoUrl, skillDir],
            gitExecOptions,
          );

          if (ref && ref.trim()) {
            await execFileAsync(
              'git',
              ['-C', skillDir, 'checkout', ref.trim()],
              gitExecOptions,
            );
          }
        } catch (err) {
          // Clean up a partial clone so a retry isn't blocked by "already exists".
          if (fs.existsSync(skillDir)) {
            fs.rmSync(skillDir, { recursive: true, force: true });
          }
          const stderr =
            err instanceof Error &&
            'stderr' in err &&
            typeof err.stderr === 'string'
              ? err.stderr
              : '';
          const detail = (stderr || getErrorMessage(err)).trim();
          const hint =
            isNodeError(err) && err.code === 'ENOENT'
              ? '`git` 명령을 찾을 수 없습니다. git 설치 여부를 확인하세요.'
              : 'ssh URL 인 경우: SSH 키 등록(ssh-add), known_hosts, 사내망(VPN) 연결을 확인하세요.';
          return {
            llmContent: `Error cloning "${repoUrl}":\n${detail}\n\n${hint}`,
            returnDisplay: `Error: git clone failed`,
            error: { message: `git clone failed: ${detail}` },
          };
        }

        // Validate that the cloned repo actually contains a SKILL.md.
        const skillFile = path.join(skillDir, 'SKILL.md');
        if (!fs.existsSync(skillFile)) {
          fs.rmSync(skillDir, { recursive: true, force: true });
          return {
            llmContent: `Error: cloned repository "${repoUrl}" does not contain a SKILL.md at its root. Removed.`,
            returnDisplay: 'Error: no SKILL.md in repository',
            error: { message: 'no SKILL.md in repository' },
          };
        }

        // Drop the .git dir so the installed skill is a plain copy.
        const gitDir = path.join(skillDir, '.git');
        if (fs.existsSync(gitDir)) {
          fs.rmSync(gitDir, { recursive: true, force: true });
        }

        const reloadHint =
          'Type `/skills reload` in interactive mode, or restart openrnd to activate.';
        const msg = `✅ Skill **${skillName}** installed from \`${repoUrl}\` into \`${skillDir}\`.\n\n${reloadHint}`;
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
