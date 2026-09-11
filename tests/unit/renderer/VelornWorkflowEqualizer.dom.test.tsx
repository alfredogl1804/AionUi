/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getStatus = vi.fn();
const preview = vi.fn();
const execute = vi.fn();
const revert = vi.fn();

vi.mock('@/common', () => ({
  ipcBridge: {
    velornGovernance: {
      getStatus: { invoke: (...args: unknown[]) => getStatus(...args) },
      preview: { invoke: (...args: unknown[]) => preview(...args) },
      execute: { invoke: (...args: unknown[]) => execute(...args) },
      revert: { invoke: (...args: unknown[]) => revert(...args) },
    },
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import VelornWorkflowEqualizer from '@/renderer/components/VelornWorkflowEqualizer';

const patch = {
  patch_id: 'patch:aionui:test',
  technical_changes: { 'timeline.marker.time_seconds': 0 },
};

describe('VelornWorkflowEqualizer', () => {
  it('keeps the full specialist studio available without occupying a software chat by default', async () => {
    render(<VelornWorkflowEqualizer />);
    await waitFor(() => expect(getStatus).toHaveBeenCalled());
    expect(screen.queryByTestId('velorn-workflow-equalizer')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('guid.velorn.title'));
    expect(await screen.findByTestId('velorn-workflow-equalizer')).toBeInTheDocument();
  });
  beforeEach(() => {
    getStatus.mockReset();
    preview.mockReset();
    execute.mockReset();
    revert.mockReset();
    getStatus.mockResolvedValue({
      available: true,
      gateway: { url: 'http://127.0.0.1:4452/mcp', status: 'healthy', toolCount: 130, workflowCount: 42 },
      authority: { url: 'http://127.0.0.1:4453', status: 'ok', policy: 'cedar-fail-closed' },
      profiles: [
        {
          profileId: 'local-style',
          label: 'Style',
          workflowId: 'local-style',
          workflowVersion: 'v1',
          kind: 'style',
          controls: [
            {
              controlId: 'rotation',
              label: 'Rotation',
              min: -180,
              max: 180,
              step: 1,
              unit: 'deg',
              value: 0,
              target: 'clip.rotation',
            },
          ],
          presetLabel: 'Technical',
          locks: [],
          evidence: 'native',
          previewOnly: false,
        },
      ],
      workflows: [
        { workflowId: 'local-style', label: 'Style', availability: 'catalogued', profileIds: ['local-style'] },
      ],
      clips: [],
      assets: [],
    });
    preview.mockResolvedValue({
      runId: 'run-ui',
      status: 'GRANT_REQUIRED',
      source: 'intent',
      profile: {},
      patch,
      preview: { checkpoint: {}, marker: {} },
    });
    execute.mockResolvedValue({
      runId: 'run-ui',
      phase: 'AUTHORIZED',
      patch,
      observedAt: '2026-09-10T00:00:00Z',
      after: { markerCount: 1 },
      executionReceipt: {
        ledger_entry_id: 'pdl-test',
        receipt: { data_path_ref: 'velorn://project/current' },
      },
    });
  });

  it('keeps execution disabled until a preview produces GRANT_REQUIRED', async () => {
    render(<VelornWorkflowEqualizer />);
    fireEvent.click(screen.getByText('guid.velorn.title'));

    await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(1));
    const authorize = screen.getByRole('button', { name: 'guid.velorn.authorize' });
    expect(authorize).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'guid.velorn.preview' }));
    await screen.findByText('GRANT_REQUIRED');

    expect(preview).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: 'local-style', values: { rotation: 0 } })
    );
    expect(execute).not.toHaveBeenCalled();
    expect(authorize).toBeEnabled();
  });

  it('restores saved controls after restart without rearming authorization', async () => {
    const status = await getStatus();
    getStatus.mockClear();
    getStatus.mockResolvedValue({
      ...status,
      restored: {
        runId: 'saved-preview',
        phase: 'GRANT_REQUIRED',
        patch,
        prepared: { input: { profileId: 'local-style', values: { rotation: 7 }, intent: '', lockedControls: [] } },
      },
    });
    render(<VelornWorkflowEqualizer />);
    fireEvent.click(screen.getByText('guid.velorn.title'));
    await screen.findByText('GRANT_REQUIRED');
    expect(screen.getByRole('spinbutton', { name: 'Rotation' })).toHaveValue('7');
    expect(screen.getByRole('button', { name: 'guid.velorn.authorize' })).toBeDisabled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('invalidates authorization when controls change after preview', async () => {
    render(<VelornWorkflowEqualizer />);
    fireEvent.click(screen.getByText('guid.velorn.title'));
    await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'guid.velorn.preview' }));
    await screen.findByText('GRANT_REQUIRED');

    const intent = screen.getByPlaceholderText('guid.velorn.intentExample');
    fireEvent.change(intent, { target: { value: 'timeline marker 2' } });

    expect(screen.getByRole('button', { name: 'guid.velorn.authorize' })).toBeDisabled();
  });

  it('shows the authority receipt and specialist artifact after execution', async () => {
    render(<VelornWorkflowEqualizer />);
    fireEvent.click(screen.getByText('guid.velorn.title'));
    await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'guid.velorn.preview' }));
    await screen.findByText('GRANT_REQUIRED');
    fireEvent.click(screen.getByRole('button', { name: 'guid.velorn.authorize' }));

    await screen.findByText('AUTHORIZED');
    expect(screen.getByText(/pdl-test/)).toBeInTheDocument();
    expect(screen.queryByText('velorn://project/current')).not.toBeInTheDocument();
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: 'local-style', values: { rotation: 0 }, runId: 'run-ui' })
    );
  });
});
