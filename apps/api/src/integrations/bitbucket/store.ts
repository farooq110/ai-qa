/**
 * Bitbucket connection persistence.
 *
 * The GitHub integration keeps its connections in the application's existing
 * `repository_connections` storage, which is what makes
 * `GET /v1/repository-connections/:id/repositories` work for it. This module
 * follows the same approach:
 *
 *   - `BitbucketConnectionStore` is a small interface you can back with your
 *     own database (Prisma model, TypeORM entity, …). A ready-to-use schema
 *     snippet is in docs/BITBUCKET_SETUP.md.
 *   - `createJsonFileConnectionStore` is a zero-dependency default that keeps
 *     the records in a local JSON file — handy for local development before
 *     the database adapter is wired in.
 *
 * SERVER-SIDE ONLY: stores OAuth access/refresh tokens.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { BITBUCKET_STATE_TTL_MS } from './config';

export type BitbucketConnectionStatus = 'pending_selection' | 'connected';

export interface BitbucketConnectionAccount {
  uuid: string;
  username: string;
  displayName: string;
}

export type BitbucketRepositorySelection =
  | { mode: 'all' }
  | { mode: 'selected'; repositoryIds: string[] };

/** One row per authorized Bitbucket account — the Bitbucket analogue of a
 * GitHub App installation. */
export interface BitbucketConnectionRecord {
  id: string;
  provider: 'bitbucket';
  /** Owner of the connection (your authenticated user id, or 'local'). */
  ownerId: string;
  account: BitbucketConnectionAccount;
  accessToken: string;
  refreshToken: string | null;
  tokenExpiresAt: string | null;
  scopes: string | null;
  status: BitbucketConnectionStatus;
  /**
   * `null` until the user completes the repository-access step
   * (All repositories / Only selected repositories) and saves it.
   */
  selection: BitbucketRepositorySelection | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateConnectionInput {
  ownerId: string;
  account: BitbucketConnectionAccount;
  accessToken: string;
  refreshToken: string | null;
  tokenExpiresAt: string | null;
  scopes: string | null;
}

export interface UpdateConnectionPatch {
  accessToken?: string;
  refreshToken?: string | null;
  tokenExpiresAt?: string | null;
  status?: BitbucketConnectionStatus;
  selection?: BitbucketRepositorySelection | null;
}

export interface BitbucketConnectionStore {
  create(input: CreateConnectionInput): Promise<BitbucketConnectionRecord>;
  get(id: string): Promise<BitbucketConnectionRecord | null>;
  /** Most recent connection for an owner (Settings page card). */
  findByOwner(ownerId: string): Promise<BitbucketConnectionRecord | null>;
  update(id: string, patch: UpdateConnectionPatch): Promise<BitbucketConnectionRecord | null>;
  delete(id: string): Promise<boolean>;
}

/** Generates connection ids (override with your cuid generator when wiring). */
export function defaultConnectionIdFactory(): string {
  return `bb_${crypto.randomUUID().replace(/-/g, '')}`;
}

// ---------------------------------------------------------------------------
// Pending OAuth state (CSRF protection + where to return afterwards)
// ---------------------------------------------------------------------------

export interface PendingAuthState {
  state: string;
  ownerId: string;
  /** Absolute origin of the web app to send the browser back to. */
  webOrigin: string;
  /** Sanitized relative path in the web app (Settings page / modal context). */
  nextPath: string;
  expiresAt: number;
}

export interface PendingStateStore {
  put(record: PendingAuthState): Promise<void>;
  /** Consumes the state (single use). */
  take(state: string): Promise<PendingAuthState | null>;
}

/** In-memory pending-state store (single-use, TTL, bounded size). */
export function createInMemoryPendingStateStore(limit = 50): PendingStateStore {
  const records = new Map<string, PendingAuthState>();
  return {
    async put(record: PendingAuthState): Promise<void> {
      const now = Date.now();
      for (const [key, value] of records) {
        if (value.expiresAt <= now) records.delete(key);
      }
      while (records.size >= limit) {
        const oldest = records.keys().next().value;
        if (oldest === undefined) break;
        records.delete(oldest);
      }
      records.set(record.state, record);
    },
    async take(state: string): Promise<PendingAuthState | null> {
      const record = records.get(state);
      if (!record) return null;
      records.delete(state);
      if (record.expiresAt <= Date.now()) return null;
      return record;
    },
  };
}

export { BITBUCKET_STATE_TTL_MS };

// ---------------------------------------------------------------------------
// Default JSON-file connection store (local development)
// ---------------------------------------------------------------------------

export function createJsonFileConnectionStore(
  filePath = path.join(process.cwd(), '.data', 'bitbucket-connections.json'),
  idFactory: () => string = defaultConnectionIdFactory,
): BitbucketConnectionStore {
  let writeQueue: Promise<unknown> = Promise.resolve();

  async function readAll(): Promise<BitbucketConnectionRecord[]> {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as BitbucketConnectionRecord[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function serializeWrite(records: BitbucketConnectionRecord[]): Promise<void> {
    writeQueue = writeQueue.then(async () => {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(records, null, 2), { mode: 0o600 });
      await fs.rename(tmp, filePath);
    });
    return writeQueue as Promise<void>;
  }

  return {
    async create(input: CreateConnectionInput): Promise<BitbucketConnectionRecord> {
      const records = await readAll();
      const now = new Date().toISOString();
      const record: BitbucketConnectionRecord = {
        id: idFactory(),
        provider: 'bitbucket',
        ownerId: input.ownerId,
        account: input.account,
        accessToken: input.accessToken,
        refreshToken: input.refreshToken,
        tokenExpiresAt: input.tokenExpiresAt,
        scopes: input.scopes,
        status: 'pending_selection',
        selection: null,
        createdAt: now,
        updatedAt: now,
      };
      records.push(record);
      await serializeWrite(records);
      return record;
    },

    async get(id: string): Promise<BitbucketConnectionRecord | null> {
      const records = await readAll();
      return records.find((record) => record.id === id) ?? null;
    },

    async findByOwner(ownerId: string): Promise<BitbucketConnectionRecord | null> {
      const records = await readAll();
      const owned = records.filter((record) => record.ownerId === ownerId);
      return owned.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0] ?? null;
    },

    async update(id: string, patch: UpdateConnectionPatch): Promise<BitbucketConnectionRecord | null> {
      const records = await readAll();
      const index = records.findIndex((record) => record.id === id);
      if (index === -1) return null;
      records[index] = { ...records[index], ...patch, updatedAt: new Date().toISOString() };
      await serializeWrite(records);
      return records[index];
    },

    async delete(id: string): Promise<boolean> {
      const records = await readAll();
      const next = records.filter((record) => record.id !== id);
      if (next.length === records.length) return false;
      await serializeWrite(next);
      return true;
    },
  };
}
