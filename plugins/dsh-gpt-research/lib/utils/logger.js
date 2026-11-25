/**
 * Logger construction and coloured formatting.
 *
 * One-to-one port of `gpt_researcher/utils/logger.py`, minus `click.style`:
 * colouring is expressed with the same ANSI SGR codes `click.style` emits, so
 * terminal output matches while the plugin stays dependency-free.
 *
 * Node's `console` has no `logging` hierarchy, so {@link getFormattedLogger}
 * returns a small record with `info` / `warning` / `error` / `debug` /
 * `critical` / `trace` methods that the ported pipeline calls by name.
 *
 * @module @yf-river/dsh-gpt-research/utils/logger
 */

import process from 'node:process'

/** Custom TRACE level, below DEBUG, as in the source. */
export const TRACE_LOG_LEVEL = 5

/** ANSI styles matching `click.style` fg names used by the source. */
const ANSI = Object.freeze({
  blue: '\u001B[34m',
  cyan: '\u001B[36m',
  green: '\u001B[32m',
  yellow: '\u001B[33m',
  red: '\u001B[31m',
  brightRed: '\u001B[91m',
  reset: '\u001B[0m',
})

/** Level number → colour, mirroring `level_name_colors`. */
const LEVEL_NAME_COLORS = Object.freeze(new Map([
  [TRACE_LOG_LEVEL, ANSI.blue],
  [10, ANSI.cyan], // DEBUG
  [20, ANSI.green], // INFO
  [30, ANSI.yellow], // WARNING
  [40, ANSI.red], // ERROR
  [50, ANSI.brightRed], // CRITICAL
]))

/** Numeric levels used by the ported call sites. */
const LEVELS = Object.freeze({
  trace: TRACE_LOG_LEVEL,
  debug: 10,
  info: 20,
  warning: 30,
  error: 40,
  critical: 50,
})

/** Level number → upper-case name, as Python's `LogRecord.levelname`. */
const LEVEL_NAMES = Object.freeze({
  [TRACE_LOG_LEVEL]: 'TRACE',
  10: 'DEBUG',
  20: 'INFO',
  30: 'WARNING',
  40: 'ERROR',
  50: 'CRITICAL',
})

/**
 * Colour a level name the way `ColourizedFormatter.formatMessage` does.
 *
 * @param {string} levelName - the level's name.
 * @param {number} levelNo - the level's number.
 * @param {boolean} useColors - whether to emit SGR codes.
 * @returns {string} the (possibly coloured) level name.
 */
export function colorLevelName(levelName, levelNo, useColors) {
  if (!useColors) return String(levelName)
  const color = LEVEL_NAME_COLORS.get(levelNo)
  return color === undefined ? String(levelName) : `${color}${levelName}${ANSI.reset}`
}

/**
 * Build the `levelprefix` the source's formatter injects.
 *
 * The source pads with `" " * (8 - len(levelname))` then appends `":"`.
 *
 * @param {string} levelName - the level's name.
 * @param {number} levelNo - the level's number.
 * @param {boolean} useColors - whether to emit SGR codes.
 * @returns {string} the level prefix, e.g. `INFO:   `.
 */
export function levelPrefix(levelName, levelNo, useColors) {
  const colored = colorLevelName(levelName, levelNo, useColors)
  return `${colored}:${' '.repeat(8 - levelName.length)}`
}

/**
 * Format one record as the source's `DefaultFormatter` would.
 *
 * @param {number} levelNo - numeric level.
 * @param {string} message - message text.
 * @param {{ useColors?: boolean, now?: Date }} [options] - colour toggle and clock.
 * @returns {string} formatted line, `HH:MM:SS` timestamp included.
 */
export function formatRecord(levelNo, message, options = {}) {
  const levelName = LEVEL_NAMES[levelNo] ?? String(levelNo)
  const useColors = options.useColors ?? process.stderr.isTTY === true
  const now = options.now ?? new Date()
  const timestamp = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':')
  return `${levelPrefix(levelName, levelNo, useColors)} [${timestamp}] ${message}`
}

/**
 * Create one logger record.
 *
 * Levels below the configured threshold are dropped, matching `logger.setLevel`.
 *
 * @param {{ name?: string, level?: number, useColors?: boolean, sink?: (line: string) => void }} [options]
 *   logger name, threshold, colour toggle, and output sink.
 * @returns {{trace: Function, debug: Function, info: Function, warning: Function, error: Function, critical: Function, level: number, name: string}}
 *   a logger with the source's method names.
 */
export function createLogger(options = {}) {
  const level = options.level ?? LEVELS.info
  const useColors = options.useColors ?? process.stderr.isTTY === true
  const sink = options.sink ?? ((line) => { process.stderr.write(`${line}\n`) })
  const name = options.name ?? 'scraper'

  const emit = (levelNo, args) => {
    if (levelNo < level) return
    const message = args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')
    sink(formatRecord(levelNo, message, { useColors }))
  }

  return {
    name,
    level,
    trace: (...args) => emit(LEVELS.trace, args),
    debug: (...args) => emit(LEVELS.debug, args),
    info: (...args) => emit(LEVELS.info, args),
    warning: (...args) => emit(LEVELS.warning, args),
    error: (...args) => emit(LEVELS.error, args),
    critical: (...args) => emit(LEVELS.critical, args),
  }
}

/** Cached logger for the shared `scraper` name, matching the source's module logger. */
let scraperLogger = null

/**
 * Return a formatted logger.
 *
 * Source behaviour: one `scraper` logger, INFO level, a single handler, no
 * propagation. The port returns the same cached record and never installs a
 * second sink.
 *
 * @returns {ReturnType<typeof createLogger>} the cached logger.
 */
export function getFormattedLogger() {
  if (scraperLogger === null) {
    scraperLogger = createLogger({ name: 'scraper', level: LEVELS.info })
  }
  return scraperLogger
}
