/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type {
  ToolConfirmationOutcome,
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
  type ToolCallConfirmationDetails,
  type ToolExecuteConfirmationDetails,
  type ExecuteOptions,
} from './tools.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';

export const PYTHON_EXEC_TOOL_NAME = 'run_python';

export const PYTHON_EXEC_DISPLAY_NAME = 'Run Python';

const PYTHON_EXEC_DESCRIPTION = `Execute a Python script and return its output.
Use this tool to run Python code for tasks such as:
- Web crawling and scraping (requests, BeautifulSoup, playwright, selenium)
- Data processing (pandas, csv, json, xlsx)
- File conversion or transformation
- API calls and HTTP requests
- System automation
- Mathematical computations

The script runs in a temporary file. stdout and stderr are captured and returned.
Timeout defaults to 60 seconds. Install additional packages with pip inside the script if needed.`;

interface PythonExecParams {
  code: string;
  timeout_seconds?: number;
  working_directory?: string;
}

const PYTHON_EXEC_SCHEMA = {
  type: 'object',
  properties: {
    code: {
      type: 'string',
      description: 'The Python code to execute.',
    },
    timeout_seconds: {
      type: 'number',
      description: 'Maximum execution time in seconds (default: 60, max: 300).',
    },
    working_directory: {
      type: 'string',
      description:
        'Working directory for script execution. Defaults to current directory.',
    },
  },
  required: ['code'],
};

function detectPythonExecutable(): string {
  if (process.platform === 'win32') {
    // On Windows, try 'python' first, then 'py'
    return 'python';
  }
  return 'python3';
}

class PythonExecInvocation extends BaseToolInvocation<
  PythonExecParams,
  ToolResult
> {
  constructor(params: PythonExecParams, messageBus: MessageBus) {
    super(params, messageBus, PYTHON_EXEC_TOOL_NAME, PYTHON_EXEC_DISPLAY_NAME);
  }

  override getDescription(): string {
    const preview = this.params.code.split('\n').slice(0, 3).join('\n');
    const truncated = this.params.code.split('\n').length > 3 ? '\n...' : '';
    return `Run Python script:\n\`\`\`python\n${preview}${truncated}\n\`\`\``;
  }

  override getDisplayTitle(): string {
    const firstLine = this.params.code.trim().split('\n')[0] ?? '';
    return `python: ${firstLine.slice(0, 60)}`;
  }

  override async shouldConfirmExecute(
    abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails | false> {
    void abortSignal;
    const details: ToolExecuteConfirmationDetails = {
      type: 'exec',
      title: 'Run Python Script',
      command: this.params.code.slice(0, 200),
      rootCommand: 'python',
      rootCommands: ['python', 'python3', 'py'],
      onConfirm: async (outcome: ToolConfirmationOutcome) => {
        await this.publishPolicyUpdate(outcome);
      },
    };
    return details;
  }

  override async execute({
    abortSignal,
    updateOutput,
  }: ExecuteOptions): Promise<ToolResult> {
    const timeout = Math.min(this.params.timeout_seconds ?? 60, 300) * 1000;
    const cwd = this.params.working_directory ?? process.cwd();
    const tmpFile = path.join(os.tmpdir(), `openrnd_py_${randomUUID()}.py`);

    try {
      await fs.writeFile(tmpFile, this.params.code, 'utf-8');

      const pythonExe = detectPythonExecutable();
      let stdout = '';
      let stderr = '';
      let killed = false;

      await new Promise<void>((resolve, reject) => {
        const child = spawn(pythonExe, [tmpFile], {
          cwd,
          env: process.env,
          shell: process.platform === 'win32',
        });

        const timer = setTimeout(() => {
          killed = true;
          child.kill();
        }, timeout);

        const abortHandler = () => {
          killed = true;
          child.kill();
        };
        abortSignal.addEventListener('abort', abortHandler, { once: true });

        child.stdout.on('data', (data: Buffer) => {
          const chunk = data.toString();
          stdout += chunk;
          if (updateOutput) {
            updateOutput(stdout + (stderr ? `\n[stderr]\n${stderr}` : ''));
          }
        });

        child.stderr.on('data', (data: Buffer) => {
          const chunk = data.toString();
          stderr += chunk;
        });

        child.on('error', (err) => {
          clearTimeout(timer);
          abortSignal.removeEventListener('abort', abortHandler);
          if (err.message.includes('ENOENT')) {
            // Try fallback python executable
            reject(
              new Error(
                `Python executable '${pythonExe}' not found. ` +
                  `Please install Python 3 and ensure it is in your PATH. ` +
                  `On Windows you can also use 'py' launcher.`,
              ),
            );
          } else {
            reject(err);
          }
        });

        child.on('close', (code) => {
          clearTimeout(timer);
          abortSignal.removeEventListener('abort', abortHandler);
          if (killed) {
            reject(
              new Error(
                `Python script timed out or was aborted after ${timeout / 1000}s`,
              ),
            );
          } else {
            resolve();
          }
          void code; // exit code is captured via stdout/stderr
        });
      });

      const output = [
        stdout ? `[stdout]\n${stdout}` : '',
        stderr ? `[stderr]\n${stderr}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');

      return {
        llmContent: output || '(no output)',
        returnDisplay: output || '(no output)',
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        llmContent: `Error: ${msg}`,
        returnDisplay: `Error: ${msg}`,
        error: { message: msg },
      };
    } finally {
      await fs.unlink(tmpFile).catch(() => {});
    }
  }
}

export class PythonExecTool extends BaseDeclarativeTool<
  PythonExecParams,
  ToolResult
> {
  constructor(messageBus: MessageBus) {
    super(
      PYTHON_EXEC_TOOL_NAME,
      PYTHON_EXEC_DISPLAY_NAME,
      PYTHON_EXEC_DESCRIPTION,
      Kind.Execute,
      PYTHON_EXEC_SCHEMA,
      messageBus,
      true,
      true,
    );
  }

  protected createInvocation(
    params: PythonExecParams,
    messageBus: MessageBus,
  ): ToolInvocation<PythonExecParams, ToolResult> {
    return new PythonExecInvocation(params, messageBus);
  }
}
