/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';
import type { LoadedSettings } from '../../config/settings.js';
import { AuthType, type Config, debugLogger } from '@openrnd/core';
import { AuthState } from '../types.js';
import type { AccountSuspensionInfo } from '../contexts/UIStateContext.js';

export async function validateAuthMethodWithSettings(
  _authType?: unknown,
  _settings?: unknown,
): Promise<string | null> {
  return null;
}

export const useAuthCommand = (
  _settings: LoadedSettings,
  _config: Config,
  initialAuthError: string | null = null,
  initialAccountSuspensionInfo: AccountSuspensionInfo | null = null,
) => {
  // Google auth is removed — always start as Authenticated.
  // performInitialAuth already called config.refreshAuth(USE_LOCAL_LLM)
  // before the UI renders, so no additional auth is needed here.
  const [authState, setAuthState] = useState<AuthState>(
    initialAuthError ? AuthState.Updating : AuthState.Authenticated,
  );

  const [authError, setAuthError] = useState<string | null>(initialAuthError);
  const [accountSuspensionInfo, setAccountSuspensionInfo] =
    useState<AccountSuspensionInfo | null>(initialAccountSuspensionInfo);

  const onAuthError = useCallback(
    (error: string | null) => {
      setAuthError(error);
      if (error) {
        debugLogger.warn('Auth error (local LLM mode):', error);
      }
    },
    [setAuthError],
  );

  const reloadApiKey = useCallback(async () => '', []);

  debugLogger.log(`Auth mode: ${AuthType.USE_LOCAL_LLM}. State: ${authState}.`);

  return {
    authState,
    setAuthState,
    authError,
    onAuthError,
    apiKeyDefaultValue: undefined,
    reloadApiKey,
    accountSuspensionInfo,
    setAccountSuspensionInfo,
  };
};
