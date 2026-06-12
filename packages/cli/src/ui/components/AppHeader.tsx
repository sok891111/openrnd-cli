/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import { Tips } from './Tips.js';
import { useSettings } from '../contexts/SettingsContext.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { Banner } from './Banner.js';
import { useBanner } from '../hooks/useBanner.js';
import { useTips } from '../hooks/useTips.js';
import { theme } from '../semantic-colors.js';
import { ThemedGradient } from './ThemedGradient.js';
import { CliSpinner } from './CliSpinner.js';

import {
  openWorkLogo,
  openWorkLogoShort,
  openWorkLogoTiny,
  openWorkSignature,
} from './AsciiArt.js';
import { getAsciiArtWidth } from '../utils/textUtils.js';

interface AppHeaderProps {
  version: string;
  showDetails?: boolean;
}

export const AppHeader = ({ version, showDetails = true }: AppHeaderProps) => {
  const settings = useSettings();
  const config = useConfig();
  const { terminalWidth, bannerData, bannerVisible, updateInfo } = useUIState();

  const { bannerText } = useBanner(bannerData);
  const { showTips } = useTips();

  const showHeader = !(
    settings.merged.ui.hideBanner || config.getScreenReader()
  );

  // Pick the widest OpenWork logo that fits the terminal.
  const widthOfFullLogo = getAsciiArtWidth(openWorkLogo);
  const widthOfShortLogo = getAsciiArtWidth(openWorkLogoShort);
  let logo = openWorkLogoTiny;
  let isFullLogo = false;
  if (terminalWidth >= widthOfFullLogo) {
    logo = openWorkLogo;
    isFullLogo = true;
  } else if (terminalWidth >= widthOfShortLogo) {
    logo = openWorkLogoShort;
  }
  const logoWidth = getAsciiArtWidth(logo);

  const versionMeta = showDetails && (
    <Box>
      <Text color={theme.text.secondary}>openrnd v{version}</Text>
      {updateInfo?.isUpdating && (
        <Box marginLeft={2}>
          <Text color={theme.text.secondary}>
            <CliSpinner /> Updating
          </Text>
        </Box>
      )}
    </Box>
  );

  return (
    <Box flexDirection="column">
      {showHeader && (
        <Box
          flexDirection="column"
          alignItems="flex-start"
          marginTop={1}
          marginBottom={1}
          paddingLeft={1}
        >
          <ThemedGradient>{logo}</ThemedGradient>

          {/* Signature + version. Side by side under the wide logo; stacked on
              narrow terminals so they don't collide. */}
          {isFullLogo ? (
            <Box
              width={logoWidth}
              flexDirection="row"
              justifyContent="space-between"
            >
              <ThemedGradient>{openWorkSignature}</ThemedGradient>
              {versionMeta}
            </Box>
          ) : (
            <Box flexDirection="column">
              <ThemedGradient>{openWorkSignature}</ThemedGradient>
              {versionMeta}
            </Box>
          )}
        </Box>
      )}

      {bannerVisible && bannerText && (
        <Banner
          width={terminalWidth}
          bannerText={bannerText}
          isWarning={bannerData.warningText !== ''}
        />
      )}

      {!(settings.merged.ui.hideTips || config.getScreenReader()) &&
        showTips && <Tips config={config} />}
    </Box>
  );
};
