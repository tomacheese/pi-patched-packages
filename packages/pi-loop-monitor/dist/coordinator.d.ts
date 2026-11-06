export type ReducerSource = "tool" | "command" | "scheduler" | "eventbus" | "monitor" | "session" | "coordinator" | "system";
export type ReducerEntityType = "loop" | "monitor" | "notification";
export interface ReducerEvent<TType extends string = string, TPayload = unknown> {
    type: TType;
    at: number;
    source: ReducerSource;
    entityType?: ReducerEntityType;
    entityId?: string;
    payload: TPayload;
}
export interface ReducerEffect<TEffect extends string = string, TPayload = unknown> {
    type: TEffect;
    entityType?: ReducerEntityType;
    entityId?: string;
    payload: TPayload;
}
export type DispatchEventEffect = ReducerEffect<"DISPATCH_EVENT", {
    event: ReducerEvent;
}>;
export type AnyReducerEffect = ReducerEffect | DispatchEventEffect;
export type ReducerHandler = (event: ReducerEvent) => undefined | AnyReducerEffect[] | Promise<undefined | AnyReducerEffect[]>;
export type EffectHandler<TResult = void> = (effect: ReducerEffect) => TResult | undefined | Promise<TResult | undefined>;
export interface CoordinatorOptions<TResult = void> {
    reducers: ReducerHandler[];
    effectHandlers?: Partial<Record<string, EffectHandler<TResult>>>;
    effectExecutor?: EffectHandler<TResult>;
    maxDispatchDepth?: number;
}
export declare class CoordinatorError extends Error {
    constructor(message: string);
}
export interface Coordinator<TResult = void> {
    dispatch(event: ReducerEvent): Promise<TResult[]>;
}
export declare function createCoordinator<TResult = void>(options: CoordinatorOptions<TResult>): Coordinator<TResult>;
