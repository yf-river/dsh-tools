/**
 * Markdown → HTML, matching Python-Markdown's output for report content.
 *
 * `markdown_processing.py` parses HTML, not Markdown: it runs the report through
 * `markdown.markdown(text, extensions=["fenced_code"])` and then extracts
 * headings and sections from the resulting tags. The report's structure
 * therefore depends on Python-Markdown's exact output, so this module
 * reproduces that output rather than producing "equivalent" HTML.
 *
 * Covered constructs (everything a research report contains): ATX and setext
 * headings, paragraphs with inline formatting, fenced and indented code,
 * bullet/ordered lists, blockquotes, horizontal rules, links, images, escapes
 * and hard line breaks.
 *
 * Not covered: reference-style links, footnote/table/attribute extensions, raw
 * HTML blocks. Python-Markdown passes raw HTML through unchanged; this module
 * escapes it, so a report containing literal HTML differs here. That is
 * documented rather than silently accepted: `markdownToHtml` output is only
 * consumed by tag-stripping, where an escaped tag contributes its text.
 *
 * @module @yf-river/dsh-gpt-research/actions/markdown
 */

/**
 * Escape text the way Python-Markdown escapes literal characters.
 *
 * Existing character entities are left alone: Python-Markdown does not
 * double-escape `&amp;`, and a report that already carries entities must not
 * come out as `&amp;amp;`.
 *
 * @param {string} text - raw text.
 * @returns {string} HTML-escaped text.
 */
function escapeHtml(text) {
  return text
    // Ampersands that do not already start a character entity.
    .replace(/&(?!(?:[A-Za-z][A-Za-z0-9]{1,31}|#\d{1,7}|#[xX][0-9A-Fa-f]{1,6});)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Escape text for a paragraph, keeping the inline-format placeholders intact.
 *
 * Inline formatting is applied first, so tags introduced by it must survive
 * escaping. Placeholders keep the ordering explicit.
 *
 * @param {string} text - text with `\u0000n\u0000` inline placeholders.
 * @returns {string} escaped text.
 */
function escapePreservingPlaceholders(text) {
  return escapeHtml(text).replace(/\u0000(\d+)\u0000/g, '\u0000$1\u0000')
}

/**
 * Render inline formatting inside one block of text.
 *
 * Order follows Python-Markdown: code spans first (their content is literal),
 * then images, links, strong, emphasis, escapes.
 *
 * @param {string} text - raw inline text.
 * @returns {string} HTML inline content.
 */
function renderInline(text) {
  const placeholders = []
  const hold = (html) => {
    placeholders.push(html)
    return `\u0000${placeholders.length - 1}\u0000`
  }

  let out = String(text)

  // Backslash escapes: the escaped character becomes literal text.
  out = out.replace(/\\([\\`*_{}[\]()#+\-.!>])/g, (_match, char) => hold(escapeHtml(char)))

  // Code spans: `` `code` `` and longer fences. Content is literal.
  out = out.replace(/(`+)([\s\S]*?)\1/g, (_match, _fence, code) => {
    const trimmed = /^ .* $/.test(code) && code.trim() !== '' ? code.slice(1, -1) : code
    return hold(`<code>${escapeHtml(trimmed)}</code>`)
  })

  // Images before links: `![alt](src "title")`.
  out = out.replace(/!\[([^\]]*)\]\(\s*([^\s)]+)(?:\s+"([^"]*)")?\s*\)/g, (_match, alt, src, title) => {
    const titleAttr = title === undefined ? '' : ` title="${escapeHtml(title)}"`
    return hold(`<img alt="${escapeHtml(alt)}" src="${escapeHtml(src)}"${titleAttr} />`)
  })

  // Links: `[text](href "title")`.
  out = out.replace(/\[([^\]]*)\]\(\s*([^\s)]+)(?:\s+["']([^"']*)["'])?\s*\)/g, (_match, label, href, title) => {
    const titleAttr = title === undefined ? '' : ` title="${escapeHtml(title)}"`
    return hold(`<a href="${escapeHtml(href)}"${titleAttr}>${renderInline(label)}</a>`)
  })

  // Strong before emphasis, and `**`/`__` before `*`/`_`.
  out = out.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, (_match, _marker, body) => hold(`<strong>${renderInline(body)}</strong>`))
  out = out.replace(/(\*|_)(?=\S)([\s\S]*?\S)\1/g, (_match, _marker, body) => hold(`<em>${renderInline(body)}</em>`))

  out = escapePreservingPlaceholders(out)
  return out.replace(/\u0000(\d+)\u0000/g, (_match, index) => placeholders[Number(index)])
}

/** `h1`–`h6` ATX heading, with the optional space and optional closing hashes. */
const ATX_RE = /^(#{1,6})(?!#)\s*([\s\S]*?)\s*#*\s*$/
/** Fenced code opener. */
const FENCE_RE = /^([ \t]*)(`{3,}|~{3,})\s*([^\s`]*)\s*$/
/** Bullet list item. */
const BULLET_RE = /^[ \t]*[-*+][ \t]+(.*)$/
/** Ordered list item. */
const ORDERED_RE = /^[ \t]*(\d+)[.)][ \t]+(.*)$/
/** Horizontal rule. */
const HR_RE = /^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/
/** Blockquote line. */
const QUOTE_RE = /^[ \t]*>[ \t]?(.*)$/
/** Setext underline. */
const SETEXT_RE = /^[ \t]*(=+|-{2,})[ \t]*$/
/** Two trailing spaces mark a hard break. */
const HARDBREAK_RE = / {2,}$/

/**
 * Whether a line starts a new block, used to end a paragraph.
 * @param {string} line - the line.
 * @returns {boolean} `true` when the line opens a new block.
 */
function startsBlock(line) {
  return ATX_RE.test(line)
    || FENCE_RE.test(line)
    || BULLET_RE.test(line)
    || ORDERED_RE.test(line)
    || HR_RE.test(line)
    || QUOTE_RE.test(line)
}

/**
 * Render one list (bullet or ordered) starting at `index`.
 * @param {string[]} lines - all lines.
 * @param {number} index - index of the first item.
 * @param {RegExp} itemRe - the item pattern to match.
 * @returns {{html: string, next: number}} rendered list and the next index.
 */
function renderList(lines, index, itemRe) {
  const tag = itemRe === ORDERED_RE ? 'ol' : 'ul'
  const items = []
  let cursor = index
  while (cursor < lines.length) {
    const match = itemRe.exec(lines[cursor])
    if (match === null) break
    const text = itemRe === ORDERED_RE ? match[2] : match[1]
    items.push(`<li>${renderInline(text.trim())}</li>`)
    cursor += 1
    // Continuation lines that are indented belong to the same list.
    while (cursor < lines.length && /^[ \t]{2,}\S/.test(lines[cursor])) {
      const continuation = lines[cursor].trim()
      items[items.length - 1] = items[items.length - 1].replace(/<\/li>$/, ` ${renderInline(continuation)}</li>`)
      cursor += 1
    }
  }
  return { html: `<${tag}>\n${items.join('\n')}\n</${tag}>`, next: cursor }
}

/**
 * Convert Markdown to HTML the way `markdown.markdown(text, extensions=["fenced_code"])` does.
 *
 * @param {string} markdownText - the Markdown source.
 * @returns {string} HTML.
 */
export function markdownToHtml(markdownText) {
  if (typeof markdownText !== 'string' || markdownText === '') return ''
  const lines = markdownText.replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]

    if (line.trim() === '') {
      index += 1
      continue
    }

    // Fenced code block.
    const fence = FENCE_RE.exec(line)
    if (fence !== null) {
      const marker = fence[2]
      const language = fence[3]
      const body = []
      index += 1
      while (index < lines.length && !new RegExp(`^[ \\t]*${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`).test(lines[index])) {
        body.push(lines[index])
        index += 1
      }
      index += 1 // closing fence
      const classAttr = language ? ` class="language-${escapeHtml(language)}"` : ''
      blocks.push(`<pre><code${classAttr}>${escapeHtml(body.length > 0 ? `${body.join('\n')}\n` : '')}</code></pre>`)
      continue
    }

    // Indented code block.
    if (/^ {4}/.test(line)) {
      const body = []
      while (index < lines.length && (/^ {4}/.test(lines[index]) || lines[index].trim() === '')) {
        body.push(lines[index].slice(4))
        index += 1
      }
      while (body.length > 0 && body[body.length - 1].trim() === '') body.pop()
      blocks.push(`<pre><code>${escapeHtml(`${body.join('\n')}\n`)}</code></pre>`)
      continue
    }

    // ATX heading.
    const atx = ATX_RE.exec(line)
    if (atx !== null) {
      const level = atx[1].length
      blocks.push(`<h${level}>${renderInline(atx[2])}</h${level}>`)
      index += 1
      continue
    }

    // Horizontal rule (before setext, so `---` alone is a rule).
    if (HR_RE.test(line)) {
      blocks.push('<hr />')
      index += 1
      continue
    }

    // Blockquote.
    if (QUOTE_RE.test(line)) {
      const body = []
      while (index < lines.length && QUOTE_RE.test(lines[index])) {
        body.push(QUOTE_RE.exec(lines[index])[1])
        index += 1
      }
      const inner = markdownToHtml(body.join('\n'))
      blocks.push(`<blockquote>\n${inner}\n</blockquote>`)
      continue
    }

    // Bullet or ordered list.
    if (BULLET_RE.test(line)) {
      const rendered = renderList(lines, index, BULLET_RE)
      blocks.push(rendered.html)
      index = rendered.next
      continue
    }
    if (ORDERED_RE.test(line)) {
      const rendered = renderList(lines, index, ORDERED_RE)
      blocks.push(rendered.html)
      index = rendered.next
      continue
    }

    // Setext heading: the next line underlines this one.
    if (index + 1 < lines.length) {
      const underline = SETEXT_RE.exec(lines[index + 1])
      if (underline !== null && line.trim() !== '') {
        const level = underline[1].startsWith('=') ? 1 : 2
        blocks.push(`<h${level}>${renderInline(line.trim())}</h${level}>`)
        index += 2
        continue
      }
    }

    // Paragraph: consecutive lines until a blank line or a new block.
    const paragraph = [line]
    index += 1
    while (index < lines.length && lines[index].trim() !== '' && !startsBlock(lines[index])) {
      // A setext underline closes the paragraph.
      if (SETEXT_RE.test(lines[index])) break
      paragraph.push(lines[index])
      index += 1
    }
    const rendered = paragraph
      .map((piece, position) => {
        const hardBreak = HARDBREAK_RE.test(piece) && position < paragraph.length - 1
        return `${renderInline(piece.replace(HARDBREAK_RE, ''))}${hardBreak ? '<br />' : ''}`
      })
      .join('\n')
    blocks.push(`<p>${rendered}</p>`)
  }

  return blocks.join('\n')
}
