import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
const LOCK_RETRY_MS = 50;
const LOCK_MAX_RETRIES = 100;
export class StoreCorruptionError extends Error {
    constructor(filePath, cause) {
        super(`Corrupt store ${filePath}; no valid previous snapshot`, { cause });
        this.name = "StoreCorruptionError";
    }
}
function acquireLock(lockPath) {
    mkdirSync(dirname(lockPath), { recursive: true });
    for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
        try {
            writeFileSync(lockPath, `${process.pid}`, { flag: "wx" });
            return;
        }
        catch (e) {
            if (e.code === "EEXIST") {
                try {
                    const pid = parseInt(readFileSync(lockPath, "utf-8"), 10);
                    if (!pid || !isProcessRunning(pid)) {
                        try {
                            unlinkSync(lockPath);
                        }
                        catch { /* ignore */ }
                        continue;
                    }
                }
                catch { /* ignore read errors */ }
                const start = Date.now();
                while (Date.now() - start < LOCK_RETRY_MS) { /* busy wait */ }
                continue;
            }
            throw e;
        }
    }
    throw new Error(`Failed to acquire lock: ${lockPath}`);
}
function releaseLock(lockPath) {
    try {
        unlinkSync(lockPath);
    }
    catch { /* ignore */ }
}
function isProcessRunning(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
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
export class ReducerBackedStore {
    filePath;
    lockPath;
    lastLoadedSignature;
    nextId = 1;
    entries = new Map();
    config;
    constructor(config, listIdOrPath) {
        this.config = config;
        if (!listIdOrPath)
            return;
        const filePath = isAbsolute(listIdOrPath) ? listIdOrPath : join(config.baseDir, `${listIdOrPath}.json`);
        mkdirSync(dirname(filePath), { recursive: true });
        this.filePath = filePath;
        this.lockPath = `${filePath}.lock`;
        this.load();
    }
    getFileSignature() {
        if (!this.filePath || !existsSync(this.filePath))
            return undefined;
        const stat = statSync(this.filePath);
        return `${stat.mtimeMs}:${stat.size}`;
    }
    parseSnapshot(filePath) {
        const raw = readFileSync(filePath, "utf-8");
        try {
            const data = JSON.parse(raw);
            const { nextId, entries } = this.config.deserialize(data);
            return { nextId, entries, raw };
        }
        catch (error) {
            throw new StoreCorruptionError(filePath, error);
        }
    }
    syncDirectory() {
        if (!this.filePath)
            return;
        const fd = openSync(dirname(this.filePath), "r");
        try {
            // Directory fsync is best-effort dirent durability (POSIX only). Windows'
            // FlushFileBuffers needs write access on the handle and throws EPERM on a
            // read-only directory descriptor, and the file fsync in writeSnapshot()
            // already made the bytes durable.
            try {
                fsyncSync(fd);
            }
            catch (error) {
                if (process.platform === "win32" && error.code === "EPERM")
                    return;
                throw error;
            }
        }
        finally {
            closeSync(fd);
        }
    }
    writeSnapshot(filePath, raw) {
        const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
        let fd;
        try {
            fd = openSync(tmpPath, "wx", 0o600);
            writeFileSync(fd, raw);
            fsyncSync(fd);
            closeSync(fd);
            fd = undefined;
            renameSync(tmpPath, filePath);
            this.syncDirectory();
        }
        finally {
            if (fd !== undefined)
                closeSync(fd);
            try {
                unlinkSync(tmpPath);
            }
            catch { /* already renamed or never created */ }
        }
    }
    recoverPrevious(cause) {
        if (!this.filePath)
            return;
        const previousPath = `${this.filePath}.prev`;
        let previous;
        try {
            previous = this.parseSnapshot(previousPath);
        }
        catch (previousError) {
            throw new StoreCorruptionError(this.filePath, { current: cause, previous: previousError });
        }
        const quarantinePath = `${this.filePath}.corrupt-${Date.now()}-${process.pid}`;
        renameSync(this.filePath, quarantinePath);
        try {
            this.writeSnapshot(this.filePath, previous.raw);
        }
        catch (recoveryError) {
            try {
                renameSync(quarantinePath, this.filePath);
            }
            catch { /* preserve quarantine when restore fails */ }
            throw new StoreCorruptionError(this.filePath, recoveryError);
        }
        this.nextId = previous.nextId;
        this.entries = previous.entries;
        this.lastLoadedSignature = this.getFileSignature();
    }
    load(force = false, lockHeld = false) {
        if (!this.filePath)
            return;
        const signature = this.getFileSignature();
        if (!signature)
            return;
        if (!force && signature === this.lastLoadedSignature)
            return;
        try {
            const { nextId, entries } = this.parseSnapshot(this.filePath);
            this.nextId = nextId;
            this.entries = entries;
            this.lastLoadedSignature = signature;
        }
        catch (error) {
            if (lockHeld || !this.lockPath) {
                this.recoverPrevious(error);
                return;
            }
            acquireLock(this.lockPath);
            try {
                this.load(true, true);
            }
            finally {
                releaseLock(this.lockPath);
            }
        }
    }
    save() {
        if (!this.filePath)
            return;
        const previousPath = `${this.filePath}.prev`;
        if (existsSync(this.filePath)) {
            const current = this.parseSnapshot(this.filePath);
            this.writeSnapshot(previousPath, current.raw);
        }
        else {
            try {
                unlinkSync(previousPath);
            }
            catch { /* remove stale backup for a new store */ }
        }
        const data = this.config.serialize(this.nextId, this.entries);
        this.writeSnapshot(this.filePath, JSON.stringify(data, null, 2));
        this.lastLoadedSignature = this.getFileSignature();
    }
    withLock(fn, shouldSave = () => true) {
        if (!this.lockPath)
            return fn();
        acquireLock(this.lockPath);
        try {
            this.load(true, true);
            const result = fn();
            if (shouldSave(result))
                this.save();
            return result;
        }
        finally {
            releaseLock(this.lockPath);
        }
    }
    applyReducerEvent(event) {
        const result = this.config.reduce(this.config.toReducerState(this.nextId, this.entries), event);
        const { nextId, entries } = this.config.fromReducerState(result.state);
        this.nextId = nextId;
        this.entries = entries;
        if (result.effects.length > 0)
            this.onEffects(result.effects);
        return result;
    }
    /**
     * Hook for reducer effects. Default no-op: durability is owned by
     * {@link withLock}. Override to forward non-persistence effects.
     */
    onEffects(_effects) { }
    /** Reload (signature-gated) and return the entry, or undefined. */
    get(id) {
        if (this.filePath)
            this.load();
        return this.entries.get(id);
    }
    /** Reload (signature-gated) and return all entries sorted by numeric id. */
    list() {
        if (this.filePath)
            this.load();
        return Array.from(this.entries.values()).sort((a, b) => Number(a.id) - Number(b.id));
    }
    /** Remove the backing file when the store is empty. No-op for memory stores. */
    deleteFileIfEmpty() {
        if (!this.filePath || this.entries.size > 0)
            return false;
        try {
            unlinkSync(this.filePath);
        }
        catch { /* ignore */ }
        try {
            unlinkSync(`${this.filePath}.prev`);
        }
        catch { /* ignore */ }
        return true;
    }
}
