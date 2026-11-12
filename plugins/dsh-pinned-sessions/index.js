/**
 * Host half of the pinned-session bar bundle.
 *
 * The bar is a pure Client renderer: it reads the Workspace pin set that the
 * Host already streams and calls the existing pin/unpin entry points. Nothing
 * new is persisted here, so the Host contributes no service, tool, or state.
 * @returns nothing; the bundle exists for its Client module.
 */
export function apply() {}
