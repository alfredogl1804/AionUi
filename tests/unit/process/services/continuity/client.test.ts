/** @license SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorityClient } from '@/process/services/continuity/client';
describe('Private continuity transport', () => {
  it('fails explicitly when configuration is missing', async () => {
    const fetcher = vi.fn();
    await expect(
      authorityClient({ file: '/nonexistent/continuity.env', fetch: fetcher })('GET', '/tasks/x:recover')
    ).rejects.toThrow('NOT_CONFIGURED');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not send credentials over cleartext to a remote host', async () => {
    const root = await mkdtemp(join(tmpdir(), 'continuity-'));
    try {
      const file = join(root, 'env');
      await writeFile(file, 'AIONUI_MONSTRUO_CONTINUITY_URL=http://example.org\nAIONUI_MONSTRUO_API_KEY=fixture-only');
      const fetcher = vi.fn();
      await expect(authorityClient({ file, fetch: fetcher })('GET', '/test')).rejects.toThrow('INSECURE_URL');
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('uses the configured authority and disallows credential-bearing redirects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'continuity-'));
    try {
      const file = join(root, 'env');
      await writeFile(
        file,
        'AIONUI_MONSTRUO_CONTINUITY_URL=http://127.0.0.1:4453\nAIONUI_MONSTRUO_API_KEY=fixture-only'
      );
      const fetcher = vi.fn().mockResolvedValue(new Response('{"status":"ok"}'));
      const result = await authorityClient({ file, fetch: fetcher })(
        'POST',
        '/tasks:bind',
        { foo: 'bar' },
        'stable-key'
      );
      expect(result.status).toBe('ok');
      expect(fetcher.mock.calls[0][1]).toMatchObject({
        redirect: 'error',
        headers: { 'Idempotency-Key': 'stable-key' },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
