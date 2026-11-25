/**
 * Configuration keys and their declared types.
 *
 * Mirrors `gpt_researcher/config/variables/base.py` (`BaseConfig` TypedDict).
 * The declared type is what `convertEnvValue` uses to coerce an environment
 * string, so each entry names the same type the Python annotation names.
 *
 * Ported one-to-one: every key from the source appears here, including keys the
 * DSH port does not itself consume, because `Config` still validates and exposes
 * them and dropping a key changes what an env override can set.
 *
 * @module @yf-river/dsh-gpt-research/config/variables/base
 */

/**
 * Declared types, one per config key.
 *
 * `'any'` is Python's `Any`; `'str?'` is `Union[str, None]` (optional string);
 * `'list'` and `'dict'` are `List[Any]` / `Dict[str, Any]`.
 */
export const BASE_CONFIG_TYPES = Object.freeze({
  RETRIEVER: 'str',
  EMBEDDING: 'str',
  SIMILARITY_THRESHOLD: 'float',
  CONTEXT_FILTER: 'str',
  FAST_LLM: 'str',
  SMART_LLM: 'str',
  STRATEGIC_LLM: 'str',
  FAST_TOKEN_LIMIT: 'int',
  SMART_TOKEN_LIMIT: 'int',
  STRATEGIC_TOKEN_LIMIT: 'int',
  BROWSE_CHUNK_MAX_LENGTH: 'int',
  SUMMARY_TOKEN_LIMIT: 'int',
  TEMPERATURE: 'float',
  USER_AGENT: 'str',
  MAX_SEARCH_RESULTS_PER_QUERY: 'int',
  MEMORY_BACKEND: 'str',
  TOTAL_WORDS: 'int',
  REPORT_FORMAT: 'str',
  CURATE_SOURCES: 'bool',
  MAX_ITERATIONS: 'int',
  LANGUAGE: 'str',
  AGENT_ROLE: 'str?',
  SCRAPER: 'str',
  MAX_SCRAPER_WORKERS: 'int',
  SCRAPER_RATE_LIMIT_DELAY: 'float',
  MAX_SUBTOPICS: 'int',
  REPORT_SOURCE: 'str?',
  DOC_PATH: 'str',
  PROMPT_FAMILY: 'str',
  LLM_KWARGS: 'dict',
  EMBEDDING_KWARGS: 'dict',
  VERBOSE: 'bool',
  DEEP_RESEARCH_CONCURRENCY: 'int',
  DEEP_RESEARCH_DEPTH: 'int',
  DEEP_RESEARCH_BREADTH: 'int',
  MCP_SERVERS: 'list',
  MCP_AUTO_TOOL_SELECTION: 'bool',
  MCP_USE_LLM_ARGS: 'bool',
  MCP_ALLOWED_ROOT_PATHS: 'list',
  MCP_STRATEGY: 'str',
  REASONING_EFFORT: 'str',
  // Image generation settings
  IMAGE_GENERATION_MODEL: 'str?',
  IMAGE_GENERATION_MAX_IMAGES: 'int',
  IMAGE_GENERATION_ENABLED: 'bool',
  IMAGE_GENERATION_STYLE: 'str',
  IMAGE_GENERATION_PROVIDER: 'str',
})
