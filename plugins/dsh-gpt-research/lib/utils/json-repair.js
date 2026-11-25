/**
 * Tolerant JSON parsing.
 *
 * The source calls `json_repair.loads` in `query_processing`, `agent_creator`
 * and (for env values) `Config.convert_env_value`. Node has no equivalent
 * library and the plugin ships no dependencies, so this reproduces the repairs
 * that matter for LLM output and hand-edited env values:
 *
 * - fenced code blocks (```` ```json ... ``` ````)
 * - leading/trailing prose around the JSON value
 * - single-quoted strings
 * - trailing commas before `}` or `]`
 * - bare object keys
 * - `None` / `True` / `False` → `null` / `true` / `false`
 * - newlines and control characters inside strings
 *
 * Anything still invalid throws, which is what `json_repair.loads` does for
 * unrecoverable input; callers treat the throw as "no usable JSON".
 *
 * @module @yf-river/dsh-gpt-research/utils/json-repair
 */

/** Convert a single-quoted region to a double-quoted one. */
function normalizeQuotes(text) {
  let out = ''
  let inDouble = false
  let inSingle = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '\\') {
      out += char + (text[index + 1] ?? '')
      index += 1
      continue
    }
    if (inDouble) {
      if (char === '"') inDouble = false
      out += char
      continue
    }
    if (inSingle) {
      if (char === '\'') {
        inSingle = false
        out += '"'
        continue
      }
      out += char === '"' ? '\\"' : char
      continue
    }
    if (char === '"') {
      inDouble = true
      out += char
      continue
    }
    if (char === '\'') {
      inSingle = true
      out += '"'
      continue
    }
    out += char
  }
  return out
}

/** Drop trailing commas before a closing brace or bracket. */
function dropTrailingCommas(text) {
  return text.replace(/,(\s*[}\]])/g, '$1')
}

/** Quote bare object keys. */
function quoteBareKeys(text) {
  return text.replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3')
}

/** Replace Python literals outside strings. */
function normalizeLiterals(text) {
  return text
    .replace(/\bNone\b/g, 'null')
    .replace(/\bTrue\b/g, 'true')
    .replace(/\bFalse\b/g, 'false')
}

/** Escape raw newlines that appear inside a double-quoted string. */
function escapeInnerNewlines(text) {
  let out = ''
  let inDouble = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '\\') {
      out += char + (text[index + 1] ?? '')
      index += 1
      continue
    }
    if (char === '"') {
      inDouble = !inDouble
      out += char
      continue
    }
    if (inDouble && char === '\n') {
      out += '\\n'
      continue
    }
    if (inDouble && char === '\r') continue
    if (inDouble && char === '\t') {
      out += '\\t'
      continue
    }
    out += char
  }
  return out
}

/**
 * Strip a fenced code block and surrounding prose, leaving the JSON value.
 * @param {string} text - candidate text.
 * @returns {string} the innermost plausible JSON span.
 */
function extractJsonSpan(text) {
  const fenced = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(text)
  const body = fenced === null ? text : fenced[1]
  const firstObject = body.indexOf('{')
  const firstArray = body.indexOf('[')
  const starts = [firstObject, firstArray].filter((index) => index >= 0)
  if (starts.length === 0) return body.trim()
  const start = Math.min(...starts)
  // Prefer the last matching closer so nested values stay complete.
  const closer = body[start] === '{' ? '}' : ']'
  const end = body.lastIndexOf(closer)
  if (end <= start) return body.slice(start).trim()
  return body.slice(start, end + 1).trim()
}

/**
 * Parse a possibly-broken JSON value.
 *
 * @param {string | null | undefined} input - the text to parse.
 * @returns {unknown} the parsed value.
 * @throws {Error} when the text cannot be repaired into valid JSON.
 */
export function jsonRepairLoads(input) {
  if (input === null || input === undefined) throw new Error('empty input')
  const raw = String(input).trim()
  if (raw === '') throw new Error('empty input')

  // Fast path: already valid JSON.
  try {
    return JSON.parse(raw)
  } catch {
    // Fall through to the repair passes.
  }

  let candidate = extractJsonSpan(raw)
  candidate = normalizeLiterals(candidate)
  candidate = dropTrailingCommas(quoteBareKeys(normalizeQuotes(candidate)))
  candidate = escapeInnerNewlines(candidate)
  candidate = dropTrailingCommas(candidate)
  return JSON.parse(candidate)
}
