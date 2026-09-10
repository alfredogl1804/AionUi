/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  VelornCalibrationInput,
  VelornCalibrationPreview,
  VelornContext,
  VelornGovernanceStatus,
  VelornGrantReceipt,
  VelornOperationState,
} from '@/common/types/velornGovernance';
import { catalog, record, resolveControls, rows } from './velorn/catalog';

const GATEWAY = 'http://127.0.0.1:4452';
const AUTHORITY = 'http://127.0.0.1:4453';
export const parseEnvironmentFile = (contents: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/).map((s) => s.trim())) {
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index <= 0) throw new Error('VELORN_GOVERNANCE_ENV_INVALID');
    const raw = line.slice(index + 1).trim();
    out[line.slice(0, index).trim()] =
      raw.length >= 2 && raw[0] === raw.at(-1) && ["'", '"'].includes(raw[0]) ? raw.slice(1, -1) : raw;
  }
  return out;
};
const sorted = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(sorted)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, val]) => [k, sorted(val)])
        )
      : v;
const digest = (v: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(sorted(v)))
    .digest('hex');
const code = (e: unknown): string =>
  e instanceof Error && /^[A-Z0-9_:.-]+$/.test(e.message) ? e.message : 'VELORN_GOVERNANCE_UNAVAILABLE';

export function unwrap(payload: unknown, expectedPreview = false): Record<string, unknown> {
  const envelope = record(payload);
  if (envelope.error) throw new Error('VELORN_MCP_ERROR');
  const result = record(envelope.result ?? envelope);
  if (result.isError === true) throw new Error('VELORN_MCP_TOOL_ERROR');
  let data = record(result.structuredContent);
  if (!Object.keys(data).length) {
    for (const item of rows(result.content)) {
      if (typeof item.text !== 'string') continue;
      try {
        data = record(JSON.parse(item.text));
      } catch {
        continue;
      }
      if (Object.keys(data).length) break;
    }
  }
  if (!Object.keys(data).length) data = result;
  // Some native tools report success:false for an unexecuted plan. Accept only
  // an explicitly requested preview with a structured plan, never for effects.
  const planOnly =
    expectedPreview &&
    record(data.result).previewOnly === true &&
    Object.keys(record(record(data.result).plan)).length > 0;
  if (data.error || (data.success === false && !planOnly)) throw new Error('VELORN_MCP_TOOL_ERROR');
  return data;
}
export function contextOf(project: Record<string, unknown>, timeline: Record<string, unknown>): VelornContext {
  const p = record(project.project);
  const stableTimeline = Object.fromEntries(
    Object.entries(timeline).filter(
      ([k]) => !['created', 'modified', 'playheadPosition', 'selectedClipIds', 'selectedClipCount'].includes(k)
    )
  );
  // Modification timestamps are not undoable content.
  const omitTimes = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(omitTimes)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .filter(([k]) => !['created', 'modified', 'updatedAt'].includes(k))
              .map(([k, x]) => [k, omitTimes(x)])
          )
        : v;
  if (!p.path || !timeline.id || timeline.clipLimitApplied) throw new Error('VELORN_CONTEXT_INCOMPLETE');
  const contentSnapshot = { path: p.path, timeline: omitTimes(stableTimeline) };
  return {
    projectPath: String(p.path),
    projectName: String(p.name),
    timelineId: String(timeline.id),
    revision: String(timeline.modified ?? ''),
    digest: digest(contentSnapshot),
    contentSnapshot,
    markerCount: Number(timeline.markerCount ?? 0),
  };
}
const inputKey = (v: VelornCalibrationInput) => digest({ ...v, runId: undefined });
const findPatch = (v: unknown): Record<string, unknown> | undefined => {
  const obj = record(v);
  if (obj.schema === 'velorn.calibration-patch/v1') return obj;
  for (const child of Object.values(obj)) {
    const found = Array.isArray(child) ? child.map(findPatch).find(Boolean) : findPatchObject(child);
    if (found) return found;
  }
  return undefined;
};
const findPatchObject = (v: unknown) => (v && typeof v === 'object' ? findPatch(v) : undefined);

export class VelornGovernanceService {
  private readonly fetcher: typeof fetch;
  private readonly home: string;
  private readonly statePath: string;
  private busy = false;
  constructor(options: { fetch?: typeof fetch; homeDirectory?: string; statePath?: string } = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.home = options.homeDirectory ?? homedir();
    this.statePath = options.statePath ?? join(this.home, 'Library/Application Support/AionUi/velorn-governance.json');
  }
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('VELORN_OPERATION_BUSY');
    this.busy = true;
    try {
      return await operation();
    } finally {
      this.busy = false;
    }
  }
  private async token(kind: 'gateway' | 'caller') {
    const file = join(
      this.home,
      '.config/monstruo',
      kind === 'gateway' ? 'velorn-gateway.env' : 'velorn-grant-service.env'
    );
    const key = kind === 'gateway' ? 'VELORN_GATEWAY_AUTH_TOKEN' : 'MONSTRUO_AIONUI_CALLER_TOKEN';
    const env = parseEnvironmentFile(await readFile(file, 'utf8'));
    if (!(key in env) || (kind === 'caller' && !env[key])) throw new Error('VELORN_CONFIG_MISSING');
    return env[key];
  }
  private async http(url: string, body?: unknown, token?: string) {
    const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await this.fetcher(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(body === undefined ? 15000 : 125000),
    });
    if (!response.ok) {
      // Preserve a machine code, never echo response bodies or credentials.
      const prefix = url.startsWith(AUTHORITY) ? 'VELORN_GRANT_HTTP' : 'VELORN_GATEWAY_HTTP';
      throw new Error(`${prefix}_${response.status}`);
    }
    return record(await response.json());
  }
  private async mcp(name: string, args: Record<string, unknown> = {}, method = 'tools/call') {
    return unwrap(
      await this.http(
        `${GATEWAY}/mcp`,
        { jsonrpc: '2.0', id: randomUUID(), method, params: method === 'tools/list' ? {} : { name, arguments: args } },
        await this.token('gateway')
      ),
      args.previewOnly === true
    );
  }
  private async context() {
    const [p, t] = await Promise.all([
      this.mcp('get_project'),
      this.mcp('get_timeline', { includeClips: true, includeTransitions: true, limit: 10000 }),
    ]);
    return contextOf(p, t);
  }
  async status(): Promise<VelornGovernanceStatus> {
    const base: VelornGovernanceStatus = {
      available: false,
      gateway: { url: `${GATEWAY}/mcp`, status: 'unavailable', toolCount: 0, workflowCount: 0, upstream: '' },
      authority: { url: AUTHORITY, status: 'unavailable', policy: 'fail-closed' },
      profiles: [],
      workflows: [],
      clips: [],
      assets: [],
    };
    // Authority being offline must not hide read-only native product capability.
    const authorityPromise = this.http(`${AUTHORITY}/health`).catch(() => ({
      status: 'unavailable',
      policy: 'fail-closed',
    }));
    try {
      const [health, tools, project, timeline, assets, native, restored, authority] = await Promise.all([
        this.http(`${GATEWAY}/health`),
        this.mcp('', {}, 'tools/list'),
        this.mcp('get_project'),
        this.mcp('get_timeline', { includeClips: true, includeTransitions: true, limit: 10000 }),
        this.mcp('get_assets', { limit: 10000 }),
        this.mcp('list_velorn_workflows'),
        this.readState(),
        authorityPromise,
      ]);
      const discovered = catalog(native, rows(tools.tools));
      return {
        ...base,
        ...discovered,
        available: true,
        restored,
        context: contextOf(project, timeline),
        gateway: {
          ...base.gateway,
          status: String(health.status),
          toolCount: rows(tools.tools).length,
          workflowCount: Number(native.count),
          upstream: String(health.upstream),
        },
        authority: { ...base.authority, status: String(authority.status), policy: String(authority.policy) },
        clips: rows(timeline.clips)
          .filter((c) => c.type !== 'audio')
          .map((c) => ({
            id: String(c.id),
            name: String(c.name),
            transform: record(c.transform) as Record<string, number>,
          })),
        assets: rows(assets.assets).map((a) => ({
          id: String(a.id),
          name: String(a.name),
          path: String(a.absolutePath ?? a.path),
          source: String(a.sourceTool ?? a.generatedBy ?? ''),
          createdAt: String(a.createdAt ?? a.imported ?? ''),
        })),
        readProof: {
          toolCount: rows(tools.tools).length,
          project: true,
          timeline: true,
          assets: true,
          workflows: true,
          observedAt: new Date().toISOString(),
        },
      };
    } catch (e) {
      return {
        ...base,
        error: code(e),
        restored: await this.readState(),
        authority: { ...base.authority, ...(await authorityPromise) },
      };
    }
  }
  preview(input: VelornCalibrationInput): Promise<VelornCalibrationPreview> {
    return this.exclusive(async () => {
      const previous = await this.readState();
      if (previous && ['AUTHORIZED', 'EXECUTING', 'PARTIAL'].includes(previous.phase))
        throw new Error('VELORN_REVERT_OR_RECONCILE_FIRST');
      const status = await this.status();
      const profile = status.profiles.find((p) => p.profileId === input.profileId);
      if (!profile || !status.context) throw new Error('VELORN_PROFILE_UNAVAILABLE');
      const values = resolveControls(profile, input);
      const locked = new Set(input.lockedControls ?? []);
      const editableValues = Object.fromEntries(Object.entries(values).filter(([key]) => !locked.has(key)));
      const lockedTargets = profile.controls.filter((c) => locked.has(c.controlId)).map((c) => c.target);
      const runId = `aionui-${randomUUID()}`;
      let tool: string;
      let args: Record<string, unknown>;
      let changes: Record<string, unknown>;
      let preview: Record<string, unknown>;
      if (profile.kind === 'native') {
        tool = 'queue_timeline_template_generation';
        args = {
          templateName: profile.workflowId,
          calibrationProfileId: profile.profileId,
          calibrationControls: values,
          previewOnly: true,
        };
        preview = await this.mcp(tool, args);
        const patch = findPatch(preview);
        if (!patch) throw new Error('VELORN_NATIVE_MAPPING_UNAVAILABLE');
        const targets = new Set(profile.controls.map((c) => c.target));
        changes = {};
        for (const op of rows(patch.operations))
          for (const [key, value] of Object.entries(record(op.inputs))) {
            const target = `${String(record(op.target).classType)}.${key}`;
            if (targets.has(target)) changes[target] = value;
          }
      } else {
        tool = profile.kind === 'marker' ? 'add_timeline_markers' : 'set_clip_style';
        if (profile.kind === 'style' && !status.clips.some((c) => c.id === input.clipId))
          throw new Error('VELORN_CLIP_REQUIRED');
        args =
          profile.kind === 'marker'
            ? { markers: [{ timeSeconds: values.timeSeconds, label: runId }], limit: 1, previewOnly: true }
            : { clipId: input.clipId, ...editableValues, previewOnly: true };
        preview = await this.mcp(tool, args);
        changes = Object.fromEntries(profile.controls.map((c) => [c.target, values[c.controlId]]));
      }
      for (const target of lockedTargets) delete changes[target];
      if (!Object.keys(changes).length) throw new Error('VELORN_ALL_CONTROLS_LOCKED');
      const locks = [...new Set([...((profile.bridgeProfile.locks as string[]) ?? []), ...lockedTargets])];
      if ((await this.context()).digest !== status.context.digest) throw new Error('VELORN_PREVIEW_STALE');
      const normalized = await this.http(
        `${GATEWAY}/calibration/normalize`,
        {
          profile: { ...profile.bridgeProfile, locks },
          patch: {
            schema: 'monstruo-calibration-patch/v1',
            patch_id: `patch:aionui:${digest({ profile: profile.profileId, values, context: status.context }).slice(0, 24)}`,
            workflow_id: profile.workflowId,
            workflow_version: profile.workflowVersion,
            intent: JSON.stringify(values),
            semantic_deltas: {},
            technical_changes: changes,
            locks,
          },
        },
        await this.token('gateway')
      );
      const prepared: VelornCalibrationPreview = {
        runId,
        status: profile.previewOnly ? 'PREVIEW_ONLY' : 'GRANT_REQUIRED',
        source: input.intent ? 'intent' : 'controls',
        profile: record(normalized.profile),
        patch: record(normalized.patch),
        preview,
        context: status.context,
        input: { ...input, values },
        tool,
        arguments: { ...args, previewOnly: false },
        inputDigest: inputKey(input),
      };
      await this.writeState({
        runId,
        phase: prepared.status,
        patch: prepared.patch,
        prepared,
        observedAt: new Date().toISOString(),
      });
      return prepared;
    });
  }
  execute(input: VelornCalibrationInput): Promise<VelornOperationState> {
    return this.exclusive(async () => {
      const previous = await this.readState();
      if (previous?.phase === 'AUTHORIZED' && previous.runId === input.runId) return previous; // no new provider call
      const prepared = previous?.prepared;
      if (
        !previous ||
        previous.phase !== 'GRANT_REQUIRED' ||
        !prepared ||
        prepared.runId !== input.runId ||
        prepared.inputDigest !== inputKey(input)
      )
        throw new Error('VELORN_PREVIEW_MISMATCH');
      if ((await this.context()).digest !== prepared.context.digest) throw new Error('VELORN_PREVIEW_STALE');
      let state: VelornOperationState = { ...previous, phase: 'EXECUTING' };
      await this.writeState(state);
      try {
        const checkpointReceipt = await this.grant(
          prepared,
          'checkpoint',
          'create_project_checkpoint',
          { label: prepared.runId, previewOnly: false },
          'execute'
        );
        state = { ...state, checkpointReceipt };
        await this.writeState(state);
        if ((await this.context()).digest !== prepared.context.digest) throw new Error('VELORN_PREVIEW_STALE');
        const executionReceipt = await this.grant(prepared, 'apply', prepared.tool, prepared.arguments, 'execute');
        state = { ...state, executionReceipt };
        await this.writeState(state);
        const after = await this.context();
        if (after.projectPath !== prepared.context.projectPath || after.timelineId !== prepared.context.timelineId)
          throw new Error('VELORN_PROJECT_CHANGED');
        state = { ...state, after };
        await this.writeState(state);
        if (prepared.tool === 'add_timeline_markers' && after.markerCount !== prepared.context.markerCount + 1)
          throw new Error('VELORN_POSTCONDITION_FAILED');
        if (after.digest === prepared.context.digest) throw new Error('VELORN_NO_OBSERVED_CHANGE');
        if (prepared.tool === 'set_clip_style') {
          const timeline = await this.mcp('get_timeline', { includeClips: true, limit: 10000 });
          const clip = rows(timeline.clips).find((c) => c.id === prepared.arguments.clipId);
          const transform = record(clip?.transform);
          for (const key of ['rotation', 'opacity']) {
            if (key in prepared.arguments && transform[key] !== prepared.arguments[key])
              throw new Error('VELORN_STYLE_POSTCONDITION_FAILED');
          }
        }
        state = { ...state, phase: 'AUTHORIZED', after, error: undefined };
      } catch (e) {
        state = { ...state, phase: state.checkpointReceipt ? 'PARTIAL' : 'FAILED', error: code(e) };
      }
      await this.writeState(state);
      return state;
    });
  }
  revert(): Promise<VelornOperationState> {
    return this.exclusive(async () => {
      const previous = await this.readState();
      if (previous?.phase === 'REVERTED') return previous;
      if (
        !previous?.prepared ||
        !previous.after ||
        !previous.executionReceipt ||
        !['AUTHORIZED', 'PARTIAL'].includes(previous.phase)
      )
        throw new Error('VELORN_REVERSAL_NOT_AVAILABLE');
      // A confirmed undo must never be sent again, even if its projection was
      // delayed or a postcondition failed. Only reconcile the observed state.
      if (previous.reversalReceipt) {
        const restoredContext = await this.context();
        const restored = restoredContext.digest === previous.prepared.context.digest;
        const state: VelornOperationState = {
          ...previous,
          restoredContext,
          phase: restored ? 'REVERTED' : 'PARTIAL',
          error: restored ? undefined : 'VELORN_REVERSAL_POSTCONDITION_FAILED',
        };
        await this.writeState(state);
        return state;
      }
      if ((await this.context()).digest !== previous.after.digest) throw new Error('VELORN_REVERSAL_STALE');
      let state = previous;
      try {
        const reversalReceipt = await this.grant(
          previous.prepared,
          'undo',
          'undo',
          { scope: 'timeline', previewOnly: false },
          'revert',
          previous.after
        );
        state = { ...state, reversalReceipt };
        await this.writeState(state);
        const restored = await this.context();
        state = { ...state, restoredContext: restored };
        await this.writeState(state);
        if (restored.digest !== previous.prepared.context.digest)
          throw new Error('VELORN_REVERSAL_POSTCONDITION_FAILED');
        state = { ...state, phase: 'REVERTED', error: undefined };
      } catch (e) {
        state = { ...state, phase: 'PARTIAL', error: code(e) };
      }
      await this.writeState(state);
      return state;
    });
  }
  private async grant(
    p: VelornCalibrationPreview,
    stage: string,
    tool: string,
    args: Record<string, unknown>,
    operation: 'execute' | 'revert',
    expected: VelornContext = p.context
  ) {
    const current = await this.context();
    if (
      current.digest !== expected.digest ||
      current.projectPath !== p.context.projectPath ||
      current.timelineId !== p.context.timelineId ||
      !current.revision
    )
      throw new Error('VELORN_PROJECT_CHANGED');
    const result = await this.http(
      `${AUTHORITY}/v1/specialists/velorn/execute`,
      {
        schema: 'monstruo-specialist-grant-request/v1',
        request_id: `${p.runId}:${stage}`,
        operation,
        governed_operation: {
          schema: 'monstruo-governed-specialist-operation/v1',
          profile: p.profile,
          patch: p.patch,
          mcp_tool: tool,
          mcp_arguments: args,
          estimated_cost_usd: 0,
          data_path_ref: `velorn://project/${encodeURIComponent(p.context.projectPath)}`,
          expected_context: {
            project_path: current.projectPath,
            timeline_id: current.timelineId,
            timeline_modified: current.revision,
          },
        },
        budget_limit_usd: 0,
        deadline_seconds: 120,
        human_intervention: true,
      },
      await this.token('caller')
    );
    if (result.status !== 'SUCCEEDED' || result.outcome !== 'ALLOW' || !result.ledger_entry_id)
      throw new Error('VELORN_RECEIPT_INVALID');
    unwrap(result.result);
    return result as VelornGrantReceipt;
  }
  private async readState(): Promise<VelornOperationState | undefined> {
    try {
      return JSON.parse(await readFile(this.statePath, 'utf8')) as VelornOperationState;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
  }
  private async writeState(state: VelornOperationState) {
    state.observedAt = new Date().toISOString();
    await mkdir(dirname(this.statePath), { recursive: true });
    // Local projection of sovereign receipts, not another grant/effect ledger.
    await mkdir(`${this.statePath}.runs`, { recursive: true });
    const temporary = `${this.statePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(temporary, this.statePath);
    await writeFile(
      join(`${this.statePath}.runs`, `${state.runId.replace(/[^a-zA-Z0-9-]/g, '_')}.json`),
      JSON.stringify(state, null, 2),
      { mode: 0o600 }
    );
  }
}
export const createVelornGovernanceService = (statePath?: string) => new VelornGovernanceService({ statePath });
