/** @license SPDX-License-Identifier: Apache-2.0 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseEnvironmentFile } from '../velorn/service';

export type JsonObject = Record<string, unknown>;
export type RequestPort = (method: string, path: string, body?: unknown, key?: string) => Promise<JsonObject>;
export const object = (value: unknown): JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
export const objects = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.map(object) : []);

/** Private main-process configuration; no credentials are returned over IPC. */
export function authorityClient(options: { file?: string; fetch?: typeof fetch } = {}): RequestPort {
  return async (method, path, body, key) => {
    const file = options.file ?? join(homedir(), '.config/monstruo/orchestration-continuity.env');
    let config: Record<string, string> = {};
    try {
      config = parseEnvironmentFile(await readFile(file, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('CONTINUITY_CONFIG_INVALID');
    }
    const base = process.env.AIONUI_MONSTRUO_CONTINUITY_URL ?? config.AIONUI_MONSTRUO_CONTINUITY_URL;
    const token = process.env.AIONUI_MONSTRUO_API_KEY ?? config.AIONUI_MONSTRUO_API_KEY;
    if (!base || !token) throw new Error('CONTINUITY_NOT_CONFIGURED');
    const url = new URL(base);
    if (
      url.username ||
      url.password ||
      (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    ) {
      throw new Error('CONTINUITY_INSECURE_URL');
    }
    const response = await (options.fetch ?? fetch)(`${base.replace(/\/$/, '')}/v1/orchestration/continuity${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-API-Key': token, ...(key ? { 'Idempotency-Key': key } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`CONTINUITY_HTTP_${response.status}`);
    const data = object(await response.json());
    if (!Object.keys(data).length) throw new Error('CONTINUITY_RESPONSE_INVALID');
    return data;
  };
}
