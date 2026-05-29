/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useEffect } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { SettingScope, type LoadedSettings } from '../../config/settings.js';
import { AuthType, type Config } from '@openrnd/core';
import { AuthState } from '../types.js';

interface AuthDialogProps {
  config: Config;
  settings: LoadedSettings;
  setAuthState: (state: AuthState) => void;
  authError: string | null;
  onAuthError: (error: string | null) => void;
  setAuthContext: (context: { requiresRestart?: boolean }) => void;
}

export function AuthDialog({
  settings,
  setAuthState,
  onAuthError,
  setAuthContext,
}: AuthDialogProps): React.JSX.Element {
  useEffect(() => {
    setAuthContext({});
    onAuthError(null);
    settings.setValue(
      SettingScope.User,
      'security.auth.selectedType',
      AuthType.USE_LOCAL_LLM,
    );
    setAuthState(AuthState.Unauthenticated);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Box
      borderStyle="round"
      borderColor={theme.ui.focus}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      <Text bold color={theme.text.primary}>
        Local LLM Mode
      </Text>
      <Box marginTop={1}>
        <Text color={theme.text.secondary}>
          Configuring local LLM authentication...
        </Text>
      </Box>
    </Box>
  );
}
