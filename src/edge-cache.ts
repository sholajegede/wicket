/** The Cache API of the data center this code runs in. It is not shared with other data centers. */
export const edgeCache = (): Cache => (caches as unknown as { default: Cache }).default;

export type Ctx = Pick<ExecutionContext, "waitUntil">;
