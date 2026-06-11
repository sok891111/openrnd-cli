/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/* eslint-disable no-console */

import type { CommandModule } from 'yargs';
import chalk from 'chalk';
import { loadSettings, SettingScope } from '../config/settings.js';
import { exitCli } from './utils.js';
import { fetch } from 'undici';

// ── helpers ──────────────────────────────────────────────────────────────────

function printLlmSettings(settings: {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}) {
  const url = settings.baseUrl ?? chalk.dim('(not set)');
  const model = settings.model ?? chalk.dim('(not set)');
  const key = settings.apiKey
    ? chalk.dim('*'.repeat(Math.min(settings.apiKey.length, 8)) + '…')
    : chalk.dim('(not set)');

  console.log(chalk.bold('\nOpenRND LLM Settings'));
  console.log(chalk.dim('─'.repeat(40)));
  console.log(`  Base URL : ${chalk.cyan(url)}`);
  console.log(`  Model    : ${chalk.cyan(model)}`);
  console.log(`  API Key  : ${key}`);
  console.log(chalk.dim('─'.repeat(40)));
  console.log(
    chalk.dim(`\nConfig file: ${loadSettings(process.cwd()).user.path}`),
  );
}

// ── set command ───────────────────────────────────────────────────────────────

const setCommand: CommandModule = {
  command: 'set',
  describe: 'Configure the LLM connection (base URL, model, API key)',
  builder: (yargs) =>
    yargs
      .option('base-url', {
        alias: 'u',
        type: 'string',
        description:
          'OpenAI-compatible API base URL. Example: https://api.openai.com/v1',
      })
      .option('model', {
        alias: 'm',
        type: 'string',
        description: 'Model name. Example: gpt-4o, llama3.2',
      })
      .option('api-key', {
        alias: 'k',
        type: 'string',
        description: 'API key for the service. Use "ollama" for Ollama.',
      })
      .option('scope', {
        type: 'string',
        choices: ['user', 'workspace'],
        default: 'user',
        description: '"user" saves to ~/.openrnd/settings.json (default)',
      })
      .check((argv) => {
        if (!argv['base-url'] && !argv['model'] && !argv['api-key']) {
          throw new Error(
            'Provide at least one of --base-url, --model, or --api-key',
          );
        }
        return true;
      }),
  handler: async (argv) => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const baseUrl = argv['base-url'] as string | undefined;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const model = argv['model'] as string | undefined;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const apiKey = argv['api-key'] as string | undefined;
    const scope =
      argv['scope'] === 'workspace'
        ? SettingScope.Workspace
        : SettingScope.User;

    const settings = loadSettings(process.cwd());
    const current = settings.forScope(scope).settings;
    const currentLlm =
      (current['llm'] as Record<string, unknown> | undefined) ?? {};

    const newLlm: Record<string, unknown> = { ...currentLlm };
    if (baseUrl !== undefined) newLlm['baseUrl'] = baseUrl;
    if (model !== undefined) newLlm['model'] = model;
    if (apiKey !== undefined) newLlm['apiKey'] = apiKey;

    settings.setValue(scope, 'llm', newLlm);

    console.log(chalk.green('✅ LLM settings saved.'));
    printLlmSettings({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      baseUrl: newLlm['baseUrl'] as string | undefined,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      model: newLlm['model'] as string | undefined,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      apiKey: newLlm['apiKey'] as string | undefined,
    });
    console.log(chalk.yellow('\nRestart openrnd to apply the new settings.'));

    await exitCli();
  },
};

// ── vision helpers ─────────────────────────────────────────────────────────────

interface VisionSettings {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

interface LlmSettings {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  vision?: VisionSettings;
}

function printVisionSettings(
  vision: { baseUrl?: string; model?: string; apiKey?: string },
  inherited: { baseUrl: boolean; apiKey: boolean },
) {
  const url = vision.baseUrl
    ? chalk.cyan(vision.baseUrl) +
      (inherited.baseUrl ? chalk.dim(' (inherited from LLM)') : '')
    : chalk.dim('(not set)');
  const model = vision.model
    ? chalk.cyan(vision.model)
    : chalk.dim('(not set)');
  const key = vision.apiKey
    ? chalk.dim('*'.repeat(Math.min(vision.apiKey.length, 8)) + '…') +
      (inherited.apiKey ? chalk.dim(' (inherited from LLM)') : '')
    : chalk.dim('(not set)');

  console.log(chalk.bold('\nOpenRND Vision Model Settings'));
  console.log(chalk.dim('─'.repeat(40)));
  console.log(`  Base URL : ${url}`);
  console.log(`  Model    : ${model}`);
  console.log(`  API Key  : ${key}`);
  console.log(chalk.dim('─'.repeat(40)));
}

// ── vision set command ──────────────────────────────────────────────────────────

const visionSetCommand: CommandModule = {
  command: 'set',
  describe:
    'Configure the vision model used to analyze images for the text-only LLM',
  builder: (yargs) =>
    yargs
      .option('model', {
        alias: 'm',
        type: 'string',
        description:
          'Vision-capable model name. Example: llava, qwen2-vl, gpt-4o',
      })
      .option('base-url', {
        alias: 'u',
        type: 'string',
        description:
          'OpenAI-compatible API base URL. Defaults to the primary LLM base URL when omitted.',
      })
      .option('api-key', {
        alias: 'k',
        type: 'string',
        description:
          'API key for the vision service. Defaults to the primary LLM API key when omitted.',
      })
      .option('scope', {
        type: 'string',
        choices: ['user', 'workspace'],
        default: 'user',
        description: '"user" saves to ~/.openrnd/settings.json (default)',
      })
      .check((argv) => {
        if (!argv['model'] && !argv['base-url'] && !argv['api-key']) {
          throw new Error(
            'Provide at least one of --model, --base-url, or --api-key',
          );
        }
        return true;
      }),
  handler: async (argv) => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const model = argv['model'] as string | undefined;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const baseUrl = argv['base-url'] as string | undefined;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const apiKey = argv['api-key'] as string | undefined;
    const scope =
      argv['scope'] === 'workspace'
        ? SettingScope.Workspace
        : SettingScope.User;

    const settings = loadSettings(process.cwd());
    const current = settings.forScope(scope).settings;
    const currentLlm = (current['llm'] as LlmSettings | undefined) ?? {};
    const currentVision = currentLlm.vision ?? {};

    // Fall back to the primary LLM connection when the vision-specific value is
    // not provided (and not already set), so a single-gateway deployment can set
    // just the model. We persist the resolved value rather than relying on a
    // runtime fallback because the base URL has no such fallback at call time.
    const primaryBaseUrl =
      currentLlm.baseUrl ?? process.env['OPENRND_BASE_URL'];
    const primaryApiKey = currentLlm.apiKey ?? process.env['OPENRND_API_KEY'];

    const resolvedBaseUrl = baseUrl ?? currentVision.baseUrl ?? primaryBaseUrl;
    const resolvedApiKey = apiKey ?? currentVision.apiKey ?? primaryApiKey;

    const newVision: VisionSettings = { ...currentVision };
    if (model !== undefined) newVision.model = model;
    if (resolvedBaseUrl !== undefined) newVision.baseUrl = resolvedBaseUrl;
    if (resolvedApiKey !== undefined) newVision.apiKey = resolvedApiKey;

    const newLlm: LlmSettings = { ...currentLlm, vision: newVision };
    settings.setValue(scope, 'llm', newLlm);

    console.log(chalk.green('✅ Vision model settings saved.'));
    printVisionSettings(
      {
        baseUrl: newVision.baseUrl,
        model: newVision.model,
        apiKey: newVision.apiKey,
      },
      {
        baseUrl: baseUrl === undefined && resolvedBaseUrl === primaryBaseUrl,
        apiKey: apiKey === undefined && resolvedApiKey === primaryApiKey,
      },
    );

    if (!newVision.model) {
      console.log(
        chalk.yellow(
          '\n⚠  No vision model name set. The vision model stays disabled until you set --model.',
        ),
      );
    }
    if (!newVision.baseUrl) {
      console.log(
        chalk.yellow(
          '\n⚠  No base URL available. Configure the primary LLM first (openrnd llm set) or pass --base-url.',
        ),
      );
    }
    console.log(chalk.yellow('\nRestart openrnd to apply the new settings.'));

    await exitCli();
  },
};

// ── vision show command ─────────────────────────────────────────────────────────

const visionShowCommand: CommandModule = {
  command: 'show',
  describe: 'Show the current vision model settings',
  builder: (yargs) => yargs,
  handler: async () => {
    const settings = loadSettings(process.cwd());
    const llm = settings.merged.llm as LlmSettings | undefined;
    const vision = llm?.vision ?? {};

    const baseUrl =
      process.env['OPENRND_VISION_BASE_URL'] ??
      vision.baseUrl ??
      process.env['OPENRND_BASE_URL'] ??
      llm?.baseUrl;
    const model = process.env['OPENRND_VISION_MODEL'] ?? vision.model;
    const apiKey =
      process.env['OPENRND_VISION_API_KEY'] ??
      vision.apiKey ??
      process.env['OPENRND_API_KEY'] ??
      llm?.apiKey;

    printVisionSettings(
      { baseUrl, model, apiKey },
      {
        baseUrl: !vision.baseUrl && !process.env['OPENRND_VISION_BASE_URL'],
        apiKey: !vision.apiKey && !process.env['OPENRND_VISION_API_KEY'],
      },
    );

    if (!model) {
      console.log(
        chalk.yellow(
          '\n⚠  No vision model configured. Run: openrnd vision set --model <model>',
        ),
      );
    }

    await exitCli();
  },
};

// ── vision parent command ───────────────────────────────────────────────────────

export const visionCommand: CommandModule = {
  command: 'vision',
  describe: 'Manage the vision model used to analyze images',
  builder: (yargs) =>
    yargs
      .command(visionSetCommand)
      .command(visionShowCommand)
      .demandCommand(1, 'Use: openrnd vision set | show')
      .version(false),
  handler: () => {},
};

// ── show command ──────────────────────────────────────────────────────────────

const showCommand: CommandModule = {
  command: 'show',
  describe: 'Show the current LLM connection settings',
  builder: (yargs) => yargs,
  handler: async () => {
    const settings = loadSettings(process.cwd());
    const llm = settings.merged.llm as
      | { baseUrl?: string; model?: string; apiKey?: string }
      | undefined;

    const effective = {
      baseUrl: process.env['OPENRND_BASE_URL'] ?? llm?.baseUrl,
      model: process.env['OPENRND_MODEL'] ?? llm?.model,
      apiKey: process.env['OPENRND_API_KEY'] ?? llm?.apiKey,
    };

    printLlmSettings(effective);

    if (!effective.baseUrl) {
      console.log(
        chalk.yellow(
          '\n⚠  No LLM configured. Run: openrnd llm set --base-url <url> --model <model> --api-key <key>',
        ),
      );
    }

    await exitCli();
  },
};

// ── test command ──────────────────────────────────────────────────────────────

const testCommand: CommandModule = {
  command: 'test',
  describe: 'Test the LLM connection with a simple ping',
  builder: (yargs) => yargs,
  handler: async () => {
    const settings = loadSettings(process.cwd());
    const llm = settings.merged.llm as
      | { baseUrl?: string; model?: string; apiKey?: string }
      | undefined;

    const baseUrl = process.env['OPENRND_BASE_URL'] ?? llm?.baseUrl;
    const model = process.env['OPENRND_MODEL'] ?? llm?.model ?? 'llama3.2';
    const apiKey = process.env['OPENRND_API_KEY'] ?? llm?.apiKey ?? 'ollama';

    if (!baseUrl) {
      console.error(
        chalk.red(
          '✗ No base URL configured. Run: openrnd llm set --base-url <url>',
        ),
      );
      await exitCli(1);
      return;
    }

    console.log(
      chalk.dim(`Testing connection to ${baseUrl} with model ${model}...`),
    );

    try {
      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Say "ok" in one word.' }],
          max_tokens: 10,
          stream: false,
        }),
      });

      if (resp.ok) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        const data = (await resp.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          model?: string;
        };
        const reply = data.choices?.[0]?.message?.content ?? '(empty)';
        console.log(chalk.green(`✅ Connection OK`));
        console.log(`   Model responded: ${chalk.cyan(reply.trim())}`);
        console.log(`   Model reported : ${chalk.dim(data.model ?? model)}`);
      } else {
        const err = await resp.text();
        console.error(chalk.red(`✗ HTTP ${resp.status}: ${err.slice(0, 200)}`));
        await exitCli(1);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`✗ Connection failed: ${msg}`));
      console.error(
        chalk.dim(
          '\nMake sure your LLM service is running and the base URL is correct.',
        ),
      );
      await exitCli(1);
    }

    await exitCli();
  },
};

// ── parent command ────────────────────────────────────────────────────────────

export const llmCommand: CommandModule = {
  command: 'llm',
  describe: 'Manage LLM connection settings',
  builder: (yargs) =>
    yargs
      .command(setCommand)
      .command(showCommand)
      .command(testCommand)
      .demandCommand(1, 'Use: openrnd llm set | show | test')
      .version(false),
  handler: () => {},
};
