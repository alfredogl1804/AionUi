/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */
import type {
  VelornCalibrationInput,
  VelornCalibrationProfileSummary,
  VelornControl,
  VelornWorkflowSummary,
} from '@/common/types/velornGovernance';

export const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
export const rows = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(record) : []);

// These two local recipes compose published MCP operations. They are explicitly
// technical (not claimed to be learned/champion semantic mappings).
const technical = (kind: 'marker' | 'style', controls: VelornControl[]): VelornCalibrationProfileSummary => {
  const id = `local-${kind}`;
  const wireId = (id: string) => id.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  return {
    profileId: id,
    label: kind === 'marker' ? 'Marcador reversible' : 'Encuadre de un clip',
    workflowId: id,
    workflowVersion: 'mcp-live-v1',
    kind,
    controls,
    presetLabel: 'Controles técnicos · sin calibración semántica',
    locks: [],
    evidence: 'Esquema MCP vivo; límites operativos locales visibles, no una promesa de calidad generativa.',
    previewOnly: false,
    bridgeProfile: {
      schema: 'monstruo-calibration-profile/v1',
      profile_id: id,
      version: '1',
      specialist_id: 'velorn',
      workflow_id: id,
      workflow_version: 'mcp-live-v1',
      preset: Object.fromEntries(controls.map((c) => [wireId(c.controlId), c.value])),
      controls: controls.map((c) => ({
        control_id: wireId(c.controlId),
        label: c.label,
        axis: wireId(c.controlId),
        target_path: c.target,
        semantic_min: c.min - c.value,
        semantic_max: c.max - c.value,
        technical_min: c.min,
        technical_max: c.max,
        default_value: c.value,
        step: c.step,
        unit: c.unit,
        confidence: 1,
        evidence_refs: [] as string[],
      })),
      locks: [],
      uncertainty: { mapping: 'direct-technical', quality: 'not-calibrated' },
      provenance: [],
    },
  };
};
export function catalog(value: Record<string, unknown>, tools: Record<string, unknown>[]) {
  const profiles: VelornCalibrationProfileSummary[] = [];
  const names = new Set(tools.map((t) => t.name));
  if (names.has('add_timeline_markers'))
    profiles.push(
      technical('marker', [
        {
          controlId: 'timeSeconds',
          label: 'Tiempo del marcador',
          min: 0,
          max: 60,
          step: 0.1,
          unit: 's',
          value: 0,
          target: 'timeline.marker.time_seconds',
          aliases: ['marcador', 'marker', 'timeline marker'],
        },
      ])
    );
  const props = record(record(tools.find((t) => t.name === 'set_clip_style')?.inputSchema).properties);
  if (props.rotation && props.opacity)
    profiles.push(
      technical('style', [
        {
          controlId: 'rotation',
          label: 'Rotación',
          min: -180,
          max: 180,
          step: 0.1,
          unit: '°',
          value: 0,
          target: 'clip.rotation',
          aliases: ['rotacion', 'rotation'],
        },
        {
          controlId: 'opacity',
          label: 'Opacidad',
          min: 0,
          max: 100,
          step: 1,
          unit: '%',
          value: 100,
          target: 'clip.opacity',
          aliases: ['opacidad', 'opacity'],
        },
      ])
    );
  for (const item of rows(value.calibrationProfiles)) {
    const native = record(item.profile);
    const descriptor = record(item.descriptor);
    const bridge = record(item.bridgeProfile);
    if (!native.id || !bridge.profile_id || !Array.isArray(native.controls)) continue;
    const controls = rows(native.controls)
      .map((c) => ({
        controlId: String(c.id),
        label: String(c.label),
        min: Number(c.min),
        max: Number(c.max),
        step: Number(c.step ?? 1),
        value: Number(c.value),
        unit: String(c.unit ?? ''),
        target: String(c.mapsTo ?? ''),
        aliases: [String(c.id), String(c.label)],
      }))
      .filter((c) => [c.min, c.max, c.step, c.value].every(Number.isFinite) && c.min < c.max && c.step > 0);
    if (controls.length !== native.controls.length || !controls.length) continue;
    profiles.push({
      profileId: String(native.id),
      label: String(descriptor.title ?? native.id),
      workflowId: String(native.templateName),
      workflowVersion: String(bridge.workflow_version ?? ''),
      kind: 'native',
      controls,
      presetLabel: String(record(native.preset).label ?? ''),
      locks: Object.entries(record(native.locks)).map(([k, v]) => `${k}: ${JSON.stringify(v)}`),
      evidence: String(record(native.preset).evidence ?? descriptor.evidenceLevel ?? 'UNVERIFIED'),
      previewOnly: true,
      bridgeProfile: bridge,
    });
  }
  const workflows: VelornWorkflowSummary[] = rows(value.workflows).map((w) => ({
    workflowId: String(w.id ?? w.workflowId),
    label: String(w.label ?? w.id),
    availability: 'catalogued',
    profileIds: profiles.filter((p) => p.workflowId === (w.id ?? w.workflowId)).map((p) => p.profileId),
  }));
  for (const p of profiles)
    if (!workflows.some((w) => w.workflowId === p.workflowId))
      workflows.push({
        workflowId: p.workflowId,
        label: p.label,
        availability: 'catalogued',
        profileIds: [p.profileId],
      });
  return { profiles, workflows };
}
export function resolveControls(profile: VelornCalibrationProfileSummary, input: VelornCalibrationInput) {
  const values = Object.fromEntries(profile.controls.map((c) => [c.controlId, input.values[c.controlId] ?? c.value]));
  const normalized = (s: string) =>
    s
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  const intent = normalized(input.intent?.trim() ?? '');
  let matched = 0;
  if (intent) {
    for (const c of profile.controls) {
      const aliases = [c.controlId, c.label, ...(c.aliases ?? [])].map(normalized).sort((a, b) => b.length - a.length);
      for (const alias of aliases) {
        const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const hit = intent.match(
          new RegExp(`${escaped}(?:\\s+(?:a|en|el|segundo|by|to))*\\s*[:=]?\\s*(-?\\d+(?:[.,]\\d+)?)`)
        );
        if (!hit) continue;
        if (input.lockedControls?.includes(c.controlId)) throw new Error('VELORN_CONTROL_LOCKED');
        values[c.controlId] = Number(hit[1].replace(',', '.'));
        matched++;
        break;
      }
    }
    if (!matched) throw new Error('VELORN_INTENT_UNRECOGNIZED');
  }
  for (const c of profile.controls) {
    const v = values[c.controlId];
    if (!Number.isFinite(v) || v < c.min || v > c.max) throw new Error('VELORN_CALIBRATION_RANGE');
  }
  return values;
}
