/**
 * Recursive character text splitter.
 *
 * Port of `langchain_text_splitters.RecursiveCharacterTextSplitter` with the
 * defaults the source constructs it with (`chunk_size=1000`,
 * `chunk_overlap=100`, `keep_separator=True`, `strip_whitespace=True`,
 * `separators=["\n\n", "\n", " ", ""]`). The algorithm is copied from
 * `_split_text`, `_merge_splits`, `_split_text_with_regex` and `_join_docs`, so
 * chunk boundaries land where the source's did — chunk boundaries decide what
 * context the model sees, so an "equivalent" splitter would silently change
 * report quality.
 *
 * @module @yf-river/dsh-gpt-research/text-splitter
 */

import { Document } from './documents.js'

const DEFAULT_SEPARATORS = Object.freeze(['\n\n', '\n', ' ', ''])

const logger = {
  warning: (...args) => console.warn(...args),
}

/**
 * Escape a literal separator for use inside a RegExp.
 * @param {string} text - literal text.
 * @returns {string} escaped text.
 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Split `text` on `separator`, keeping separators attached to the following piece.
 *
 * Mirrors `_split_text_with_regex(text, separator, keep_separator=True)`:
 * `re.split(f"({separator})", text)` yields `[text, sep, text, sep, ...]`, and
 * each piece becomes `sep + followingText`, with the leading text kept in front.
 *
 * An empty separator splits into individual characters.
 *
 * @param {string} text - input text.
 * @param {string} separator - literal separator.
 * @returns {string[]} non-empty pieces.
 */
function splitTextWithRegex(text, separator) {
  if (separator === '') return [...text].filter((char) => char !== '')
  const parts = text.split(new RegExp(`(${escapeRegExp(separator)})`))
  const splits = []
  for (let index = 1; index < parts.length - 1; index += 2) {
    splits.push(parts[index] + (parts[index + 1] ?? ''))
  }
  if (parts.length % 2 === 0) splits.push(parts[parts.length - 1])
  const withLead = [parts[0], ...splits]
  return withLead.filter((piece) => piece !== '')
}

/** Splitter with the source's defaults. */
export class RecursiveCharacterTextSplitter {
  /**
   * @param {{chunkSize?: number, chunkOverlap?: number, separators?: string[], keepSeparator?: boolean, stripWhitespace?: boolean}} [options]
   *   splitter options; defaults match the source's construction.
   */
  constructor(options = {}) {
    /** @type {number} */
    this.chunkSize = options.chunkSize ?? 1000
    /** @type {number} */
    this.chunkOverlap = options.chunkOverlap ?? 200
    /** @type {string[]} */
    this.separators = [...(options.separators ?? DEFAULT_SEPARATORS)]
    /** @type {boolean} */
    this.keepSeparator = options.keepSeparator ?? true
    /** @type {boolean} */
    this.stripWhitespace = options.stripWhitespace ?? true
  }

  /**
   * Join pieces into one chunk, stripping whitespace as configured.
   * @param {string[]} docs - pieces.
   * @param {string} separator - joiner.
   * @returns {string | null} the chunk, or `null` when empty.
   */
  joinDocs(docs, separator) {
    let text = docs.join(separator)
    if (this.stripWhitespace) text = text.trim()
    return text === '' ? null : text
  }

  /**
   * Merge small pieces into chunks of at most `chunkSize`, with `chunkOverlap`.
   * @param {string[]} splits - pieces.
   * @param {string} separator - joiner used for these pieces.
   * @returns {string[]} chunks.
   */
  mergeSplits(splits, separator) {
    const separatorLen = separator.length
    const docs = []
    let currentDoc = []
    let total = 0

    for (const piece of splits) {
      const pieceLen = piece.length
      const added = separatorLen && currentDoc.length > 0 ? separatorLen : 0
      if (total + pieceLen + added > this.chunkSize) {
        if (total > this.chunkSize) {
          logger.warning(`Created a chunk of size ${total}, which is longer than the specified ${this.chunkSize}`)
        }
        if (currentDoc.length > 0) {
          const doc = this.joinDocs(currentDoc, separator)
          if (doc !== null) docs.push(doc)
          // Keep on popping while the chunk is larger than the overlap, or while
          // the next piece still would not fit.
          while (
            total > this.chunkOverlap
            || (total + pieceLen + (separatorLen && currentDoc.length > 0 ? separatorLen : 0) > this.chunkSize && total > 0)
          ) {
            total -= currentDoc[0].length + (currentDoc.length > 1 ? separatorLen : 0)
            currentDoc = currentDoc.slice(1)
          }
        }
      }
      currentDoc.push(piece)
      total += pieceLen + (currentDoc.length > 1 ? separatorLen : 0)
    }

    const doc = this.joinDocs(currentDoc, separator)
    if (doc !== null) docs.push(doc)
    return docs
  }

  /**
   * Split one text block, choosing the coarsest separator present.
   * @param {string} text - input text.
   * @param {string[]} [separators] - candidate separators, coarsest first.
   * @returns {string[]} chunks.
   */
  splitText(text, separators = this.separators) {
    const finalChunks = []
    let separator = separators[separators.length - 1]
    let newSeparators = []
    for (let index = 0; index < separators.length; index += 1) {
      const candidate = separators[index]
      if (candidate === '') {
        separator = candidate
        break
      }
      if (text.includes(candidate)) {
        separator = candidate
        newSeparators = separators.slice(index + 1)
        break
      }
    }

    const splits = splitTextWithRegex(text, separator)
    const joinSeparator = this.keepSeparator ? '' : separator

    let goodSplits = []
    for (const piece of splits) {
      if (piece.length < this.chunkSize) {
        goodSplits.push(piece)
        continue
      }
      if (goodSplits.length > 0) {
        finalChunks.push(...this.mergeSplits(goodSplits, joinSeparator))
        goodSplits = []
      }
      if (newSeparators.length === 0) {
        finalChunks.push(piece)
      } else {
        finalChunks.push(...this.splitText(piece, newSeparators))
      }
    }
    if (goodSplits.length > 0) {
      finalChunks.push(...this.mergeSplits(goodSplits, joinSeparator))
    }
    return finalChunks
  }

  /**
   * Split documents into chunk documents, preserving metadata.
   * @param {Document[]} documents - documents to split.
   * @returns {Document[]} chunk documents.
   */
  splitDocuments(documents) {
    const output = []
    for (const document of documents) {
      for (const chunk of this.splitText(document.pageContent)) {
        output.push(new Document({ pageContent: chunk, metadata: { ...document.metadata } }))
      }
    }
    return output
  }
}
