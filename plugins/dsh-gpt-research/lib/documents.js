/**
 * Document: the two-field record the source passes between retrieval, chunking,
 * filtering and prompt rendering.
 *
 * The source uses LangChain's `Document(page_content, metadata)` throughout the
 * context layer. DSH has no LangChain, so this is the same two fields with the
 * same attribute names, which keeps every ported call site textually identical.
 *
 * @module @yf-river/dsh-gpt-research/documents
 */

/** One document: its text plus source metadata. */
export class Document {
  /**
   * @param {{pageContent?: string, metadata?: Record<string, unknown>}} [init] - fields.
   *   `pageContent` may also be passed as `page_content` for a literal port.
   */
  constructor(init = {}) {
    /** @type {string} The document's text. */
    this.pageContent = init.pageContent ?? init.page_content ?? ''
    /** @type {Record<string, unknown>} Source metadata (`title`, `source`, or `section_title`). */
    this.metadata = init.metadata ?? {}
  }
}

