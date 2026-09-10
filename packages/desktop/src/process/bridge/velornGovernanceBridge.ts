/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { app } from 'electron';
import { join } from 'node:path';
import { ipcBridge } from '@/common';
import { createVelornGovernanceService } from '@process/services/velornGovernanceService';

export function initVelornGovernanceBridge(): void {
  const service = createVelornGovernanceService(join(app.getPath('userData'), 'velorn-governance.json'));
  ipcBridge.velornGovernance.getStatus.provider(() => service.status());
  ipcBridge.velornGovernance.preview.provider((input) => service.preview(input));
  ipcBridge.velornGovernance.execute.provider((input) => service.execute(input));
  ipcBridge.velornGovernance.revert.provider(() => service.revert());
}
