/**
 * Markdown report post-processing.
 *
 * One-to-one port of `gpt_researcher/actions/markdown_processing.py`: the
 * heading tree, the section splitter, the table of contents and the reference
 * list. The source parsed its own Markdown with Python-Markdown into HTML and
 * then walked the tags; this port renders the same HTML (see
 * `./markdown.js`) and walks it with the same regexes, so the extracted
 * structure matches.
 *
 * @module @yf-river/dsh-gpt-research/actions/markdown-processing
 */

import { markdownToHtml } from './markdown.js'

/**
 * Decode the entities Python-Markdown emits, mirroring `html.unescape` for the
 * subset a report can contain.
 * @param {string} text - HTML-escaped text.
 * @returns {string} decoded text.
 */
function unescapeHtml(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, '\'')
    .replace(/&#39;/g, '\'')
    .replace(/&amp;/g, '&')
}

/**
 * Escape text for inclusion in the table of contents, mirroring `html.escape(s, quote=False)`.
 * @param {string} text - raw text.
 * @returns {string} escaped text.
 */
function escapeNoQuote(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Extract the heading tree from Markdown.
 *
 * The source rendered to HTML, walked lines starting with `<h{n}>`, stripped
 * inner tags, then `html.unescape`d, and built a tree by popping the stack
 * while the top level is not less than the new one.
 *
 * @param {string} markdownText - the Markdown source.
 * @returns {Array<{level: number, text: string, children?: Array<object>}>} the heading tree.
 */
export function extractHeaders(markdownText) {
  if (typeof markdownText !== 'string' || markdownText === '') return []
  const parsed = markdownToHtml(markdownText)
  const headers = []
  const stack = []

  for (const line of parsed.split('\n')) {
    if (!line.startsWith('<h') || line.length <= 2 || !/^\d$/.test(line[2])) continue
    const level = Number.parseInt(line[2], 10)
    const start = line.indexOf('>')
    const end = line.lastIndexOf('<')
    if (start < 0 || end <= start) continue
    const rawHeader = line.slice(start + 1, end)
    const headerText = unescapeHtml(rawHeader.replace(/<.*?>/gs, '')).trim()

    while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop()

    /** @type {{level: number, text: string, children?: Array<object>}} */
    const header = { level, text: headerText }
    if (stack.length > 0) {
      const parent = stack[stack.length - 1]
      if (parent.children === undefined) parent.children = []
      parent.children.push(header)
    } else {
      headers.push(header)
    }
    stack.push(header)
  }

  return headers
}

/**
 * Extract every written section from a (subtopic) report.
 *
 * @param {string} markdownText - the report text.
 * @returns {Array<{section_title: string, written_content: string}>} sections.
 */
export function extractSections(markdownText) {
  if (typeof markdownText !== 'string' || markdownText === '') return []
  const parsed = markdownToHtml(markdownText)
  const sections = []
  const pattern = /<h\d>(.*?)<\/h\d>(.*?)(?=<h\d>|$)/gs

  for (const match of parsed.matchAll(pattern)) {
    const title = match[1]
    const content = match[2]
    // Decode after stripping tags so escaped code such as `&lt;tag&gt;` remains
    // visible text rather than being mistaken for HTML markup.
    const cleanContent = unescapeHtml(content.replace(/<.*?>/gs, '')).trim()
    if (cleanContent !== '') {
      sections.push({
        section_title: unescapeHtml(title.replace(/<.*?>/gs, '')).trim(),
        written_content: cleanContent,
      })
    }
  }

  return sections
}

/**
 * Render a table of contents from the heading tree.
 *
 * @param {Array<object>} headers - heading tree.
 * @param {number} [indentLevel] - current depth.
 * @returns {string} nested bullet list.
 */
function generateTableOfContents(headers, indentLevel = 0) {
  let toc = ''
  for (const header of headers) {
    toc += `${' '.repeat(indentLevel * 4)}- ${escapeNoQuote(header.text)}\n`
    if (header.children !== undefined) {
      toc += generateTableOfContents(header.children, indentLevel + 1)
    }
  }
  return toc
}

/**
 * Generate a table of contents for Markdown text.
 *
 * @param {string} markdownText - the Markdown source.
 * @returns {string} the table of contents, or the input when extraction fails.
 */
export function tableOfContents(markdownText) {
  if (typeof markdownText !== 'string') return ''
  try {
    const headers = extractHeaders(markdownText)
    return `## Table of Contents\n\n${generateTableOfContents(headers)}`
  } catch (error) {
    console.log('table_of_contents Exception : ', error)
    return markdownText
  }
}

/**
 * Append a deterministic reference list.
 *
 * The source sorted `visited_urls`, because a Python set's iteration order is
 * not stable and the References section must be reproducible for the same
 * inputs.
 *
 * @param {string | null} reportMarkdown - the existing report.
 * @param {Set<string> | Array<string> | null} visitedUrls - visited URLs.
 * @returns {string} the report with references appended.
 */
export function addReferences(reportMarkdown, visitedUrls) {
  let report = reportMarkdown
  if (typeof report !== 'string') report = report === null || report === undefined ? '' : String(report)
  if (visitedUrls === null || visitedUrls === undefined) return report
  try {
    let urlMarkdown = '\n\n\n## References\n\n'
    const sorted = [...visitedUrls].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    urlMarkdown += sorted.map((url) => `- [${url}](${url})\n`).join('')
    return report + urlMarkdown
  } catch (error) {
    console.log(`Encountered exception in adding source urls : ${error}`)
    return report
  }
}
