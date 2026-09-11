/** @license SPDX-License-Identifier: Apache-2.0 */
import { ipcBridge } from '@/common';
import type { ContinuityReply, ContinuityStatus } from '@/common/types/team/continuity';
import { Alert, Button, Input, Select, Tag } from '@arco-design/web-react';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

const unpack = <T,>(reply: ContinuityReply<T>): T => {
  if (reply.ok === false) throw new Error(reply.error);
  return reply.data;
};

/** Opt-in institutional continuity attached to native conversations, not a second task UI. */
const ContinuityBar: React.FC<{ conversation_id: string }> = ({ conversation_id }) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [status, setStatus] = useState<ContinuityStatus>();
  const [text, setText] = useState('');
  const [source, setSource] = useState<string>();
  const [sources, setSources] = useState<Array<{ conversation_id: string; name: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try {
      setStatus(unpack(await ipcBridge.continuity.status.invoke({ conversation_id })));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'CONTINUITY_UNAVAILABLE');
    }
  }, [conversation_id]);
  useEffect(() => {
    setStatus(undefined);
    setError('');
    setText('');
    setSource(undefined);
    // Recover already persisted native results after a restart without resending work.
    void ipcBridge.continuity.collect
      .invoke({ conversation_id })
      .then((reply) => {
        if (reply.ok === false) setError(reply.error);
        return refresh();
      })
      .catch(() => {
        setError('CONTINUITY_UNAVAILABLE');
      });
    const completed = ipcBridge.conversation.turnCompleted.on((event) => {
      if (event.session_id !== conversation_id) return;
      void ipcBridge.continuity.collect.invoke({ conversation_id }).then((reply) => {
        if (reply.ok === false) setError(reply.error);
        return refresh();
      });
    });
    const changed = ipcBridge.continuity.changed.on((event) => {
      if (event.conversation_id !== conversation_id) return;
      if (event.error) setError(event.error);
      void refresh();
    });
    return () => {
      completed();
      changed();
    };
  }, [conversation_id, refresh]);
  useEffect(() => {
    if (!expanded) return;
    void ipcBridge.continuity.sources.invoke().then((reply) => {
      if (reply.ok === true) setSources(reply.data.filter((s) => s.conversation_id !== conversation_id));
      else setError(reply.error);
    });
  }, [expanded, conversation_id]);
  const act = async (kind: 'link' | 'instruction' | 'refresh') => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (kind === 'link')
        setStatus(
          unpack(
            await ipcBridge.continuity.link.invoke({ conversation_id, source_conversation_id: source, objective: text })
          )
        );
      else if (kind === 'instruction')
        setStatus(unpack(await ipcBridge.continuity.instruct.invoke({ conversation_id, text })));
      else {
        unpack(await ipcBridge.continuity.collect.invoke({ conversation_id }));
        await refresh();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'CONTINUITY_UNAVAILABLE');
    } finally {
      setBusy(false);
    }
  };
  const pack = status?.pack;
  const instruction = pack?.current_instruction as { text?: string } | undefined;
  const omissions = Array.isArray(pack?.omissions) ? pack.omissions : [];
  const results = Array.isArray(pack?.results)
    ? (pack.results as Array<{ result?: { result_id?: string; summary?: string; status?: string } }>)
    : [];
  return (
    <section
      className='shrink-0 border-t border-solid border-3 border-x-0 border-b-0 py-4px'
      data-testid='continuity-bar'
    >
      <div className='flex items-center gap-8px'>
        <Button size='mini' type='text' onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
          {t('conversation.continuity.title')}
        </Button>
        <Tag>{status?.pointer ? t('conversation.continuity.bound') : t('conversation.continuity.native')}</Tag>
        {status?.pointer && (
          <span className='text-12px text-t-secondary'>
            {t('conversation.continuity.results', { count: results.length })}
          </span>
        )}
      </div>
      {expanded && (
        <div className='flex flex-col gap-8px p-8px max-h-300px overflow-auto'>
          <span className='text-12px text-t-secondary'>{t('conversation.continuity.scope')}</span>
          {(error || status?.error) && <Alert type='error' content={error || status?.error} />}
          {status?.pointer && <code>{status.pointer.continuity_id}</code>}
          {instruction?.text && <pre className='whitespace-pre-wrap text-12px'>{instruction.text}</pre>}
          {omissions.length > 0 && (
            <Alert
              type='warning'
              title={t('conversation.continuity.partial')}
              content={omissions.map(String).join('\n')}
            />
          )}
          <Input.TextArea
            aria-label={t('conversation.continuity.direction')}
            placeholder={t('conversation.continuity.direction')}
            value={text}
            onChange={setText}
            autoSize={{ minRows: 2, maxRows: 5 }}
          />
          {!status?.pointer && (
            <Select
              allowClear
              showSearch
              aria-label={t('conversation.continuity.source')}
              placeholder={t('conversation.continuity.source')}
              value={source}
              onChange={setSource}
              options={sources.map((s) => ({ value: s.conversation_id, label: `${s.name} · ${s.conversation_id}` }))}
            />
          )}
          <div className='flex flex-wrap gap-8px'>
            {!status?.pointer && (
              <Button size='small' disabled={busy || (!text.trim() && !source)} onClick={() => void act('link')}>
                {source ? t('conversation.continuity.resume') : t('conversation.continuity.enable')}
              </Button>
            )}
            {status?.pointer && (
              <Button size='small' disabled={busy || !text.trim()} onClick={() => void act('instruction')}>
                {t('conversation.continuity.supersede')}
              </Button>
            )}
            <Button size='small' disabled={busy} onClick={() => void act('refresh')}>
              {t('conversation.continuity.recover')}
            </Button>
          </div>
          {results.slice(-8).map((entry) => (
            <div key={entry.result?.result_id} className='border border-solid border-3 p-8px'>
              <Tag>{entry.result?.status}</Tag>
              <pre className='whitespace-pre-wrap text-12px'>{entry.result?.summary}</pre>
            </div>
          ))}
        </div>
      )}
    </section>
  );
};
const DesktopContinuityBar: React.FC<{ conversation_id: string }> = (props) =>
  typeof window !== 'undefined' && window.__backendPort ? <ContinuityBar {...props} /> : null;
export default DesktopContinuityBar;
