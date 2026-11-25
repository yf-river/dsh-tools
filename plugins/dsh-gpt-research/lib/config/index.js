/**
 * Configuration manager.
 *
 * One-to-one port of `gpt_researcher/config/config.py`. Every method keeps its
 * source name, order of operations and failure behaviour:
 *
 *   __init__: loadConfig → _setAttributes → _setEmbeddingAttributes
 *             → _setLlmAttributes → _handleDeprecatedAttributes
 *             → _setDocPath when the report source is not `web`
 *
 * Differences are mechanical only, forced by the language:
 * - Python attribute names are lowercased keys (`self.breadth` for
 *   `DEEP_RESEARCH_BREADTH`); JS uses the same lowercased names on the instance.
 * - `TypedDict` annotations become {@link BASE_CONFIG_TYPES} lookups.
 * - `json_repair` becomes {@link jsonRepairLoads}.
 * - `warnings.warn(...)` becomes `logger.warn(...)` because a plugin has no
 *   warning channel; the conditions that fire it are unchanged.
 *
 * @module @yf-river/dsh-gpt-research/config
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BASE_CONFIG_TYPES } from './variables/base.js'
import { DEFAULT_CONFIG } from './variables/default.js'
import { LLM_PROVIDERS, REASONING_EFFORT_VALUES, ReasoningEfforts } from './providers.js'
import { jsonRepairLoads } from '../utils/json-repair.js'

/** Directory holding the bundled `*.json` config presets. */
const CONFIG_DIR = join(dirname(fileURLToPath(import.meta.url)), 'variables')

/** Structured deep-copy for config values, so mutable defaults never leak. */
function deepcopy(value) {
  if (Array.isArray(value)) return value.map(deepcopy)
  if (value !== null && typeof value === 'object') {
    const copy = {}
    for (const [key, inner] of Object.entries(value)) copy[key] = deepcopy(inner)
    return copy
  }
  return value
}

/** Minimal logger surface; the host injects its own, tests may pass a stub. */
const defaultLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
}

/**
 * Resolve the effective retrievers list from a comma-separated string.
 *
 * Valid names come from the retriever registry in the source. The port has no
 * retriever registry (retrieval goes through `ctx.web`), so this validates
 * shape only and preserves the source's fallback-to-`tavily` behaviour.
 *
 * @param {string} retrieverStr - comma-separated retriever names.
 * @param {(names: string[]) => void} [warn] - warning sink.
 * @returns {string[]} the parsed names.
 */
function parseRetrievers(retrieverStr, warn = defaultLogger.warn) {
  const retrievers = String(retrieverStr).split(',').map((item) => item.trim())
  if (retrievers.some((item) => item.length === 0)) {
    warn('Warning: empty retriever name found. Defaulting to \'tavily\' retriever.')
    return ['tavily']
  }
  return retrievers
}

/**
 * Parse `"<provider>:<model>"`.
 * @param {string | null} llmStr - the configured value.
 * @returns {[string | null, string | null]} `[provider, model]`.
 * @throws {Error} on a missing colon or an unsupported provider.
 */
function parseLlm(llmStr) {
  if (llmStr === null || llmStr === undefined) return [null, null]
  const separator = llmStr.indexOf(':')
  if (separator < 0) {
    throw new Error('Set SMART_LLM or FAST_LLM = \'<llm_provider>:<llm_model>\' Eg \'openai:gpt-4o-mini\'')
  }
  const provider = llmStr.slice(0, separator)
  const model = llmStr.slice(separator + 1)
  if (!LLM_PROVIDERS.includes(provider)) {
    throw new Error(`Unsupported ${provider}.\nSupported llm providers are: ${LLM_PROVIDERS.join(', ')}`)
  }
  return [provider, model]
}

/**
 * Validate a reasoning-effort value.
 * @param {string | null} effort - the configured value.
 * @returns {string} a valid effort level.
 * @throws {Error} when the value is not one of the three levels.
 */
function parseReasoningEffort(effort) {
  if (effort === null || effort === undefined) return ReasoningEfforts.Medium
  if (!REASONING_EFFORT_VALUES.includes(effort)) {
    throw new Error(`Invalid reasoning effort: ${effort}. Valid options are: ${REASONING_EFFORT_VALUES.join(', ')}`)
  }
  return effort
}

/**
 * Parse `"<provider>:<model>"` for embeddings.
 * @param {string | null} embeddingStr - the configured value.
 * @returns {[string | null, string | null]} `[provider, model]`.
 * @throws {Error} on a missing colon or an unsupported provider.
 */
function parseEmbedding(embeddingStr) {
  if (embeddingStr === null || embeddingStr === undefined) return [null, null]
  const separator = embeddingStr.indexOf(':')
  if (separator < 0) {
    throw new Error('Set EMBEDDING = \'<embedding_provider>:<embedding_model>\' Eg \'openai:text-embedding-3-large\'')
  }
  return [embeddingStr.slice(0, separator), embeddingStr.slice(separator + 1)]
}

/**
 * Convert one environment string using a declared config type.
 *
 * Mirrors `Config.convert_env_value`, including the ordering quirk the source
 * documents: for an optional type the `none`/`null`/`""` sentinel is checked
 * before the non-None members, otherwise `str` conversion would always win.
 *
 * @param {string} key - config key, for error text.
 * @param {string} envValue - the raw environment value.
 * @param {string} typeHint - one of the {@link BASE_CONFIG_TYPES} values.
 * @returns {unknown} the converted value.
 * @throws {Error} when the value cannot be converted.
 */
export function convertEnvValue(key, envValue, typeHint) {
  const lower = envValue.toLowerCase()
  switch (typeHint) {
    case 'bool':
      return ['true', '1', 'yes', 'on'].includes(lower)
    case 'int': {
      const value = Number.parseInt(envValue, 10)
      if (Number.isNaN(value)) throw new Error(`Cannot convert ${envValue} to int for key ${key}`)
      return value
    }
    case 'float': {
      const value = Number.parseFloat(envValue)
      if (Number.isNaN(value)) throw new Error(`Cannot convert ${envValue} to float for key ${key}`)
      return value
    }
    case 'str':
      return envValue
    case 'any':
      return envValue
    case 'str?':
      if (['none', 'null', ''].includes(lower)) return null
      return envValue
    case 'list': {
      let value
      try {
        value = jsonRepairLoads(envValue)
      } catch (error) {
        throw new Error(`Cannot convert ${envValue} to list`)
      }
      if (!Array.isArray(value)) throw new Error(`Cannot convert ${envValue} to list`)
      return value
    }
    case 'dict': {
      let value
      try {
        value = jsonRepairLoads(envValue)
      } catch (error) {
        throw new Error(`Cannot convert ${envValue} to dict`)
      }
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`Cannot convert ${envValue} to dict`)
      }
      return value
    }
    default:
      throw new Error(`Unsupported type ${typeHint} for key ${key}`)
  }
}

/** Configuration manager. Port of `class Config`. */
export class Config {
  /**
   * @param {string | null} [configPath] - optional path to a JSON config file.
   * @param {{ env?: Record<string, string|undefined>, logger?: object }} [options]
   *   environment map and logger; both default to `process.env` and a no-op.
   */
  constructor(configPath = null, options = {}) {
    const env = options.env ?? process.env
    const logger = { ...defaultLogger, ...(options.logger ?? {}) }
    this.configPath = configPath
    this.llmKwargs = {}
    this.embeddingKwargs = {}
    this._env = env
    this._logger = logger

    const configToUse = this.loadConfig(configPath, env)
    this._setAttributes(configToUse, env)
    this._setEmbeddingAttributes()
    this._setLlmAttributes()
    this._handleDeprecatedAttributes(env)
    if ((env.REPORT_SOURCE ?? configToUse.REPORT_SOURCE) !== 'web') {
      this._setDocPath(configToUse)
    }
  }

  /**
   * Set instance attributes from a config dict, with environment overrides.
   *
   * Source also resolves `retrievers` here (defaulting to `tavily`), which the
   * port keeps in the same place.
   *
   * @param {Record<string, unknown>} config - merged config values.
   * @param {Record<string, string|undefined>} env - environment map.
   */
  _setAttributes(config, env) {
    for (const [key, configValue] of Object.entries(config)) {
      let value = configValue
      const envValue = env[key]
      if (envValue !== undefined) {
        value = convertEnvValue(key, envValue, BASE_CONFIG_TYPES[key])
      }
      this[key.toLowerCase()] = value
    }
    const retrieverEnv = env.RETRIEVER ?? config.RETRIEVER ?? 'tavily'
    try {
      this.retrievers = parseRetrievers(retrieverEnv, this._logger.warn)
    } catch (error) {
      this._logger.warn(`Warning: ${error.message}. Defaulting to 'tavily' retriever.`)
      this.retrievers = ['tavily']
    }
  }

  /**
   * Parse and set the embedding provider and model, under the source's
   * snake_case attribute names (`embedding_provider`, `embedding_model`).
   */
  _setEmbeddingAttributes() {
    const [provider, model] = parseEmbedding(this.embedding)
    this.embedding_provider = provider
    this.embedding_model = model
  }

  /**
   * Parse and set the LLM provider and model for all three LLM roles.
   *
   * Attributes use snake_case (`fast_llm_provider`, `fast_llm_model`, …) exactly
   * as the source's `self.fast_llm_provider` does. Every ported call site reads
   * those names, and the source's own `parse_llm` returns a `(provider, model)`
   * pair, so a camelCase alias would silently differ from the reference.
   */
  _setLlmAttributes() {
    ;[this.fast_llm_provider, this.fast_llm_model] = parseLlm(this.fast_llm)
    ;[this.smart_llm_provider, this.smart_llm_model] = parseLlm(this.smart_llm)
    ;[this.strategic_llm_provider, this.strategic_llm_model] = parseLlm(this.strategic_llm)
    this.reasoning_effort = parseReasoningEffort(this.reasoning_effort)
  }

  /**
   * Apply the source's deprecated-variable overrides.
   *
   * The source reads the old names from the environment only, warns, and
   * overwrites the parsed attributes. Both paths are kept so a deployment that
   * still sets the old names behaves identically.
   *
   * @param {Record<string, string|undefined>} env - environment map.
   */
  _handleDeprecatedAttributes(env) {
    if (env.EMBEDDING_PROVIDER !== undefined) {
      this._logger.warn('EMBEDDING_PROVIDER is deprecated and will be removed soon. Use EMBEDDING instead.')
      this.embedding_provider = env.EMBEDDING_PROVIDER || this.embedding_provider
      const provider = env.EMBEDDING_PROVIDER
      if (provider === 'ollama') {
        this.embedding_model = env.OLLAMA_EMBEDDING_MODEL
      } else if (provider === 'custom') {
        this.embedding_model = env.OPENAI_EMBEDDING_MODEL ?? 'custom'
      } else if (provider === 'openai' || provider === 'azure_openai') {
        this.embedding_model = 'text-embedding-3-large'
      } else if (provider === 'huggingface') {
        this.embedding_model = 'sentence-transformers/all-MiniLM-L6-v2'
      } else if (provider === 'gigachat') {
        this.embedding_model = 'Embeddings'
      } else if (provider === 'google_genai') {
        this.embedding_model = 'gemini-embedding-2'
      } else {
        throw new Error('Embedding provider not found.')
      }
    }

    const deprecationWarning = 'LLM_PROVIDER, FAST_LLM_MODEL and SMART_LLM_MODEL are deprecated and '
      + 'will be removed soon. Use FAST_LLM and SMART_LLM instead.'
    if (env.LLM_PROVIDER !== undefined) {
      this._logger.warn(deprecationWarning)
      this.fast_llm_provider = env.LLM_PROVIDER || this.fast_llm_provider
      this.smart_llm_provider = env.LLM_PROVIDER || this.smart_llm_provider
    }
    if (env.FAST_LLM_MODEL !== undefined) {
      this._logger.warn(deprecationWarning)
      this.fast_llm_model = env.FAST_LLM_MODEL || this.fast_llm_model
    }
    if (env.SMART_LLM_MODEL !== undefined) {
      this._logger.warn(deprecationWarning)
      this.smart_llm_model = env.SMART_LLM_MODEL || this.smart_llm_model
    }
  }

  /**
   * Resolve and create `doc_path` for non-web report sources.
   *
   * `validate_doc_path` creates the directory, so this is a write on a config
   * path; the source does the same and only for local/hybrid sources.
   *
   * @param {Record<string, unknown>} config - merged config values.
   */
  _setDocPath(config) {
    if (!this.doc_path) this.doc_path = config.DOC_PATH
    if (this.doc_path) {
      try {
        this.validateDocPath()
      } catch (error) {
        this._logger.warn(`Warning: Error validating doc_path: ${String(error)}. Using default doc_path.`)
        this.doc_path = DEFAULT_CONFIG.DOC_PATH
      }
    }
  }

  /**
   * Load a configuration by path.
   *
   * Always returns a fresh copy so mutable defaults such as `LLM_KWARGS` or
   * `MCP_SERVERS` are never shared between `Config` instances.
   *
   * @param {string | null} configPath - explicit path, else `CONFIG_PATH`.
   * @param {Record<string, string|undefined>} [env] - environment map.
   * @returns {Record<string, unknown>} the merged config.
   */
  loadConfig(configPath, env = process.env) {
    const resolvedPath = configPath || env.CONFIG_PATH
    if (!resolvedPath) return deepcopy(DEFAULT_CONFIG)
    if (!existsSync(resolvedPath)) {
      if (resolvedPath !== 'default') {
        this._logger.warn(`Warning: Configuration not found at '${resolvedPath}'. Using default configuration.`)
        if (!resolvedPath.endsWith('.json')) {
          this._logger.warn(`Do you mean '${resolvedPath}.json'?`)
        }
      }
      return deepcopy(DEFAULT_CONFIG)
    }
    const customConfig = JSON.parse(readFileSync(resolvedPath, 'utf8'))
    const mergedConfig = deepcopy(DEFAULT_CONFIG)
    Object.assign(mergedConfig, customConfig)
    return mergedConfig
  }

  /**
   * List available config names in the bundled directory.
   * @returns {string[]} `["default", ...<json basenames>]`.
   */
  listAvailableConfigs() {
    const configs = ['default']
    if (!existsSync(CONFIG_DIR)) return configs
    for (const file of readdirSync(CONFIG_DIR)) {
      if (file.endsWith('.json')) configs.push(file.slice(0, -5))
    }
    return configs
  }

  /**
   * Parse the configured retriever string.
   * @param {string} retrieverStr - comma-separated names.
   * @returns {string[]} parsed names.
   */
  parseRetrievers(retrieverStr) {
    return parseRetrievers(retrieverStr, this._logger?.warn ?? defaultLogger.warn)
  }

  /**
   * Python attribute-style access.
   *
   * The source reads config as `cfg.report_format` (lowercased key) while some
   * call sites use snake_case names that JS would normally reject. This alias
   * keeps every ported call site textually identical to the source instead of
   * rewriting each attribute reference. Only lowercase/snake_case keys resolve,
   * so a typo still yields `undefined` exactly as an absent Python attribute
   * would raise.
   *
   * @param {string} name - snake_case attribute name.
   * @returns {unknown} the attribute value, or `undefined`.
   */
  get(name) {
    return this[name]
  }

  /** Ensure the folder exists at `doc_path`. */
  validateDocPath() {
    mkdirSync(this.doc_path, { recursive: true })
  }

  /**
   * Set the verbosity level on `llm_kwargs`.
   * @param {boolean} verbose - new verbosity.
   */
  setVerbose(verbose) {
    this.llmKwargs.verbose = verbose
  }

  /**
   * Get one MCP server config by name.
   * @param {string} name - server name.
   * @returns {Record<string, unknown>} the config, or `{}` when not found.
   */
  getMcpServerConfig(name) {
    if (!name || !this.mcp_servers) return {}
    for (const server of this.mcp_servers) {
      if (server !== null && typeof server === 'object' && server.name === name) return server
    }
    return {}
  }
}

export { DEFAULT_CONFIG, BASE_CONFIG_TYPES }
