import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { CreateShareInputSchema, ResolveShareInputSchema, ImportShareInputSchema, RevokeShareInputSchema,
  ShareCreatedSchema, SharePreviewSchema, type ShareCreated, type SharePreview } from '../shared/route-sharing.js';
import type { PlanningView } from '../shared/planning-form.js';
import type { PlanningDatabase } from './planning-database.js';
import { PlanningSessions, PlanningSessionError, type PlanningContext } from './planning-sessions.js';
import type { InitialContext } from './intent-start.js';
import { projectSavedConditions, remapSavedConditions } from './saved-conditions.js';
import { projectSharedConditions, projectSharedResult } from './route-sharing-projection.js';

const hash = (body: unknown) => createHash('sha256').update(JSON.stringify(body)).digest('hex');
function reject(code: string, status = 409): never { throw new PlanningSessionError(code, status); }
function parse<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) reject('INVALID_ACTION', 400);
  return parsed.data;
}
const iso = (value: Date | string) => new Date(value).toISOString();
type Row = { id: string; token: string; owner: string; draft_id: string; source_revision: number; fingerprint: string;
  conditions: SharePreview['conditions']; omissions: SharePreview['omissions']; plan: SharePreview['result'];
  plan_expires_at: Date | string | null; expires_at: Date | string; revoked_at: Date | string | null };
const noPlan = async (): Promise<never> => reject('SHARING_CANNOT_CALCULATE', 500);

/** Recipient reads/imports have no LLM/planner dependency and never access an owner's checkpoint. */
export class RouteSharing {
  constructor(readonly options: { database: PlanningDatabase; botUsername: string;
    context: (token: string) => Promise<InitialContext & { planning: PlanningContext }> }) {
    if (!/^[A-Za-z0-9_]{1,100}$/u.test(options.botUsername)) throw new Error('Invalid bot username');
  }
  private now() { return this.options.database.now(); }
  private active(row: Row | undefined): Row {
    if (!row || row.revoked_at || Date.parse(iso(row.expires_at)) <= this.now().getTime()) reject('SHARED_PLAN_NOT_FOUND', 404);
    return row;
  }
  private created(row: Row): ShareCreated {
    return ShareCreatedSchema.parse({ share_id: row.id, token: row.token,
      deep_link: `https://max.ru/${this.options.botUsername}?startapp=share_${row.token}`, expires_at: iso(row.expires_at) });
  }
  private async find(client: PoolClient, token: string, lock = false) {
    const result = await client.query<Row>(`SELECT * FROM planning_share_links WHERE token=$1${lock ? ' FOR UPDATE' : ''}`, [token]);
    return this.active(result.rows[0]);
  }
  async create(owner: string, input: unknown): Promise<ShareCreated> {
    const body = parse(CreateShareInputSchema, input), fingerprint = hash(body), database = this.options.database;
    return database.withOwner(owner, async (state, save, client) => {
      const old = (await client.query<Row>('SELECT * FROM planning_share_links WHERE owner=$1 AND create_event_id=$2', [owner, body.event_id])).rows[0];
      if (old) { if (old.fingerprint !== fingerprint) reject('EVENT_CONFLICT'); return this.created(this.active(old)); }
      const saved = await database.loadSaved(client, owner, body.draft_id);
      if (!saved) reject('SAVED_CONDITIONS_NOT_FOUND', 404);
      const sessions = new PlanningSessions({ checkpoint: state.checkpoint, now: () => this.now(), plan: noPlan });
      let view: PlanningView | undefined;
      try { view = sessions.get(owner, saved.id); }
      catch (error) { if (!(error instanceof PlanningSessionError) || error.code !== 'DRAFT_NOT_FOUND') throw error; }
      if (view && view.version > saved.revision) {
        saved.revision = view.version; state.checkpoint = sessions.checkpoint();
        await database.transaction(client, async () => { await save(); await database.saveSaved(client, owner, saved); });
      }
      if (body.base_revision !== saved.revision) reject('SHARE_SOURCE_STALE');
      const count = await client.query('SELECT count(*)::integer AS count FROM planning_share_links WHERE owner=$1 AND revoked_at IS NULL AND expires_at>$2', [owner, this.now()]);
      if (count.rows[0].count >= 20) reject('SHARE_CAPACITY', 429);
      const own = projectSharedConditions(saved.conditions, body.include_private_points);
      const record = sessions.checkpoint().records.find(item => item.owner === owner && item.view.id === saved.id);
      const preview = projectSharedResult(view?.result, record?.resultExpires ?? 0, this.now().getTime(), body.include_private_points);
      const expires = new Date(Math.min(this.now().getTime() + 7 * 86_400_000, Date.parse(saved.expires_at)));
      if (Buffer.byteLength(JSON.stringify({ ...own, ...preview })) > 256 * 1024) reject('SHARE_CAPACITY', 429);
      const row: Row = { id: randomUUID(), token: randomBytes(32).toString('base64url'), owner, draft_id: saved.id,
        source_revision: saved.revision, fingerprint, conditions: own.conditions, omissions: own.omissions,
        plan: preview.result, plan_expires_at: preview.result_expires_at, expires_at: expires, revoked_at: null };
      await database.transaction(client, async () => {
        await client.query(`INSERT INTO planning_share_links(id,token,owner,draft_id,source_revision,create_event_id,fingerprint,
          conditions,omissions,plan,plan_expires_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [row.id, row.token, owner, saved.id, saved.revision, body.event_id, fingerprint, JSON.stringify(own.conditions),
          JSON.stringify(own.omissions), preview.result ? JSON.stringify(preview.result) : null, preview.result_expires_at, expires]);
      });
      return this.created(row);
    });
  }
  async resolve(_recipient: string, input: unknown): Promise<SharePreview> {
    const body = parse(ResolveShareInputSchema, input), client = await this.options.database.pool.connect();
    try {
      const row = await this.find(client, body.token);
      const fresh = row.plan && row.plan_expires_at && Date.parse(iso(row.plan_expires_at)) > this.now().getTime();
      return SharePreviewSchema.parse({ expires_at: iso(row.expires_at), conditions: row.conditions, omissions: row.omissions,
        result: fresh ? row.plan : null, result_expires_at: fresh ? iso(row.plan_expires_at!) : null });
    } finally { client.release(); }
  }
  async revoke(owner: string, input: unknown): Promise<{ revoked: true }> {
    const body = parse(RevokeShareInputSchema, input), database = this.options.database;
    return database.withOwner(owner, async (_state, _save, client) => database.transaction(client, async () => {
      const previous = (await client.query<{ id: string }>('SELECT id FROM planning_share_links WHERE owner=$1 AND revoke_event_id=$2', [owner, body.event_id])).rows[0];
      if (previous && previous.id !== body.share_id) reject('EVENT_CONFLICT');
      const row = (await client.query<Row>('SELECT * FROM planning_share_links WHERE owner=$1 AND id=$2 FOR UPDATE', [owner, body.share_id])).rows[0];
      if (!row) reject('SHARED_PLAN_NOT_FOUND', 404);
      await client.query(`UPDATE planning_share_links SET revoked_at=COALESCE(revoked_at,$3),
        revoke_event_id=COALESCE(revoke_event_id,$4),plan=NULL,plan_expires_at=NULL WHERE owner=$1 AND id=$2`,
      [owner, body.share_id, this.now(), body.event_id]);
      return { revoked: true as const };
    }));
  }
  async import(recipient: string, input: unknown): Promise<PlanningView> {
    const body = parse(ImportShareInputSchema, input), fingerprint = hash(body), database = this.options.database;
    return database.withOwner(recipient, async (state, save, client) => {
      const row = await this.find(client, body.token);
      const old = (await client.query('SELECT * FROM planning_share_imports WHERE owner=$1 AND event_id=$2', [recipient, body.event_id])).rows[0];
      const sessions = new PlanningSessions({ checkpoint: state.checkpoint, now: () => this.now(), plan: noPlan });
      if (old) {
        if (old.fingerprint !== fingerprint) reject('EVENT_CONFLICT');
        if (old.status === 'pending') reject('SHARED_IMPORT_INTERRUPTED', 503);
        if (old.status === 'failed') reject(old.error ?? 'SHARED_IMPORT_FAILED', old.error_status ?? 503);
        try { return sessions.get(recipient, old.draft_id); }
        catch (error) { if (!(error instanceof PlanningSessionError) || error.code !== 'DRAFT_NOT_FOUND') throw error;
          reject('SHARED_IMPORT_EXPIRED', 410); }
      }
      await client.query(`INSERT INTO planning_share_imports(owner,event_id,share_id,fingerprint,status,expires_at)
        VALUES($1,$2,$3,$4,'pending',$5)`, [recipient, body.event_id, row.id, fingerprint, row.expires_at]);
      try {
        const context = await database.withSlot(client, 'intent', async () => {
          await database.recordUsage(client, 'geography');
          return this.options.context(body.locality_token);
        });
        const mapped = remapSavedConditions(row.conditions, { ...context, now: this.now().toISOString() });
        if (mapped.status === 'NEEDS_INPUT') reject(mapped.issues[0]?.code ?? 'SHARED_IMPORT_NEEDS_INPUT', 422);
        const view = sessions.create(recipient, mapped.draft, context.planning, mapped.provenance);
        const own = projectSavedConditions(view, { now: this.now() });
        const before = state.checkpoint; state.checkpoint = sessions.checkpoint();
        try {
          await database.transaction(client, async () => {
            await this.find(client, body.token, true); // Revoke/expiry may have happened during context HTTP.
            await save();
            await database.saveSaved(client, recipient, { id: view.id, revision: view.version, conditions: own,
              expires_at: new Date(this.now().getTime() + 30 * 86_400_000).toISOString() });
            await client.query("UPDATE planning_share_imports SET status='done',draft_id=$3 WHERE owner=$1 AND event_id=$2", [recipient, body.event_id, view.id]);
          });
        } catch (error) { state.checkpoint = before; throw error; }
        return view;
      } catch (error) {
        const failure = error instanceof PlanningSessionError ? error : new PlanningSessionError('SHARED_IMPORT_FAILED', 503);
        await client.query("UPDATE planning_share_imports SET status='failed',error=$3,error_status=$4 WHERE owner=$1 AND event_id=$2", [recipient, body.event_id, failure.code, failure.status]);
        throw failure;
      }
    });
  }
}
