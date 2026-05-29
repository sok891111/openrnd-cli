/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  debugLogger,
  OutputFormat,
  ExitCodes,
  getAuthTypeFromEnv,
  AuthType,
  type Config,
} from '@openrnd/core';
import { type LoadedSettings } from './config/settings.js';
import { validateAuthMethod } from './config/auth.js';
import { handleError } from './utils/errors.js';
import { runExitCleanup } from './utils/cleanup.js';

export async function validateNonInteractiveAuth(
  configuredAuthType: AuthType | undefined,
  useExternalAuth: boolean | undefined,
  nonInteractiveConfig: Config,
  settings: LoadedSettings,
) {
  try {
    // Default to local LLM if no auth configured
    const effectiveAuthType =
      configuredAuthType || getAuthTypeFromEnv() || AuthType.USE_LOCAL_LLM;

    const enforcedType = settings.merged.security.auth.enforcedType;
    if (enforcedType && effectiveAuthType !== enforcedType) {
      const message = effectiveAuthType
        ? `The enforced authentication type is '${enforcedType}', but the current type is '${effectiveAuthType}'. Please re-authenticate with the correct type.`
        : `The auth type '${enforcedType}' is enforced, but no authentication is configured.`;
      throw new Error(message);
    }

    const authType: AuthType = effectiveAuthType;

    // Skip auth validation for local LLM
    if (authType === AuthType.USE_LOCAL_LLM) {
      return authType;
    }

    if (!useExternalAuth) {
      const err = await validateAuthMethod(String(authType));
      if (err != null) {
        throw new Error(err);
      }
    }

    return authType;
  } catch (error) {
    if (nonInteractiveConfig.getOutputFormat() === OutputFormat.JSON) {
      handleError(
        error instanceof Error ? error : new Error(String(error)),
        nonInteractiveConfig,
        ExitCodes.FATAL_AUTHENTICATION_ERROR,
      );
    } else {
      debugLogger.error(error instanceof Error ? error.message : String(error));
      await runExitCleanup();
      process.exit(ExitCodes.FATAL_AUTHENTICATION_ERROR);
    }
  }
}
