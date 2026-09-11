/** @license SPDX-License-Identifier: Apache-2.0 */
import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { ContinuityService, verifyPack, readAcknowledgements } from '@/process/services/continuity/service';
import type { JsonObject } from '@/process/services/continuity/client';
const schema = 'monstruo-aionui-continuity/v1';
const sha = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
const sorted = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(sorted)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, x]) => [k, sorted(x)])
        )
      : v;
const pointer = {
  continuity_id: 'aionui-test',
  team_id: 'team1',
  native_task_id: 'team1',
  native_task_kind: 'team' as const,
  origin_conversation_id: 'c1',
};
const binding = {
  slot_id: 'slot1',
  conversation_id: 'c1',
  engine_id: 'codex',
  provider: 'codex',
  provider_session_id: null,
};
function makePack(change: JsonObject = {}) {
  const content = 'Adopt complete products when evidence shows superiority; existing code gets no preference.';
  const payload = {
    continuity_id: pointer.continuity_id,
    identity: pointer,
    binding,
    bindings: [binding],
    objective: 'Useful software',
    repo_sha: '1234567890',
    current_instruction: { instruction_id: 'new', text: 'Use complete products', supersedes: ['old'] },
    superseded_instructions: [{ instruction_id: 'old', text: 'Keep existing code' }],
    results: [],
    resumes: [],
    delegations: [],
    context_refs: [{ ref: 'causal:1', content, sha256: sha(content), required: true, kind: 'memory' }],
    omissions: ['provider_session_id_missing:slot1'],
    integrity: 'VERIFIED',
    tower: { event_count: 1 },
    ...change,
  };
  return {
    schema,
    ...payload,
    pack_digest: sha(JSON.stringify(sorted(payload))),
    context_envelope: {
      envelope_id: 'env1',
      envelope_sha256: sha(JSON.stringify(sorted({ envelope_id: 'env1', memory_refs: ['causal:1'] }))),
      memory_refs: ['causal:1'],
    },
  };
}
function fixture(options: { bound?: boolean; pack?: JsonObject; messages?: JsonObject[] } = {}) {
  const c: JsonObject = {
    id: 'c1',
    name: 'Software',
    runtime: { is_processing: false },
    extra: {
      backend: 'codex',
      provider_id: 'codex',
      slot_id: 'slot1',
      teamId: 'team1',
      ...(options.bound === false ? {} : { monstruo_continuity: pointer }),
    },
  };
  const core = vi.fn(async (method: string, path: string, body?: unknown): Promise<JsonObject> => {
    if (method === 'PATCH') {
      const patch = body as { extra?: JsonObject; merge_extra?: boolean };
      if (patch.extra)
        c.extra = patch.merge_extra === true ? { ...(c.extra as JsonObject), ...patch.extra } : patch.extra;
      return c;
    }
    if (path.includes('/messages?')) return { items: options.messages ?? [], has_more_before: false };
    if (path === '/api/conversations?limit=200') return { items: [c], has_more: false };
    if (path.startsWith('/api/teams/'))
      return { assistants: [{ role: 'lead', conversation_id: 'c1', slot_id: 'slot1' }] };
    return c;
  });
  const pack = options.pack ?? makePack();
  const authority = vi.fn(
    async (_method: string, path: string, body?: unknown): Promise<JsonObject> =>
      path === '/tasks:bind'
        ? { continuity_id: 'aionui-test' }
        : path.endsWith(':prepare')
          ? { ...pack, preparation_id: (body as JsonObject).preparation_id }
          : path.includes(':recover')
            ? pack
            : { ok: true }
  );
  return { core, authority, c, service: new ContinuityService(core, authority) };
}
describe('Native task continuity boundary', () => {
  it('parses a real multiline acknowledgement without inventing fields', () => {
    expect(
      readAcknowledgements('CONTINUITY_ACK_JSON\n```json\n{\n"slot_id":"s1", "acknowledged_refs":["a"]\n}\n```')
    ).toEqual([{ slot_id: 's1', acknowledged_refs: ['a'] }]);
    expect(readAcknowledgements('CONTINUITY_ACK_JSON {broken}')).toEqual([]);
  });
  it('rejects a forged envelope even when the pack hash is intact', () => {
    const p = makePack();
    p.context_envelope.envelope_sha256 = sha('wrong');
    expect(() => verifyPack(p)).toThrow('ENVELOPE_DIGEST_MISMATCH');
  });
  it('leaves unbound native work untouched without contacting the authority', async () => {
    const f = fixture({ bound: false });
    const p = await f.service.prepare({ kind: 'conversation', conversation_id: 'c1', input: 'write code' });
    expect(p.content).toBe('write code');
    expect(f.authority).not.toHaveBeenCalled();
  });
  it('injects current and explicitly superseded causal content before a native send', async () => {
    const f = fixture();
    const p = await f.service.prepare({ kind: 'team', team_id: 'team1', input: 'continue' });
    expect(p.content).toContain('existing code gets no preference');
    expect(p.content).toContain('superseded_instructions');
    expect(p.preparation_id).toBeTruthy();
  });
  it('never manufactures an acknowledgement while preparing context', async () => {
    const f = fixture();
    await f.service.prepare({ kind: 'conversation', conversation_id: 'c1', input: 'continue' });
    expect(f.authority.mock.calls.some((c) => c[1].endsWith(':ack'))).toBe(false);
  });
  it('persists the pointer through native extra plus boolean merge flag', async () => {
    const f = fixture({ bound: false });
    await f.service.link({ conversation_id: 'c1', objective: 'Useful software' });
    const call = f.core.mock.calls.find((c) => c[0] === 'PATCH');
    expect(call?.[2]).toMatchObject({ extra: { monstruo_continuity: pointer }, merge_extra: true });
    expect((f.c.extra as JsonObject).backend).toBe('codex');
  });
  it('does not claim bound when native backend acknowledges but drops the pointer', async () => {
    const f = fixture({ bound: false });
    const original = f.core.getMockImplementation()!;
    f.core.mockImplementation((m, p, b) => (m === 'PATCH' ? Promise.resolve({}) : original(m, p, b)));
    await expect(f.service.link({ conversation_id: 'c1', objective: 'Useful software' })).rejects.toThrow(
      'POINTER_NOT_PERSISTED'
    );
  });
  it('rejects a correct hash bound to another conversation', async () => {
    const f = fixture({ pack: makePack({ binding: { ...binding, conversation_id: 'other' } }) });
    await expect(f.service.prepare({ kind: 'conversation', conversation_id: 'c1', input: 'continue' })).rejects.toThrow(
      'IDENTITY_MISMATCH'
    );
  });
  it.each(['team_id', 'native_task_id', 'native_task_kind'])(
    'rejects another native identity field: %s',
    async (field) => {
      const f = fixture({ pack: makePack({ identity: { ...pointer, [field]: 'other' } }) });
      await expect(
        f.service.prepare({ kind: 'conversation', conversation_id: 'c1', input: 'continue' })
      ).rejects.toThrow('IDENTITY_MISMATCH');
    }
  );
  it('rejects mismatched actual provider session rather than borrowing its context', async () => {
    const f = fixture({ pack: makePack({ binding: { ...binding, provider_session_id: 'someone-else' } }) });
    await expect(f.service.prepare({ kind: 'conversation', conversation_id: 'c1', input: 'continue' })).rejects.toThrow(
      'IDENTITY_MISMATCH'
    );
  });
  it('rejects a response for another immutable preparation', async () => {
    const f = fixture();
    const original = f.authority.getMockImplementation()!;
    f.authority.mockImplementation((method, path, body) =>
      path.endsWith(':prepare')
        ? Promise.resolve({ ...makePack(), preparation_id: 'unrelated-preparation' })
        : original(method, path, body)
    );
    await expect(f.service.prepare({ kind: 'conversation', conversation_id: 'c1', input: 'continue' })).rejects.toThrow(
      'PREPARATION_MISMATCH'
    );
  });
  it('rejects corrupted recovered state', () => {
    const p = makePack();
    p.objective = 'corrupt';
    expect(() => verifyPack(p)).toThrow('PACK_DIGEST_MISMATCH');
  });
  it('rejects content whose reference digest is wrong even when the outer hash matches', () => {
    const p = makePack({ context_refs: [{ content: 'wrong', sha256: sha('right') }] });
    expect(() => verifyPack(p)).toThrow('CONTENT_DIGEST_MISMATCH');
  });
  it('stops a bound send when the authority is down', async () => {
    const f = fixture();
    f.authority.mockRejectedValue(new Error('CONTINUITY_HTTP_503'));
    await expect(f.service.prepare({ kind: 'conversation', conversation_id: 'c1', input: 'write' })).rejects.toThrow(
      '503'
    );
  });
  it('rejects a malformed durable preparation before sending', async () => {
    const f = fixture();
    const a = f.authority.getMockImplementation()!;
    f.authority.mockImplementation(async (m, p, b) =>
      p.endsWith(':prepare') ? { pack_digest: 'changed', preparation_id: (b as JsonObject).preparation_id } : a(m, p, b)
    );
    await expect(f.service.prepare({ kind: 'conversation', conversation_id: 'c1', input: 'write' })).rejects.toThrow(
      'IDENTITY_MISMATCH'
    );
  });
  it('records an actual native acknowledgement without submitting work again', async () => {
    const f = fixture();
    await f.service.accepted(
      { conversation_id: 'c1', content: 'x', pointer, preparation_id: 'p1' },
      { message_id: 'native-message-1' }
    );
    const calls = f.authority.mock.calls as unknown[][];
    expect(calls.at(-1)?.[1]).toBe('/tasks/aionui-test/events');
    expect(f.core.mock.calls.every((c) => c[0] === 'GET')).toBe(true);
  });
  it('reconstructs a binding after a new service instance without redispatch', async () => {
    const f = fixture();
    const fresh = new ContinuityService(f.core, f.authority);
    const state = await fresh.status('c1');
    expect(state.pointer?.continuity_id).toBe('aionui-test');
    expect(f.core.mock.calls.every((c) => c[0] === 'GET')).toBe(true);
  });
  it('persists the binding only in native conversation.extra and lets the server load canon', async () => {
    const f = fixture({ bound: false });
    await f.service.link({ conversation_id: 'c1', objective: 'Validate software' });
    expect(f.core.mock.calls.some((c) => c[0] === 'PATCH')).toBe(true);
    expect(f.authority.mock.calls[0][1]).toBe('/tasks:bind');
  });
  it('supersedes the actual current instruction, not an imagined historical version', async () => {
    const f = fixture();
    await f.service.instruct('c1', 'New direction');
    const call = (f.authority.mock.calls as unknown[][]).find((c) => c[1] === '/tasks/aionui-test/events');
    expect((call![2] as { instruction: { supersedes: string[] } }).instruction.supersedes).toEqual(['new']);
  });
  it('does not convert prose success into verified task completion', async () => {
    const f = fixture({
      messages: [
        {
          id: 'm1',
          type: 'text',
          position: 'left',
          status: 'finish',
          backend_turn_id: 'turn1',
          content: { content: 'All done' },
        },
      ],
    });
    await f.service.collect('c1');
    const call = (f.authority.mock.calls as unknown[][]).find((c) => c[1] === '/tasks/aionui-test/events');
    expect((call![2] as { result: { status: string } }).result.status).toBe('partial');
  });
  it('skips already deposited results after restart', async () => {
    const f = fixture({
      pack: makePack({ results: [{ result: { result_id: 'c1:m1' } }] }),
      messages: [
        {
          id: 'm1',
          type: 'text',
          position: 'left',
          status: 'finish',
          backend_turn_id: 't1',
          content: { content: 'done' },
        },
      ],
    });
    await f.service.collect('c1');
    expect(f.authority.mock.calls.every((c) => c[0] === 'GET')).toBe(true);
  });
  it('does not treat tool output as an agent acknowledgement', async () => {
    const f = fixture({
      messages: [
        {
          id: 'm1',
          type: 'tool_call',
          position: 'left',
          status: 'finish',
          backend_turn_id: 't1',
          content: { content: 'CONTINUITY_ACK_JSON {}' },
        },
      ],
    });
    await f.service.collect('c1');
    expect(f.authority.mock.calls.every((c) => c[0] === 'GET')).toBe(true);
  });
});
