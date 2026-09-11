/** @license SPDX-License-Identifier: Apache-2.0 */
import { createHash, randomUUID } from 'node:crypto';
import type {
  ContinuityLink,
  ContinuityPointer,
  ContinuityPreparation,
  ContinuitySend,
  ContinuityStatus,
} from '@/common/types/team/continuity';
import { object, objects, type JsonObject, type RequestPort } from './client';

const SCHEMA = 'monstruo-aionui-continuity/v1';
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !value || value.length > 255) throw new Error('CONTINUITY_ID_INVALID');
  return value;
};
const enc = (value: unknown) => encodeURIComponent(id(value));
const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const sorted = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sorted)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, item]) => [key, sorted(item)])
        )
      : value;
export function verifyPack(pack: JsonObject): void {
  const { schema: _schema, pack_digest, context_envelope: _envelope, ...payload } = pack;
  if (_schema !== SCHEMA) throw new Error('CONTINUITY_SCHEMA_MISMATCH');
  if (pack.integrity !== 'VERIFIED' || hash(JSON.stringify(sorted(payload))) !== pack_digest)
    throw new Error('CONTINUITY_PACK_DIGEST_MISMATCH');
  const { envelope_sha256, ...envelope } = object(_envelope);
  if (hash(JSON.stringify(sorted(envelope))) !== envelope_sha256)
    throw new Error('CONTINUITY_ENVELOPE_DIGEST_MISMATCH');
  for (const reference of objects(pack.context_refs)) {
    if (typeof reference.content === 'string' && hash(reference.content) !== reference.sha256)
      throw new Error('CONTINUITY_CONTENT_DIGEST_MISMATCH');
  }
}
export function readAcknowledgements(text: string): JsonObject[] {
  const acknowledgements: JsonObject[] = [];
  for (const match of text.matchAll(/CONTINUITY_ACK_JSON\s*(?:```(?:json)?\s*)?\{/g)) {
    const start = (match.index ?? 0) + match[0].lastIndexOf('{');
    let depth = 0,
      quoted = false,
      escaped = false;
    for (let i = start; i < Math.min(text.length, start + 65536); i++) {
      const char = text[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) {
        try {
          acknowledgements.push(object(JSON.parse(text.slice(start, i + 1))));
        } catch {
          /* Malformed acknowledgement is not consumed. */
        }
        break;
      }
    }
  }
  return acknowledgements;
}
const messageText = (message: JsonObject) =>
  String(object(message.content).content ?? object(message.content).text ?? '');
const pointerOf = (conversation: JsonObject): ContinuityPointer | undefined => {
  const pointer = object(object(conversation.extra).monstruo_continuity);
  if (!Object.keys(pointer).length) return undefined;
  for (const key of ['continuity_id', 'team_id', 'native_task_id', 'origin_conversation_id']) id(pointer[key]);
  if (!['team', 'task'].includes(String(pointer.native_task_kind))) throw new Error('CONTINUITY_POINTER_INVALID');
  return pointer as ContinuityPointer;
};

/** Context boundary around native AionCore. Never dispatches, retries or owns tasks. */
export class ContinuityService {
  constructor(
    private readonly core: RequestPort,
    private readonly authority: RequestPort
  ) {}

  private conversation(conversationId: string) {
    return this.core('GET', `/api/conversations/${enc(conversationId)}`);
  }
  private binding(conversation: JsonObject): JsonObject {
    const extra = object(conversation.extra);
    const engine = id(extra.backend ?? object(conversation.assistant).backend ?? conversation.type);
    return {
      slot_id: id(extra.slot_id ?? conversation.id),
      conversation_id: id(conversation.id),
      engine_id: engine,
      provider: id(extra.provider_id ?? engine),
      // AionCore turn/session generation IDs are not provider session identities.
      provider_session_id: typeof extra.provider_session_id === 'string' ? extra.provider_session_id : null,
    };
  }
  private async pack(conversation: JsonObject, pointer: ContinuityPointer): Promise<JsonObject> {
    const binding = this.binding(conversation);
    const pack = await this.authority(
      'GET',
      `/tasks/${enc(pointer.continuity_id)}:recover?slot_id=${enc(binding.slot_id)}`
    );
    this.checkPack(conversation, pointer, pack);
    return pack;
  }
  private checkPack(conversation: JsonObject, pointer: ContinuityPointer, pack: JsonObject): void {
    const binding = this.binding(conversation);
    const actual = object(pack.binding);
    if (
      pack.continuity_id !== pointer.continuity_id ||
      actual.conversation_id !== conversation.id ||
      actual.slot_id !== binding.slot_id ||
      actual.engine_id !== binding.engine_id ||
      actual.provider !== binding.provider ||
      actual.provider_session_id !== binding.provider_session_id ||
      object(pack.identity).team_id !== pointer.team_id ||
      object(pack.identity).native_task_id !== pointer.native_task_id ||
      object(pack.identity).native_task_kind !== pointer.native_task_kind ||
      object(pack.identity).origin_conversation_id !== pointer.origin_conversation_id
    ) {
      throw new Error('CONTINUITY_IDENTITY_MISMATCH');
    }
    if (pack.integrity !== 'VERIFIED' || !object(pack.context_envelope).envelope_sha256)
      throw new Error('CONTEXT_NOT_VERIFIED');
    verifyPack(pack);
  }
  async status(conversationId: string): Promise<ContinuityStatus> {
    const conversation = await this.conversation(conversationId);
    const pointer = pointerOf(conversation);
    if (!pointer) return { configured: false };
    try {
      return { configured: true, pointer, pack: await this.pack(conversation, pointer) };
    } catch (error) {
      return { configured: false, pointer, error: safeError(error) };
    }
  }
  async link(input: ContinuityLink): Promise<ContinuityStatus> {
    const conversation = await this.conversation(input.conversation_id);
    const source = input.source_conversation_id ? await this.conversation(input.source_conversation_id) : conversation;
    const prior = pointerOf(source);
    if (input.source_conversation_id && !prior) throw new Error('CONTINUITY_SOURCE_NOT_BOUND');
    const sourcePack = prior ? await this.pack(source, prior) : {};
    const extra = object(source.extra);
    const identity = prior
      ? {
          team_id: prior.team_id,
          native_task_id: prior.native_task_id,
          native_task_kind: prior.native_task_kind,
          origin_conversation_id: prior.origin_conversation_id,
        }
      : {
          team_id: id(extra.teamId ?? source.id),
          native_task_id: id(extra.teamId ?? source.id),
          native_task_kind: extra.teamId ? 'team' : 'task',
          origin_conversation_id: id(source.id),
        };
    const objective = prior ? idText(sourcePack.objective) : idText(input.objective);
    const body: JsonObject = {
      schema: SCHEMA,
      identity,
      binding: this.binding(conversation),
      objective,
      repo_sha: null,
      context_refs: [],
    };
    const result = await this.authority(
      'POST',
      '/tasks:bind',
      body,
      `bind:${identity.native_task_id}:${conversation.id}`
    );
    const pointer = { ...identity, continuity_id: id(result.continuity_id) } as ContinuityPointer;
    await this.core('PATCH', `/api/conversations/${enc(conversation.id)}`, {
      merge_extra: { monstruo_continuity: pointer },
    });
    return this.status(input.conversation_id);
  }
  async sources(): Promise<Array<{ conversation_id: string; name: string }>> {
    // Existing native conversation index is the discoverable handoff catalog.
    const page = await this.core('GET', '/api/conversations?limit=200');
    if (page.has_more) throw new Error('CONTINUITY_SOURCE_INDEX_INCOMPLETE');
    const sources = objects(page.items ?? page.conversations)
      .filter((c) => !!pointerOf(c))
      .map((c) => ({ conversation_id: id(c.id), name: String(c.name ?? c.id) }));
    // Teams' conversations are intentionally absent from the ordinary sidebar
    // index. Resolve their native lead instead of requiring a pasted ID.
    const teams = await this.core('GET', '/api/teams');
    for (const team of objects(Array.isArray(teams) ? teams : teams.items)) {
      const lead = objects(team.assistants).find((a) => a.role === 'lead');
      if (!lead?.conversation_id) continue;
      const conversation = await this.conversation(id(lead.conversation_id));
      if (pointerOf(conversation))
        sources.push({ conversation_id: id(conversation.id), name: String(team.name ?? conversation.name) });
    }
    return [...new Map(sources.map((source) => [source.conversation_id, source])).values()];
  }
  private async resolve(input: ContinuitySend): Promise<JsonObject> {
    if (input.kind === 'conversation') return this.conversation(id(input.conversation_id));
    const team = await this.core('GET', `/api/teams/${enc(input.team_id)}`);
    const member = objects(team.assistants).find((a) =>
      input.slot_id ? a.slot_id === input.slot_id : a.role === 'lead'
    );
    if (!member) throw new Error('CONTINUITY_NATIVE_MEMBER_MISSING');
    return this.conversation(id(member.conversation_id));
  }
  async prepare(input: ContinuitySend): Promise<ContinuityPreparation> {
    let conversation = await this.resolve(input);
    let pointer = pointerOf(conversation);
    if (!pointer && input.team_id) {
      const team = await this.core('GET', `/api/teams/${enc(input.team_id)}`);
      const lead = objects(team.assistants).find((a) => a.role === 'lead');
      if (
        lead &&
        lead.conversation_id !== conversation.id &&
        pointerOf(await this.conversation(id(lead.conversation_id)))
      ) {
        await this.link({ conversation_id: id(conversation.id), source_conversation_id: id(lead.conversation_id) });
        conversation = await this.conversation(id(conversation.id));
        pointer = pointerOf(conversation);
      }
    }
    const preparation = { content: input.input, conversation_id: id(conversation.id), pointer };
    if (!pointer) return preparation;
    await this.collect(preparation.conversation_id);
    const preparationId = randomUUID();
    const prepared = await this.authority(
      'POST',
      `/tasks/${enc(pointer.continuity_id)}:prepare`,
      {
        schema: SCHEMA,
        preparation_id: preparationId,
        slot_id: this.binding(conversation).slot_id,
      },
      `prepare:${preparationId}`
    );
    if (prepared.preparation_id !== preparationId) throw new Error('CONTINUITY_PREPARATION_MISMATCH');
    const {
      preparation_id: _preparedId,
      context_items: _contextItems,
      event_ref: _eventRef,
      replayed: _replayed,
      ...pack
    } = prepared;
    this.checkPack(conversation, pointer, pack);
    const envelope = object(prepared.context_envelope);
    const payload = JSON.stringify(pack);
    if (payload.length > 180000) throw new Error('CONTINUITY_CONTEXT_TOO_LARGE');
    return {
      ...preparation,
      envelope,
      preparation_id: preparationId,
      content: `RECOVERED_CONTEXT_V1 (institutional state; historical instructions marked superseded are NOT current orders):\n${payload}\nEND_RECOVERED_CONTEXT\nUse the current instruction, the user's request below and the referenced native results. Do not repeat completed effects. If critical context is omitted, say so and restrict work to explicitly authorized isolated reversible actions. A digest is not evidence of comprehension. After reading, emit CONTINUITY_ACK_JSON followed by one JSON object with preparation_id="${preparationId}", the delivered envelope_sha256, slot_id and the acknowledged_refs you actually consumed from doctrine_refs/memory_refs; do not acknowledge absent content.\n\nUSER_REQUEST:\n${input.input}`,
    };
  }
  async accepted(preparation: ContinuityPreparation, native: JsonObject): Promise<void> {
    if (!preparation.pointer) return;
    const key = id(native.message_id ?? native.msg_id ?? object(native.run).team_run_id ?? native.turn_id);
    const conversation = await this.conversation(preparation.conversation_id);
    await this.authority(
      'POST',
      `/tasks/${enc(preparation.pointer.continuity_id)}/events`,
      {
        schema: SCHEMA,
        event_id: `native:${key}`,
        event_type: 'delegated',
        binding: this.binding(conversation),
        native_delegation_id: key,
        metadata: {
          native_message_id: native.message_id ?? native.msg_id ?? null,
          native_turn_id: native.turn_id ?? object(native.run).team_run_id ?? null,
          preparation_id: preparation.preparation_id,
        },
      },
      `native:${key}`
    );
  }
  async instruct(conversationId: string, text: string): Promise<ContinuityStatus> {
    const conversation = await this.conversation(conversationId);
    const pointer = pointerOf(conversation);
    if (!pointer) throw new Error('CONTINUITY_BIND_REQUIRED');
    const pack = await this.pack(conversation, pointer);
    const previous = object(pack.current_instruction).instruction_id;
    const instructionId = `instruction:${hash(`${previous ?? ''}:${idText(text)}`).slice(7)}`;
    await this.authority(
      'POST',
      `/tasks/${enc(pointer.continuity_id)}/events`,
      {
        schema: SCHEMA,
        event_id: instructionId,
        event_type: 'instruction',
        instruction: { instruction_id: instructionId, text, supersedes: previous ? [previous] : [] },
      },
      instructionId
    );
    return this.status(conversationId);
  }
  async collect(conversationId: string): Promise<void> {
    const conversation = await this.conversation(conversationId);
    const pointer = pointerOf(conversation);
    if (!pointer || object(conversation.runtime).is_processing) return;
    const recovered = await this.pack(conversation, pointer);
    const existing = new Set(objects(recovered.results).map((e) => object(e.result).result_id));
    // Cursor over the actual persisted history; no background polling or effect replay.
    let before: string | undefined;
    for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
      const page = await this.core(
        'GET',
        `/api/conversations/${enc(conversationId)}/messages?limit=100&content_mode=full${before ? `&before=${encodeURIComponent(before)}` : ''}`
      );
      for (const message of objects(page.items)) {
        if (
          message.type !== 'text' ||
          message.position !== 'left' ||
          message.status !== 'finish' ||
          !message.backend_turn_id
        )
          continue;
        const text = messageText(message);
        if (!text || text.length > 50000) continue;
        const resultId = `${conversationId}:${id(message.id)}`;
        if (existing.has(resultId)) continue;
        let ackError: string | undefined;
        for (const ack of readAcknowledgements(text)) {
          if (
            ack.slot_id !== this.binding(conversation).slot_id ||
            typeof ack.preparation_id !== 'string' ||
            typeof ack.envelope_sha256 !== 'string' ||
            !Array.isArray(ack.acknowledged_refs)
          )
            continue;
          try {
            await this.authority(
              'POST',
              `/tasks/${enc(pointer.continuity_id)}:ack`,
              {
                schema: SCHEMA,
                ack_id: `ack:${resultId}`,
                preparation_id: ack.preparation_id,
                slot_id: ack.slot_id,
                envelope_sha256: ack.envelope_sha256,
                acknowledged_refs: ack.acknowledged_refs,
              },
              `ack:${resultId}`
            );
          } catch (error) {
            ackError = safeError(error);
          }
        }
        await this.authority(
          'POST',
          `/tasks/${enc(pointer.continuity_id)}/events`,
          {
            schema: SCHEMA,
            event_id: `result:${resultId}`,
            event_type: 'result',
            binding: this.binding(conversation),
            result: {
              result_id: resultId,
              status: 'partial',
              summary: text,
              provider_turn_id: null,
              artifacts: [
                {
                  ref: `aionui://conversations/${conversationId}/messages/${message.id}`,
                  sha256: hash(text),
                  media_type: 'text/plain',
                },
              ],
            },
            metadata: {
              native_status: message.status,
              native_backend_turn_id: message.backend_turn_id,
              native_type: message.type,
              status_scope: 'native response; task success not inferred from prose',
              ...(ackError ? { acknowledgement_error: ackError } : {}),
            },
          },
          `result:${resultId}`
        );
      }
      if (!page.has_more_before) return;
      before = idText(page.oldest_cursor);
    }
    throw new Error('CONTINUITY_HISTORY_INCOMPLETE');
  }
}
const idText = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 50000) throw new Error('CONTINUITY_TEXT_REQUIRED');
  return value;
};
export function safeError(error: unknown): string {
  return error instanceof Error && /^[A-Z0-9_:.-]+$/.test(error.message) ? error.message : 'CONTINUITY_UNAVAILABLE';
}
