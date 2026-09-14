/** Migration output context that expands compact runs into retained events. */
export class SessionFormatEventCollector {
    /** Events retained by this collector in source order. */
    values = [];
    /**
     * Retain one settled event.
     * @param event - settled event emitted by the upstream stage.
     */
    emitEvent(event) {
        this.values.push(event);
    }
    /**
     * Expand one compact run directly into retained events.
     * @param run - compact event run emitted by the upstream stage.
     */
    emitRun(run) {
        for (const event of run.expand())
            this.values.push(event);
    }
}
//# sourceMappingURL=context.js.map