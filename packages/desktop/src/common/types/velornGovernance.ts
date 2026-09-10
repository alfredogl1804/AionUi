/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */
export type VelornControl = {
  controlId: string;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  value: number;
  target: string;
  aliases?: string[];
};
export type VelornCalibrationProfileSummary = {
  profileId: string;
  label: string;
  workflowId: string;
  workflowVersion: string;
  kind: 'native' | 'style' | 'marker';
  controls: VelornControl[];
  presetLabel: string;
  locks: string[];
  evidence: string;
  previewOnly: boolean;
  bridgeProfile: Record<string, unknown>;
};
export type VelornWorkflowSummary = {
  workflowId: string;
  label: string;
  version?: string;
  availability: 'catalogued' | 'unknown';
  profileIds: string[];
};
export type VelornContext = {
  revision: string;
  projectPath: string;
  projectName: string;
  timelineId: string;
  digest: string;
  markerCount: number;
};
export type VelornGovernanceStatus = {
  available: boolean;
  gateway: { url: string; status: string; toolCount: number; workflowCount: number; upstream: string };
  authority: { url: string; status: string; policy: string };
  profiles: VelornCalibrationProfileSummary[];
  workflows: VelornWorkflowSummary[];
  clips: Array<{ id: string; name: string; transform: Record<string, number> }>;
  assets: Array<{ id: string; name: string; path: string; source: string; createdAt: string }>;
  context?: VelornContext;
  readProof?: {
    toolCount: number;
    project: boolean;
    timeline: boolean;
    assets: boolean;
    workflows: boolean;
    observedAt: string;
  };
  restored?: VelornOperationState;
  error?: string;
};
export type VelornCalibrationInput = {
  profileId: string;
  values: Record<string, number>;
  lockedControls?: string[];
  intent?: string;
  clipId?: string;
  runId?: string;
};
export type VelornCalibrationPreview = {
  runId: string;
  status: 'GRANT_REQUIRED' | 'PREVIEW_ONLY';
  source: 'intent' | 'controls';
  profile: Record<string, unknown>;
  patch: Record<string, unknown>;
  preview: Record<string, unknown>;
  context: VelornContext;
  input: VelornCalibrationInput;
  tool: string;
  arguments: Record<string, unknown>;
  inputDigest: string;
};
export type VelornGrantReceipt = {
  request_id: string;
  effect_id: string;
  decision_id: string;
  ledger_entry_id: string;
  closure_id: string;
  outcome: 'ALLOW';
  status: 'SUCCEEDED';
  replayed: boolean;
  grant_ref: string;
  receipt: Record<string, unknown>;
  result: Record<string, unknown>;
};
export type VelornOperationState = {
  runId: string;
  phase: 'GRANT_REQUIRED' | 'PREVIEW_ONLY' | 'EXECUTING' | 'AUTHORIZED' | 'REVERTED' | 'FAILED' | 'PARTIAL';
  patch: Record<string, unknown>;
  prepared?: VelornCalibrationPreview;
  checkpointReceipt?: VelornGrantReceipt;
  executionReceipt?: VelornGrantReceipt;
  reversalReceipt?: VelornGrantReceipt;
  after?: VelornContext;
  observedAt: string;
  error?: string;
};
