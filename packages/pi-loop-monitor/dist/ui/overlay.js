export async function runMonitorsOverlay(ctx, createComponent) {
    let component;
    let handle;
    let ownerTui;
    let closed = false;
    let pendingOutcome;
    let finish;
    const completeClose = () => {
        if (!handle || !ownerTui || !pendingOutcome || !finish)
            return;
        handle.hide();
        // Pi 0.84/0.85 completes custom overlays by popping the newest stack entry.
        // Replace this exact handle with an invisible sentinel so done() cannot pop
        // an unrelated overlay that opened after /monitors.
        ownerTui.showOverlay({ render: () => [], invalidate: () => { } }, { width: 1, maxHeight: 1, visible: () => false, nonCapturing: true });
        const outcome = pendingOutcome;
        pendingOutcome = undefined;
        finish(outcome);
    };
    const close = (error) => {
        if (closed)
            return;
        closed = true;
        pendingOutcome = error === undefined ? {} : { error };
        completeClose();
    };
    const outcome = await ctx.ui.custom((tui, theme, keybindings, done) => {
        ownerTui = tui;
        finish = done;
        component = createComponent(tui, theme, keybindings, () => close());
        component.focused = handle?.isFocused() ?? true;
        return component;
    }, {
        overlay: true,
        overlayOptions: {
            width: "78%",
            minWidth: 72,
            maxHeight: "78%",
            anchor: "top-center",
            margin: { top: 1, left: 2, right: 2 },
            nonCapturing: true,
        },
        onHandle: (overlayHandle) => {
            handle = overlayHandle;
            handle.focus();
            if (component)
                component.focused = handle.isFocused();
            completeClose();
        },
    });
    if (outcome.error !== undefined)
        throw outcome.error;
}
