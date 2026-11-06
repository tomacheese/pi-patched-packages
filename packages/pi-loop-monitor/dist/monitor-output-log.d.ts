export interface MonitorOutputPage {
    text: string;
    start: number;
    end: number;
    total: number;
    path: string;
    error?: string;
}
/** Full command text lives on disk; callers only load one UTF-8-safe page. */
export declare class MonitorOutputLog {
    readonly path: string;
    private readonly directory;
    private readonly fd;
    private size;
    private error;
    constructor();
    append(data: Buffer): void;
    /** Omit offset to read the tail. Explicit offsets are stable while output grows. */
    read(offset?: number): MonitorOutputPage;
    dispose(): void;
}
