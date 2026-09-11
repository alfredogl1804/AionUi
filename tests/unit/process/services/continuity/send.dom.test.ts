/** @license SPDX-License-Identifier: Apache-2.0 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcBridge } from '@/common';
const pointer = {
  continuity_id: 'continuity1',
  team_id: 't1',
  native_task_id: 't1',
  native_task_kind: 'team' as const,
  origin_conversation_id: 'c1',
};
describe('Real native HTTP send boundary', () => {
  beforeEach(() => {
    window.__backendPort = 13999;
    vi.spyOn(ipcBridge.continuity.prepare, 'invoke').mockResolvedValue({
      ok: true,
      data: { conversation_id: 'c1', content: 'RECOVERED + user', pointer },
    });
    vi.spyOn(ipcBridge.continuity.accepted, 'invoke').mockResolvedValue({ ok: true, data: undefined });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true, data: { message_id: 'native1', turn_id: 'turn1' } }), {
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
  });
  afterEach(() => {
    delete window.__backendPort;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it('delivers recovered content through the existing native message endpoint', async () => {
    await ipcBridge.conversation.sendMessage.invoke({ conversation_id: 'c1', input: 'user', files: [] });
    const [url, request] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('http://127.0.0.1:13999/api/conversations/c1/messages');
    expect(JSON.parse(String(request?.body))).toMatchObject({ content: 'RECOVERED + user', files: [] });
  });
  it('fails before any native send when recovery rejects the context', async () => {
    vi.mocked(ipcBridge.continuity.prepare.invoke).mockResolvedValue({ ok: false, error: 'CONTEXT_NOT_VERIFIED' });
    await expect(ipcBridge.conversation.sendMessage.invoke({ conversation_id: 'c1', input: 'user' })).rejects.toThrow(
      'CONTEXT_NOT_VERIFIED'
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it('reports a post-acceptance storage error without turning it into a resend', async () => {
    vi.mocked(ipcBridge.continuity.accepted.invoke).mockResolvedValue({ ok: false, error: 'CONTINUITY_HTTP_503' });
    const result = await ipcBridge.team.sendMessage.invoke({ team_id: 't1', input: 'user' });
    expect(result).toMatchObject({ message_id: 'native1' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not report a failed send when IPC disappears after native acceptance', async () => {
    vi.mocked(ipcBridge.continuity.accepted.invoke).mockRejectedValue(new Error('IPC disconnected'));
    const result = await ipcBridge.team.sendMessage.invoke({ team_id: 't1', input: 'user' });
    expect(result).toMatchObject({ message_id: 'native1' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('also gates targeted native teammate messages', async () => {
    await ipcBridge.team.sendMessageToAgent.invoke({ team_id: 't1', slot_id: 's1', input: 'review' });
    expect(ipcBridge.continuity.prepare.invoke).toHaveBeenCalledWith({
      kind: 'agent',
      team_id: 't1',
      slot_id: 's1',
      input: 'review',
    });
  });
  it('gates the native interrupt path rather than opening an unprotected alternate send', async () => {
    await ipcBridge.team.interruptAgent.invoke({ team_id: 't1', slot_id: 's1', input: 'change direction' });
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)).message).toBe('RECOVERED + user');
  });
});
