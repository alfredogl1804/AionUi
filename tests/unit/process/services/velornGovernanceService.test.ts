/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import {
  VelornGovernanceService,
  unwrap,
  contextOf,
  parseEnvironmentFile,
} from '@/process/services/velornGovernanceService';
import { catalog, resolveControls } from '@/process/services/velorn/catalog';
import fixture from '../../../fixtures/velorn/native-catalog.json';
import provenance from '../../../fixtures/velorn/PROVENANCE.json';

const response = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
const tools = [
  { name: 'add_timeline_markers' },
  {
    name: 'set_clip_style',
    inputSchema: { properties: { rotation: { type: 'number' }, opacity: { type: 'number' } } },
  },
];
const input = { profileId: 'local-marker', values: { timeSeconds: 2 } };
describe('native calibration / guarded execution', () => {
  let home: string;
  let path: string;
  let service: VelornGovernanceService;
  let markers: number;
  let projectPath: string;
  let authority: boolean;
  let failStage: string;
  let calls: string[];
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'velorn-'));
    path = join(home, 'state.json');
    await mkdir(join(home, '.config/monstruo'), { recursive: true });
    await writeFile(join(home, '.config/monstruo/velorn-gateway.env'), 'VELORN_GATEWAY_AUTH_TOKEN=\n');
    await writeFile(join(home, '.config/monstruo/velorn-grant-service.env'), 'MONSTRUO_AIONUI_CALLER_TOKEN=test\n');
    markers = 0;
    projectPath = '/isolated/project';
    authority = true;
    failStage = '';
    calls = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const endpoint = String(url);
      if (endpoint === 'http://127.0.0.1:4453/health')
        return response({ status: authority ? 'ok' : 'unavailable', policy: 'cedar' });
      if (endpoint.endsWith('/health'))
        return response({ status: 'healthy', tool_count: 130, workflow_count: 42, upstream: '19790' });
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (endpoint.endsWith('/calibration/normalize'))
        return response({
          profile: body.profile,
          patch: { ...body.patch, profile_digest: 'sha256:test' },
          authorized: false,
        });
      if (endpoint.endsWith('/execute')) {
        const stage = String(body.request_id).split(':').at(-1)!;
        calls.push(stage);
        if (stage === failStage) return response({ error: 'denied' }, 403);
        if (stage === 'apply') markers++;
        if (stage === 'undo') markers--;
        return response({
          request_id: body.request_id,
          status: 'SUCCEEDED',
          outcome: 'ALLOW',
          ledger_entry_id: 'pdl-' + stage,
          result: { result: { structuredContent: { success: true } } },
          receipt: {},
          effect_id: 'effect-' + stage,
        });
      }
      if (body.method === 'tools/list') return response({ result: { tools } });
      const tool = body.params.name;
      const args = body.params.arguments;
      let data: unknown = { success: true, previewOnly: true };
      if (tool === 'get_project') data = { project: { path: projectPath, name: 'Isolated' } };
      if (tool === 'get_timeline')
        data = {
          id: 'timeline-one',
          modified: 'revision-' + markers,
          markerCount: markers,
          clips: [],
          tracks: [],
          clipLimitApplied: false,
        };
      if (tool === 'get_assets') data = { assets: [] };
      if (tool === 'list_velorn_workflows') data = { ...fixture, count: 42 };
      if (tool === 'queue_timeline_template_generation')
        data = {
          calibrationPatch: {
            schema: 'velorn.calibration-patch/v1',
            operations: [
              {
                target: { classType: 'WanAnimate2ToVideo' },
                inputs: { reference_image_strength: 1.234, pose_strength: 1.111, pose_end_percent: 0.987 },
              },
            ],
          },
        };
      expect(args?.previewOnly !== false).toBe(true); // never effects through public MCP
      return response({ result: { structuredContent: data } });
    });
    service = new VelornGovernanceService({ homeDirectory: home, statePath: path, fetch: fetcher as typeof fetch });
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });
  it('keeps the native fixture sealed to an observed source', async () => {
    const raw = await readFile(join(import.meta.dirname, '../../../fixtures/velorn/native-catalog.json'));
    expect(createHash('sha256').update(raw).digest('hex')).toBe(provenance.sha256);
  });
  it('reads profiles even when write authority is unavailable', async () => {
    authority = false;
    const s = await service.status();
    expect(s.available).toBe(true);
    expect(s.profiles.some((p) => p.kind === 'native')).toBe(true);
    expect(s.authority.status).toBe('unavailable');
    expect(s.workflows.some((w) => !w.profileIds.length)).toBe(true);
  });
  it('renders another compatible profile without adding a UI-specific mapping', () => {
    const second = structuredClone(fixture.calibrationProfiles[0]);
    second.profile.id = 'second-profile';
    second.profile.templateName = 'second-workflow';
    second.bridgeProfile.profile_id = 'second-profile';
    second.bridgeProfile.workflow_id = 'second-workflow';
    const parsed = catalog({ ...fixture, calibrationProfiles: [...fixture.calibrationProfiles, second] }, tools);
    expect(parsed.profiles.filter((p) => p.kind === 'native')).toHaveLength(2);
  });
  it('maps precise language and manual values identically, rejecting unrelated numbers and locks', () => {
    const p = catalog({}, tools).profiles.find((p) => p.kind === 'style')!;
    expect(resolveControls(p, { profileId: p.profileId, values: { rotation: 2, opacity: 95 } })).toEqual(
      resolveControls(p, { profileId: p.profileId, values: {}, intent: 'rotación 2; opacidad 95' })
    );
    expect(() =>
      resolveControls(p, { profileId: p.profileId, values: {}, intent: 'make a video of 3 minutes' })
    ).toThrow('VELORN_INTENT_UNRECOGNIZED');
    expect(() =>
      resolveControls(p, { profileId: p.profileId, values: {}, intent: 'rotation 2', lockedControls: ['rotation'] })
    ).toThrow('VELORN_CONTROL_LOCKED');
    expect(() => resolveControls(p, { profileId: p.profileId, values: { opacity: 101 } })).toThrow(
      'VELORN_CALIBRATION_RANGE'
    );
  });
  it('uses the specialist mapping rather than recalculating its nonlinear curve', async () => {
    const p = (await service.status()).profiles.find((p) => p.kind === 'native')!;
    const preview = await service.preview({ profileId: p.profileId, values: {} });
    expect(preview.status).toBe('PREVIEW_ONLY');
    expect(preview.patch.technical_changes).toMatchObject({ 'WanAnimate2ToVideo.reference_image_strength': 1.234 });
    await expect(service.execute({ ...preview.input, runId: preview.runId })).rejects.toThrow();
    expect(calls).toEqual([]);
  });
  it('requires an exact persisted preview, ignores duplicate execute, reverses and survives service restart', async () => {
    await expect(service.execute(input)).rejects.toThrow('VELORN_PREVIEW_MISMATCH');
    const p = await service.preview(input);
    await expect(service.execute({ ...input, values: { timeSeconds: 3 }, runId: p.runId })).rejects.toThrow(
      'VELORN_PREVIEW_MISMATCH'
    );
    const executed = await service.execute({ ...input, runId: p.runId });
    expect(executed.phase).toBe('AUTHORIZED');
    await service.execute({ ...input, runId: p.runId });
    expect(calls).toEqual(['checkpoint', 'apply']);
    expect((await service.revert()).phase).toBe('REVERTED');
    expect(markers).toBe(0);
    const recovered = new VelornGovernanceService({
      homeDirectory: home,
      statePath: path,
      fetch: vi.fn().mockRejectedValue(new Error('OFFLINE')),
    });
    expect((await recovered.status()).restored?.reversalReceipt?.ledger_entry_id).toBe('pdl-undo');
  });
  it('does not dispatch if the project changed after preview', async () => {
    const p = await service.preview(input);
    projectPath = '/another/project';
    await expect(service.execute({ ...input, runId: p.runId })).rejects.toThrow('VELORN_PREVIEW_STALE');
    expect(calls).toEqual([]);
  });
  it('retains checkpoint receipt when execution fails', async () => {
    const p = await service.preview(input);
    failStage = 'apply';
    const result = await service.execute({ ...input, runId: p.runId });
    expect(result.phase).toBe('PARTIAL');
    expect(result.checkpointReceipt?.ledger_entry_id).toBe('pdl-checkpoint');
    expect(result.executionReceipt).toBeUndefined();
  });
  it('retains effect receipts on undo denial and allows safe retry', async () => {
    const p = await service.preview(input);
    await service.execute({ ...input, runId: p.runId });
    failStage = 'undo';
    const failed = await service.revert();
    expect(failed.phase).toBe('PARTIAL');
    expect(failed.executionReceipt?.ledger_entry_id).toBe('pdl-apply');
    failStage = '';
    expect((await service.revert()).phase).toBe('REVERTED');
  });
  it('refuses undo over a later human edit', async () => {
    const p = await service.preview(input);
    await service.execute({ ...input, runId: p.runId });
    markers++;
    await expect(service.revert()).rejects.toThrow('VELORN_REVERSAL_STALE');
    expect(calls).toEqual(['checkpoint', 'apply']);
  });
  it('never repeats a confirmed undo while reconciling a stale read or mismatch', async () => {
    const p = await service.preview(input);
    await service.execute({ ...input, runId: p.runId });
    await service.revert();
    const saved = JSON.parse(await readFile(path, 'utf8'));
    saved.phase = 'PARTIAL';
    await writeFile(path, JSON.stringify(saved));
    markers = 7; // A later edit cannot be silently undone by reconciliation.
    const partial = await service.revert();
    expect(partial.phase).toBe('PARTIAL');
    expect(partial.restoredContext?.markerCount).toBe(7);
    expect(partial.reversalReceipt?.ledger_entry_id).toBe('pdl-undo');
    expect(calls).toEqual(['checkpoint', 'apply', 'undo']);
    markers = 0;
    expect((await service.revert()).phase).toBe('REVERTED');
    expect(calls).toEqual(['checkpoint', 'apply', 'undo']);
  });
  it('blocks concurrent mutations and recognizes nested MCP failure', async () => {
    const p = service.preview(input);
    await expect(service.preview(input)).rejects.toThrow('VELORN_OPERATION_BUSY');
    await p;
    expect(() => unwrap({ result: { isError: true } })).toThrow();
    const planOnly = {
      result: {
        structuredContent: { success: false, result: { previewOnly: true, plan: { action: 'duplicate_project' } } },
      },
    };
    expect(() => unwrap(planOnly)).toThrow();
    expect(unwrap(planOnly, true)).toMatchObject({ success: false });

    expect(() => unwrap({ result: { content: [{ type: 'text', text: '{"success":false}' }] } })).toThrow();
    expect(unwrap({ result: { content: [{ type: 'text', text: '{"success":true}' }] } })).toEqual({ success: true });
  });
  it('normalizes environment quotes and excludes only noncontent context fields', () => {
    expect(parseEnvironmentFile('A="one"\nB=\'two\'')).toEqual({ A: 'one', B: 'two' });
    expect(() => parseEnvironmentFile('bad')).toThrow();
    const p = { project: { path: '/x', name: 'x' } };
    expect(contextOf(p, { id: 't', modified: '1', playheadPosition: 0 }).digest).toBe(
      contextOf(p, { id: 't', modified: '2', playheadPosition: 10 }).digest
    );
  });
});
