import type { AnyReducerEffect } from "./coordinator.js";
export declare class StoreCorruptionError extends Error {
    constructor(filePath: string, cause?: unknown);
}
export interface ReducerResult<TState, TEffect extends AnyReducerEffect = AnyReducerEffect> {
    state: TState;
    effects: TEffect[];
}
/**
 * Per-store glue the base needs to translate between its internal
 * `{ nextId, entries }` representation, the pure reducer's state shape, and the
 * on-disk JSON shape. Each is a small, allocation-only function.
 */
export interface ReducerBackedStoreConfig<TEntry, TState, TEvent, TData, TEffect extends AnyReducerEffect = AnyReducerEffect> {
    /** Directory for `<listId>.json` when constructed with a bare list id. */
    baseDir: string;
    reduce: (state: TState, event: TEvent) => ReducerResult<TState, TEffect>;
    toReducerState: (nextId: number, entries: Map<string, TEntry>) => TState;
    fromReducerState: (state: TState) => {
        nextId: number;
        entries: Map<string, TEntry>;
    };
    serialize: (nextId: number, entries: Map<string, TEntry>) => TData;
    deserialize: (data: TData) => {
        nextId: number;
        entries: Map<string, TEntry>;
    };
}
/**
 * Shared persistence and reducer-dispatch machinery for file-backed loop
 * state. It owns file locking, signature-gated loading, atomic saves, and
 * reducer application; the loop store adds its command methods.
 *
 * Durability boundary: every mutation runs inside {@link withLock}, which saves
 * the whole file after successful mutations. Rejected commands can explicitly
 * skip persistence so normalization during load does not rewrite the snapshot.
 * Reducer effects are not the persistence mechanism; they are surfaced to
 * {@link onEffects} (default: no-op) for runtime-owned follow-up behavior.
 */
export declare abstract class ReducerBackedStore<TEntry extends {
    id: string;
}, TState, TEvent, TData, TEffect extends AnyReducerEffect = AnyReducerEffect> {
    protected filePath: string | undefined;
    protected lockPath: string | undefined;
    private lastLoadedSignature;
    protected nextId: number;
    protected entries: Map<string, TEntry>;
    private readonly config;
    constructor(config: ReducerBackedStoreConfig<TEntry, TState, TEvent, TData, TEffect>, listIdOrPath?: string);
    private getFileSignature;
    private parseSnapshot;
    private syncDirectory;
    private writeSnapshot;
    private recoverPrevious;
    private load;
    private save;
    protected withLock<T>(fn: () => T, shouldSave?: (result: T) => boolean): T;
    protected applyReducerEvent(event: TEvent): ReducerResult<TState, TEffect>;
    /**
     * Hook for reducer effects. Default no-op: durability is owned by
     * {@link withLock}. Override to forward non-persistence effects.
     */
    protected onEffects(_effects: AnyReducerEffect[]): void;
    /** Reload (signature-gated) and return the entry, or undefined. */
    get(id: string): TEntry | undefined;
    /** Reload (signature-gated) and return all entries sorted by numeric id. */
    list(): TEntry[];
    /** Remove the backing file when the store is empty. No-op for memory stores. */
    deleteFileIfEmpty(): boolean;
}
