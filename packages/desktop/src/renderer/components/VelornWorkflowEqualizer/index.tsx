/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */
import { ipcBridge } from '@/common';
import type {
  VelornCalibrationInput,
  VelornCalibrationPreview,
  VelornGovernanceStatus,
  VelornOperationState,
} from '@/common/types/velornGovernance';
import AionCollapse from '@/renderer/components/base/AionCollapse';
import { Alert, Button, Checkbox, Input, InputNumber, Select, Slider, Tag } from '@arco-design/web-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './index.module.css';

type Settings = {
  profileId: string;
  values: Record<string, number>;
  lockedControls: string[];
  intent: string;
  clipId?: string;
};
const initial: Settings = { profileId: 'local-style', values: {}, lockedControls: [], intent: '' };
const VelornWorkflowEqualizer: React.FC = () => {
  const { t } = useTranslation();
  const [status, setStatus] = useState<VelornGovernanceStatus>();
  const [settings, setSettings] = useState(initial);
  const [past, setPast] = useState<Settings[]>([]);
  const [future, setFuture] = useState<Settings[]>([]);
  const [workflow, setWorkflow] = useState('local-style');
  const [objective, setObjective] = useState('');
  const [preview, setPreview] = useState<VelornCalibrationPreview>();
  const [previewKey, setPreviewKey] = useState('');
  const [operation, setOperation] = useState<VelornOperationState>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const profile = status?.profiles.find((p) => p.profileId === settings.profileId);
  const defaults = useMemo(
    () => Object.fromEntries(profile?.controls.map((c) => [c.controlId, c.value]) ?? []),
    [profile]
  );
  const input: VelornCalibrationInput = {
    ...settings,
    values: { ...defaults, ...settings.values },
    runId: preview?.runId,
  };
  const settingsKey = JSON.stringify({ ...input, runId: undefined });
  const update = (next: Partial<Settings>) => {
    setPast((p) => [...p.slice(-39), settings]);
    setFuture([]);
    setSettings((s) => ({ ...s, ...next }));
    setError(undefined);
  };
  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const next = await ipcBridge.velornGovernance.getStatus.invoke();
      setStatus(next);
      setOperation(next.restored);
      setError(next.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'VELORN_UNAVAILABLE');
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const act = async (kind: 'preview' | 'execute' | 'revert') => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      if (kind === 'preview') {
        const next = await ipcBridge.velornGovernance.preview.invoke({ ...input, runId: undefined });
        setPreview(next);
        setPreviewKey(settingsKey);
        setOperation({
          runId: next.runId,
          phase: next.status,
          patch: next.patch,
          prepared: next,
          observedAt: new Date().toISOString(),
        });
      } else {
        const next =
          kind === 'execute'
            ? await ipcBridge.velornGovernance.execute.invoke(input)
            : await ipcBridge.velornGovernance.revert.invoke();
        setOperation(next);
        setError(next.error);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'VELORN_OPERATION_FAILED');
    } finally {
      setBusy(false);
    }
  };
  const selectProfile = (id: string) => {
    const p = status?.profiles.find((p) => p.profileId === id);
    update({
      profileId: id,
      values: Object.fromEntries(p?.controls.map((c) => [c.controlId, c.value]) ?? []),
      intent: '',
      lockedControls: [],
    });
  };
  const selectWorkflow = (id: string) => {
    setWorkflow(id);
    const match = status?.profiles.find((p) => p.workflowId === id);
    selectProfile(match?.profileId ?? '');
  };
  const recommendations = useMemo(() => {
    const words = objective
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2);
    return (status?.profiles ?? [])
      .map((p) => ({
        p,
        score: words.filter((w) => `${p.label} ${p.evidence} ${p.workflowId}`.toLowerCase().includes(w)).length,
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
  }, [objective, status]);
  const receipt = operation?.reversalReceipt ?? operation?.executionReceipt;
  const ready = preview && previewKey === settingsKey && operation?.phase === 'GRANT_REQUIRED';
  const unresolved = operation && ['AUTHORIZED', 'PARTIAL', 'EXECUTING'].includes(operation.phase);
  return (
    <AionCollapse className={styles.shell} defaultActiveKey='velorn' bordered={false}>
      <AionCollapse.Item
        name='velorn'
        header={
          <div className={styles.header}>
            <div>
              <strong>{t('guid.velorn.title')}</strong>
              <span>{t('guid.velorn.subtitle')}</span>
            </div>
            <Tag color={status?.available ? 'green' : 'red'}>
              {status?.available ? t('guid.velorn.connected') : t('guid.velorn.disconnected')}
            </Tag>
          </div>
        }
      >
        <div className={styles.body} data-testid='velorn-workflow-equalizer'>
          <div className={styles.readProof}>
            <Tag>{status?.context?.projectName ?? '—'}</Tag>
            <Tag>{status?.gateway.toolCount ?? 0} MCP</Tag>
            <Tag>{status?.gateway.workflowCount ?? 0} workflows</Tag>
            <Button size='small' disabled={busy} onClick={() => void refresh()}>
              {t('guid.velorn.refresh')}
            </Button>
          </div>
          <Input value={objective} onChange={setObjective} placeholder={t('guid.velorn.objective')} />
          {recommendations.length > 0 ? (
            <div className={styles.readProof}>
              <span>{t('guid.velorn.catalogMatch')}</span>
              {recommendations.map(({ p }) => (
                <Button
                  key={p.profileId}
                  size='small'
                  onClick={() => {
                    setWorkflow(p.workflowId);
                    selectProfile(p.profileId);
                  }}
                >
                  {p.label}
                </Button>
              ))}
            </div>
          ) : null}
          <div className={styles.grid}>
            <label>
              <span>{t('guid.velorn.workflowCatalog')}</span>
              <Select
                showSearch
                disabled={busy || !!unresolved}
                value={workflow}
                onChange={selectWorkflow}
                options={(status?.workflows ?? []).map((w) => ({
                  value: w.workflowId,
                  label: `${w.label}${w.profileIds.length ? '' : ' · ' + t('guid.velorn.uncalibrated')}`,
                }))}
              />
            </label>
            <label>
              <span>{t('guid.velorn.profile')}</span>
              <Select
                value={profile?.profileId}
                disabled={busy || !!unresolved}
                onChange={selectProfile}
                options={(status?.profiles ?? [])
                  .filter((p) => p.workflowId === workflow)
                  .map((p) => ({ value: p.profileId, label: p.label }))}
              />
            </label>
          </div>
          {!profile ? (
            <Alert type='info' content={t('guid.velorn.noProfile')} />
          ) : (
            <>
              <div>
                <strong>{profile.presetLabel}</strong>
                <div className={styles.route}>{profile.evidence}</div>
              </div>
              {profile.kind === 'style' ? (
                <Select
                  placeholder={t('guid.velorn.clip')}
                  value={settings.clipId}
                  disabled={busy || !!unresolved}
                  onChange={(clipId) => {
                    const clip = status?.clips.find((c) => c.id === clipId);
                    update({
                      clipId,
                      values: { rotation: clip?.transform.rotation ?? 0, opacity: clip?.transform.opacity ?? 100 },
                      intent: '',
                    });
                  }}
                  options={(status?.clips ?? []).map((c) => ({ value: c.id, label: `${c.name} · ${c.id}` }))}
                />
              ) : null}
              <label className={styles.intent}>
                <span>{t('guid.velorn.intent')}</span>
                <Input
                  value={settings.intent}
                  onChange={(intent) => update({ intent })}
                  placeholder={t('guid.velorn.intentExample')}
                  disabled={busy || !!unresolved}
                />
              </label>
              <div className={styles.controls}>
                {profile.controls.map((c) => (
                  <div className={styles.equalizer} key={c.controlId}>
                    <div className={styles.equalizerLabel}>
                      <span>{c.label}</span>
                      <Checkbox
                        checked={settings.lockedControls.includes(c.controlId)}
                        disabled={busy}
                        onChange={(checked) =>
                          update({
                            lockedControls: checked
                              ? [...settings.lockedControls, c.controlId]
                              : settings.lockedControls.filter((k) => k !== c.controlId),
                          })
                        }
                      >
                        {t('guid.velorn.lock')}
                      </Checkbox>
                    </div>
                    <Slider
                      min={c.min}
                      max={c.max}
                      step={c.step}
                      value={input.values[c.controlId]}
                      disabled={busy || !!unresolved || settings.lockedControls.includes(c.controlId)}
                      onChange={(v) => update({ values: { ...input.values, [c.controlId]: Number(v) }, intent: '' })}
                    />
                    <InputNumber
                      aria-label={c.label}
                      min={c.min}
                      max={c.max}
                      step={c.step}
                      value={input.values[c.controlId]}
                      disabled={busy || !!unresolved || settings.lockedControls.includes(c.controlId)}
                      onChange={(v) => {
                        if (v !== undefined) update({ values: { ...input.values, [c.controlId]: v }, intent: '' });
                      }}
                      suffix={c.unit}
                    />
                  </div>
                ))}
              </div>
              <div className={styles.actions}>
                <Button
                  disabled={busy || !!unresolved}
                  onClick={() => update({ values: defaults, intent: '', lockedControls: [] })}
                >
                  {t('guid.velorn.reset')}
                </Button>
                <Button
                  disabled={busy || !!unresolved || !past.length}
                  onClick={() => {
                    setFuture((f) => [settings, ...f]);
                    setSettings(past.at(-1)!);
                    setPast((p) => p.slice(0, -1));
                  }}
                >
                  {t('guid.velorn.configUndo')}
                </Button>
                <Button
                  disabled={busy || !!unresolved || !future.length}
                  onClick={() => {
                    setPast((p) => [...p, settings]);
                    setSettings(future[0]);
                    setFuture((f) => f.slice(1));
                  }}
                >
                  {t('guid.velorn.configRedo')}
                </Button>
              </div>
              {profile.previewOnly ? <Alert type='info' content={t('guid.velorn.previewOnly')} /> : null}
            </>
          )}
          <div className={styles.actions}>
            <Button
              disabled={busy || !profile || !status?.available || !!unresolved}
              onClick={() => void act('preview')}
            >
              {t('guid.velorn.preview')}
            </Button>
            <Button
              type='primary'
              disabled={busy || !ready || status?.authority.status !== 'ok'}
              onClick={() => void act('execute')}
            >
              {t('guid.velorn.authorize')}
            </Button>
            <Button
              status='warning'
              disabled={
                busy ||
                !operation?.executionReceipt ||
                !operation.after ||
                !['AUTHORIZED', 'PARTIAL'].includes(operation.phase)
              }
              onClick={() => void act('revert')}
            >
              {t('guid.velorn.undo')}
            </Button>
            {operation ? (
              <Tag
                color={
                  operation.phase === 'AUTHORIZED' ? 'green' : operation.phase === 'REVERTED' ? 'arcoblue' : 'orange'
                }
              >
                {operation.phase}
              </Tag>
            ) : null}
          </div>
          {operation?.after ? (
            <span>
              {t('guid.velorn.markerCount')}:{' '}
              {operation.phase === 'REVERTED' ? operation.prepared?.context.markerCount : operation.after.markerCount}
            </span>
          ) : null}
          {receipt ? (
            <div className={styles.route}>
              {t('guid.velorn.receipt')}: {receipt.ledger_entry_id}
            </div>
          ) : null}
          <AionCollapse bordered={false}>
            <AionCollapse.Item name='detail' header={t('guid.velorn.technical')}>
              <div className={styles.route}>AionUI → 4452 MCP · escritura autorizada 4453 → 4452 → Velorn 19790</div>
              <div className={styles.route}>
                {status?.authority.status} · {status?.authority.policy}
              </div>
              <div>{profile?.locks.join(' · ')}</div>
              <pre className={styles.patch}>
                {JSON.stringify((preview?.patch ?? operation?.patch)?.technical_changes ?? {}, null, 2)}
              </pre>
              <pre className={styles.patch}>{preview ? JSON.stringify(preview.preview, null, 2) : ''}</pre>
              <span>{t('guid.velorn.existingAssets')}</span>
              {(status?.assets ?? []).slice(0, 8).map((a) => (
                <div key={a.id} className={styles.route}>
                  {a.name} · {a.source} · {a.createdAt}
                  <br />
                  {a.path}
                </div>
              ))}
            </AionCollapse.Item>
          </AionCollapse>
          {error ? <Alert type='error' content={error} showIcon /> : null}
        </div>
      </AionCollapse.Item>
    </AionCollapse>
  );
};
export default VelornWorkflowEqualizer;
