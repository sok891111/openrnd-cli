/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  renderWithProviders,
  persistentStateMock,
} from '../../test-utils/render.js';
import { AppHeader } from './AppHeader.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeFakeConfig } from '@openwork/core';
import crypto from 'node:crypto';
import { _clearSessionBannersForTest } from '../hooks/useBanner.js';

vi.mock('../utils/terminalSetup.js', () => ({
  getTerminalProgram: () => null,
}));

describe('<AppHeader />', () => {
  beforeEach(() => {
    _clearSessionBannersForTest();
  });

  it('should render the banner with default text', async () => {
    const uiState = {
      history: [],
      bannerData: {
        defaultText: 'This is the default banner',
        warningText: '',
      },
      bannerVisible: true,
    };

    const { lastFrame, unmount } = await renderWithProviders(
      <AppHeader version="1.0.0" />,
      {
        uiState,
      },
    );

    expect(lastFrame()).toContain('This is the default banner');
    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });

  it('should render the banner with warning text', async () => {
    const uiState = {
      history: [],
      bannerData: {
        defaultText: 'This is the default banner',
        warningText: 'There are capacity issues',
      },
      bannerVisible: true,
    };

    const { lastFrame, unmount } = await renderWithProviders(
      <AppHeader version="1.0.0" />,
      {
        uiState,
      },
    );

    expect(lastFrame()).toContain('There are capacity issues');
    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });

  it('should not render the banner when no flags are set', async () => {
    const uiState = {
      history: [],
      bannerData: {
        defaultText: '',
        warningText: '',
      },
    };

    const { lastFrame, unmount } = await renderWithProviders(
      <AppHeader version="1.0.0" />,
      {
        uiState,
      },
    );

    expect(lastFrame()).not.toContain('Banner');
    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });

  it('should not render the default banner if shown count is 5 or more', async () => {
    const uiState = {
      history: [],
      bannerData: {
        defaultText: 'This is the default banner',
        warningText: '',
      },
    };

    persistentStateMock.setData({
      defaultBannerShownCount: {
        [crypto
          .createHash('sha256')
          .update(uiState.bannerData.defaultText)
          .digest('hex')]: 5,
      },
    });

    const { lastFrame, unmount } = await renderWithProviders(
      <AppHeader version="1.0.0" />,
      {
        uiState,
      },
    );

    expect(lastFrame()).not.toContain('This is the default banner');
    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });

  it('should increment the version count when default banner is displayed', async () => {
    const uiState = {
      history: [],
      bannerData: {
        defaultText: 'This is the default banner',
        warningText: '',
      },
    };

    // Reset persisted state so the banner count from earlier tests doesn't
    // suppress this banner (the fake's data persists across tests).
    persistentStateMock.setData({});

    const { unmount } = await renderWithProviders(
      <AppHeader version="1.0.0" />,
      {
        uiState,
      },
    );

    expect(persistentStateMock.set).toHaveBeenCalledWith(
      'defaultBannerShownCount',
      {
        [crypto
          .createHash('sha256')
          .update(uiState.bannerData.defaultText)
          .digest('hex')]: 1,
      },
    );
    unmount();
  });

  it('should render banner text with unescaped newlines', async () => {
    const uiState = {
      history: [],
      bannerData: {
        defaultText: 'First line\\nSecond line',
        warningText: '',
      },
      bannerVisible: true,
    };

    const { lastFrame, unmount } = await renderWithProviders(
      <AppHeader version="1.0.0" />,
      {
        uiState,
      },
    );

    expect(lastFrame()).not.toContain('First line\\nSecond line');
    unmount();
  });

  it('renders the OpenWork logo and AI 알파 TF signature, no auth info', async () => {
    const mockConfig = makeFakeConfig();

    const { lastFrame, waitUntilReady, unmount } = await renderWithProviders(
      <AppHeader version="1.0.0" />,
      {
        config: mockConfig,
        uiState: {
          terminalWidth: 120,
        },
      },
    );
    await waitUntilReady();

    const frame = lastFrame();
    // Block characters from the OpenWork ANSI Shadow logo.
    expect(frame).toContain('██');
    // Build-team signature is present.
    expect(frame).toContain('AI 알파 TF');
    // Auth identity is gone (no "Authenticated with" / "Signed in").
    expect(frame).not.toContain('Authenticated with');
    expect(frame).not.toContain('Signed in');
    expect(frame).toMatchSnapshot();
    unmount();
  });
});
