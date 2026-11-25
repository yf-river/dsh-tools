/**
 * Enumeration types.
 *
 * One-to-one port of `gpt_researcher/utils/enum.py`. Python `Enum` members
 * become `Object.freeze` maps of `name → value`, which preserves the two
 * accesses the pipeline uses: `ReportType.DeepResearch.value` becomes
 * `ReportType.DeepResearch`, and `Tone.Objective.value` becomes
 * `Tone.Objective`.
 *
 * @module @yf-river/dsh-gpt-research/utils/enum
 */

/** Report types mirrored from the source `ReportType`. */
export const ReportType = Object.freeze({
  ResearchReport: 'research_report',
  ResourceReport: 'resource_report',
  OutlineReport: 'outline_report',
  CustomReport: 'custom_report',
  DetailedReport: 'detailed_report',
  SubtopicReport: 'subtopic_report',
  DeepResearch: 'deep',
})

/** Report data sources mirrored from the source `ReportSource`. */
export const ReportSource = Object.freeze({
  Web: 'web',
  Local: 'local',
  Azure: 'azure',
  LangChainDocuments: 'langchain_documents',
  LangChainVectorStore: 'langchain_vectorstore',
  Static: 'static',
  Hybrid: 'hybrid',
})

/**
 * Writing tones mirrored from the source `Tone`.
 *
 * Each value carries its parenthetical description, because the prompts embed
 * the string verbatim (`Write the report in a {tone.value} tone`).
 */
export const Tone = Object.freeze({
  Objective: 'Objective (impartial and unbiased presentation of facts and findings)',
  Formal: 'Formal (adheres to academic standards with sophisticated language and structure)',
  Analytical: 'Analytical (critical evaluation and detailed examination of data and theories)',
  Persuasive: 'Persuasive (convincing the audience of a particular viewpoint or argument)',
  Informative: 'Informative (providing clear and comprehensive information on a topic)',
  Explanatory: 'Explanatory (clarifying complex concepts and processes)',
  Descriptive: 'Descriptive (detailed depiction of phenomena, experiments, or case studies)',
  Critical: 'Critical (judging the validity and relevance of the research and its conclusions)',
  Comparative: 'Comparative (juxtaposing different theories, data, or methods to highlight differences and similarities)',
  Speculative: 'Speculative (exploring hypotheses and potential implications or future research directions)',
  Reflective: 'Reflective (considering the research process and personal insights or experiences)',
  Narrative: 'Narrative (telling a story to illustrate research findings or methodologies)',
  Humorous: 'Humorous (light-hearted and engaging, usually to make the content more relatable)',
  Optimistic: 'Optimistic (highlighting positive findings and potential benefits)',
  Pessimistic: 'Pessimistic (focusing on limitations, challenges, or negative outcomes)',
  Simple: 'Simple (written for young readers, using basic vocabulary and clear explanations)',
  Casual: 'Casual (conversational and relaxed style for easy, everyday reading)',
})

/** Prompt families mirrored from the source `PromptFamily`. */
export const PromptFamily = Object.freeze({
  Default: 'default',
  Granite: 'granite',
  Granite3: 'granite3',
  Granite31: 'granite3.1',
  Granite32: 'granite3.2',
  Granite33: 'granite3.3',
})
