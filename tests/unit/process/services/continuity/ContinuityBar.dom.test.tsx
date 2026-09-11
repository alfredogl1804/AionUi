/** @license SPDX-License-Identifier: Apache-2.0 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const status = vi.fn(),
  link = vi.fn(),
  sources = vi.fn(),
  collect = vi.fn(),
  instruct = vi.fn();
const subscribe = vi.fn(() => () => {});
vi.mock('@/common', () => ({
  ipcBridge: {
    continuity: {
      status: { invoke: (...a: unknown[]) => status(...a) },
      link: { invoke: (...a: unknown[]) => link(...a) },
      sources: { invoke: (...a: unknown[]) => sources(...a) },
      collect: { invoke: (...a: unknown[]) => collect(...a) },
      instruct: { invoke: (...a: unknown[]) => instruct(...a) },
      changed: { on: (...a: unknown[]) => subscribe(...a) },
    },
    conversation: { turnCompleted: { on: (...a: unknown[]) => subscribe(...a) } },
  },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import ContinuityBar from '@/renderer/pages/conversation/PlanBar/ContinuityBar';
describe('Native continuity controls', () => {
  beforeEach(() => {
    window.__backendPort = 13999;
    status.mockResolvedValue({ ok: true, data: { configured: false } });
    sources.mockResolvedValue({ ok: true, data: [] });
    collect.mockResolvedValue({ ok: true, data: undefined });
    link.mockReset();
    instruct.mockReset();
  });
  afterEach(() => {
    delete window.__backendPort;
    vi.clearAllMocks();
  });
  it('does not imply continuity just because a native conversation exists', async () => {
    render(<ContinuityBar conversation_id='c1' />);
    await screen.findByText('conversation.continuity.native');
    expect(screen.queryByText('conversation.continuity.bound')).not.toBeInTheDocument();
  });
  it('recovers persisted results on mount without sending a new native task', async () => {
    render(<ContinuityBar conversation_id='c1' />);
    await waitFor(() => expect(collect).toHaveBeenCalledWith({ conversation_id: 'c1' }));
    expect(link).not.toHaveBeenCalled();
  });
  it('binds an explicit objective without sending or spawning an agent', async () => {
    link.mockResolvedValue({ ok: true, data: { configured: true, pointer: { continuity_id: 'existing' } } });
    render(<ContinuityBar conversation_id='c1' />);
    fireEvent.click(screen.getByText('conversation.continuity.title'));
    fireEvent.change(screen.getByLabelText('conversation.continuity.direction'), {
      target: { value: 'Build receipt checker' },
    });
    fireEvent.click(screen.getByText('conversation.continuity.enable'));
    await waitFor(() =>
      expect(link).toHaveBeenCalledWith({
        conversation_id: 'c1',
        objective: 'Build receipt checker',
        source_conversation_id: undefined,
      })
    );
  });
  it('shows failed recovery as an actionable error, not a verified badge', async () => {
    status.mockResolvedValue({
      ok: true,
      data: { configured: false, pointer: { continuity_id: 'existing' }, error: 'CONTINUITY_HTTP_503' },
    });
    render(<ContinuityBar conversation_id='c1' />);
    fireEvent.click(screen.getByText('conversation.continuity.title'));
    expect(await screen.findByText('CONTINUITY_HTTP_503')).toBeInTheDocument();
  });
});
