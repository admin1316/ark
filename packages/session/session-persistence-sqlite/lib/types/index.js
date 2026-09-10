/**
 * Opt-in SQLite persistence provider. Logical sessions remain unchanged;
 * the physical backend packs eligible chunk runs into schema-19 rows.
 * @module @deepseek-ai/dsh-session-persistence-sqlite
 */
import { Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { DEFAULT_PREPARED_SESSION_CACHE_SIZE, DEFAULT_WRITE_BATCH_MAX_DELAY_MS, MAX_WRITE_BATCH_DELAY_MS, PersistenceCoordinator, SessionPersistence, } from '@deepseek-ai/dsh-session-persistence';
import { SqliteStore } from "./store.js";
export { SCHEMA_VERSION } from "./schema.js";
/** Default wait for another SQLite connection's write reservation. */
export const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
/** Largest busy timeout accepted by SQLite's signed millisecond interface. */
export const MAX_BUSY_TIMEOUT_MS = 2_147_483_647;
/**
 * SQLite `SessionPersistence` provider with a schema-owned physical codec.
 */
export class SqliteSessionPersistence extends SessionPersistence {
    config;
    supportsRawArtifacts = false;
    name = 'session-persistence-sqlite';
    static inject = ['sessions'];
    static Config = z.object({
        path: z.string().required(),
        journalMode: z.union(['wal', 'delete', 'truncate', 'persist']).default('wal'),
        busyTimeoutMs: z.number().step(1).min(0).max(MAX_BUSY_TIMEOUT_MS).default(DEFAULT_BUSY_TIMEOUT_MS),
        preparedSessionCacheSize: z.number().step(1).min(1).default(DEFAULT_PREPARED_SESSION_CACHE_SIZE),
        writeBatchMaxDelayMs: z.number().step(1).min(1).max(MAX_WRITE_BATCH_DELAY_MS)
            .default(DEFAULT_WRITE_BATCH_MAX_DELAY_MS),
    });
    store;
    coordinator;
    constructor(ctx, config) {
        super(ctx);
        this.config = config;
        const preparedSessionCacheSize = config.preparedSessionCacheSize
            ?? DEFAULT_PREPARED_SESSION_CACHE_SIZE;
        const writeBatchMaxDelayMs = config.writeBatchMaxDelayMs
            ?? DEFAULT_WRITE_BATCH_MAX_DELAY_MS;
        this.store = new SqliteStore({
            path: config.path,
            journalMode: config.journalMode ?? 'wal',
            busyTimeoutMs: config.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
        });
        this.coordinator = new PersistenceCoordinator(this.ctx, this.store, {
            preparedSessionCacheSize,
            writeBatchMaxDelayMs,
        });
    }
    /** Reject self-contained path and ownership failures without loading Node SQLite. */
    async [Service.init]() {
        await this.store.validatePath();
    }
    /** SQLite has one database, not an independent per-session artifact. */
    locate(_meta) {
        return undefined;
    }
    create(meta) {
        return this.coordinator.create(meta);
    }
    ensureMaterialized(session) {
        return this.coordinator.ensureMaterialized(session);
    }
    append(id, events) {
        return this.coordinator.append(id, events);
    }
    delete(id) {
        return this.coordinator.delete(id);
    }
    prepare(id, signal) {
        return this.coordinator.prepare(id, signal);
    }
    load(id) {
        return this.coordinator.load(id);
    }
    inspect(id, signal) {
        return this.coordinator.inspect(id, signal);
    }
    borrowSession(id, signal) {
        return this.coordinator.borrowSession(id, signal);
    }
    readFrom(id, fromSeq, signal) {
        return this.coordinator.readFrom(id, fromSeq, signal);
    }
    list(signal) {
        return this.store.list(signal);
    }
    listSnapshots(signal) {
        return this.store.listSnapshots(signal);
    }
}
export default SqliteSessionPersistence;
//# sourceMappingURL=index.js.map