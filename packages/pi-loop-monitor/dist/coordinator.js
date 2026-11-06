export class CoordinatorError extends Error {
    constructor(message) {
        super(message);
        this.name = "CoordinatorError";
    }
}
export function createCoordinator(options) {
    const { reducers, effectHandlers = {}, effectExecutor, maxDispatchDepth = 100, } = options;
    function isPromiseLike(value) {
        return typeof value === "object" && value !== null && "then" in value;
    }
    async function executeEffect(effect, depth) {
        if (effect.type === "DISPATCH_EVENT") {
            const dispatchEffect = effect;
            const derivedEvent = dispatchEffect.payload.event;
            if (!derivedEvent) {
                throw new CoordinatorError("DISPATCH_EVENT effect missing payload.event");
            }
            return dispatchAtDepth(derivedEvent, depth + 1);
        }
        const specificHandler = effectHandlers[effect.type];
        if (specificHandler) {
            const handled = specificHandler(effect);
            const result = isPromiseLike(handled) ? await handled : handled;
            return result === undefined ? [] : [result];
        }
        if (effectExecutor) {
            const handled = effectExecutor(effect);
            const result = isPromiseLike(handled) ? await handled : handled;
            return result === undefined ? [] : [result];
        }
        return [];
    }
    async function dispatchAtDepth(event, depth) {
        if (depth > maxDispatchDepth) {
            throw new CoordinatorError(`Maximum dispatch depth exceeded (${maxDispatchDepth})`);
        }
        const effects = [];
        for (const reducer of reducers) {
            const emitted = reducer(event);
            const resolved = isPromiseLike(emitted) ? await emitted : emitted;
            if (!resolved || resolved.length === 0)
                continue;
            effects.push(...resolved);
        }
        const results = [];
        for (const effect of effects) {
            results.push(...await executeEffect(effect, depth));
        }
        return results;
    }
    return {
        dispatch(event) {
            return dispatchAtDepth(event, 1);
        },
    };
}
