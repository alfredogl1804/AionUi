/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ContinuityService, safeError } from '@process/services/continuity/service';
import { authorityClient } from '@process/services/continuity/client';
import { httpRequest } from '@/common/adapter/httpBridge';
import type { ContinuityReply } from '@/common/types/team/continuity';
import { app } from 'electron';
import { join } from 'node:path';
import { ipcBridge } from '@/common';
import { createVelornGovernanceService } from '@process/services/velorn/service';

export function initVelornGovernanceBridge(): void {
  const service = createVelornGovernanceService(join(app.getPath('userData'), 'velorn-governance.json'));
  ipcBridge.velornGovernance.getStatus.provider(() => service.status());
  ipcBridge.velornGovernance.preview.provider((input) => service.preview(input));
  ipcBridge.velornGovernance.execute.provider((input) => service.execute(input));
  ipcBridge.velornGovernance.revert.provider(() => service.revert());
}

/** Continuity is a context boundary, not an alternative task runtime. */
export function initContinuityBridge(): void {
  const service = new ContinuityService((method, path, body) => httpRequest(method, path, body), authorityClient());
  const safe = async <T>(run: () => Promise<T>): Promise<ContinuityReply<T>> => {
    try {
      return { ok: true, data: await run() };
    } catch (error) {
      return { ok: false, error: safeError(error) };
    }
  };
  ipcBridge.continuity.status.provider(({ conversation_id }) => safe(() => service.status(conversation_id)));
  ipcBridge.continuity.sources.provider(() => safe(() => service.sources()));
  ipcBridge.continuity.link.provider((input) => safe(() => service.link(input)));
  ipcBridge.continuity.instruct.provider(({ conversation_id, text }) =>
    safe(() => service.instruct(conversation_id, text))
  );
  ipcBridge.continuity.prepare.provider((input) => safe(() => service.prepare(input)));
  ipcBridge.continuity.accepted.provider(async ({ preparation, native }) => {
    const reply = await safe(() => service.accepted(preparation, native));
    if (reply.ok === false)
      ipcBridge.continuity.changed.emit({ conversation_id: preparation.conversation_id, error: reply.error });
    return reply;
  });
  ipcBridge.continuity.collect.provider(({ conversation_id }) => safe(() => service.collect(conversation_id)));
}
