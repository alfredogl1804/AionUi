/** @license SPDX-License-Identifier: Apache-2.0 */
export type ContinuitySend = {
  kind: 'conversation' | 'team' | 'agent' | 'interrupt';
  conversation_id?: string;
  team_id?: string;
  slot_id?: string;
  input: string;
};
export type ContinuityPointer = {
  continuity_id: string;
  team_id: string;
  native_task_id: string;
  native_task_kind: 'team' | 'task';
  origin_conversation_id: string;
};
export type ContinuityStatus = {
  configured: boolean;
  pointer?: ContinuityPointer;
  pack?: Record<string, unknown>;
  error?: string;
};
export type ContinuityPreparation = {
  content: string;
  conversation_id: string;
  pointer?: ContinuityPointer;
  envelope?: Record<string, unknown>;
  preparation_id?: string;
};
export type ContinuityReply<T> = { ok: true; data: T } | { ok: false; error: string };
export type ContinuityLink = {
  conversation_id: string;
  source_conversation_id?: string;
  objective?: string;
};
