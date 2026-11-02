import type { Color } from '../../app/state';
import { t } from '../../i18n/locale';

export interface BotPreset {
  id: string;
  name: string;
  category: string;
  color: Color;
  description: string;
  prompts: string[];
  instructions: string;
}

export const presets = [
  {
    id: 'general',
    name: 'gallery.generalAssistant',
    category: 'gallery.everydayWork',
    color: 'mint',
    description: 'gallery.clarifyGoalsBreakDownTasksGetWork',
    prompts: ['gallery.breakTaskIntoActionableSteps', 'gallery.organizeMaterialsTellMeWhatDoNext'],
    instructions: 'gallery.generalWorkCompanionUnderstandUserSGoal',
  },
  {
    id: 'research',
    name: 'gallery.researcher',
    category: 'gallery.researchAnalysis',
    color: 'violet',
    description: 'gallery.findReferencesVerifySourcesTurnScatteredInformation',
    prompts: [
      'gallery.compareStrengthsWeaknessesOptions',
      'gallery.researchTopicPrepareSourcedReport',
    ],
    instructions: 'gallery.rigorousResearchCompanionGatherOrganizeEvidenceUser',
  },
  {
    id: 'writer',
    name: 'gallery.writingCompanion',
    category: 'gallery.contentCreation',
    color: 'orange',
    description: 'gallery.outlineFinalDraftExpressIdeasClearlyNaturally',
    prompts: ['gallery.writeArticlePoints', 'gallery.rewriteTextMoreClearlyConcisely'],
    instructions: 'gallery.writingCompanionWriteEditUsingUserS',
  },
  {
    id: 'data',
    name: 'gallery.dataAnalyst',
    category: 'gallery.researchAnalysis',
    color: 'teal',
    description: 'gallery.inspectTablesMetricsExplainWhatDataReveals',
    prompts: [
      'gallery.analyzeTableAnomaliesTrends',
      'gallery.summarizeDataIntoPresentationConclusions',
    ],
    instructions: 'gallery.dataAnalysisCompanionCheckStructureDefinitionsMissing',
  },
  {
    id: 'browser',
    name: 'gallery.browserAssistant',
    category: 'gallery.everydayWork',
    color: 'blue',
    description: 'gallery.readWebpagesSummarizeInformationHelpRepetitivePage',
    prompts: ['gallery.readWebpagesSummarizeKeyInformation', 'gallery.checkInformationPage'],
    instructions: 'gallery.browserTaskCompanionUnderstandGoalPreferAvailable',
  },
  {
    id: 'translator',
    name: 'gallery.translationCompanion',
    category: 'gallery.contentCreation',
    color: 'pink',
    description: 'gallery.translatePolishTextConsistentToneTerminology',
    prompts: ['gallery.translateMaterialIntoNaturalEnglish', 'gallery.proofreadChineseEnglishCopy'],
    instructions: 'gallery.translationLanguageEditingCompanionPreserveMeaningNumbers',
  },
  {
    id: 'product',
    name: 'gallery.productPartner',
    category: 'gallery.researchAnalysis',
    color: 'blue',
    description: 'gallery.clarifyUserProblemsTurnRequirementsIntoFocused',
    prompts: [
      'gallery.turnIdeaIntoRequirementsDocument',
      'gallery.narrowDownFirstVersionSFeatureScope',
    ],
    instructions: 'gallery.productDesignCompanionIdentifyUserProblemScenario',
  },
  {
    id: 'content',
    name: 'gallery.contentPlanner',
    category: 'gallery.contentCreation',
    color: 'violet',
    description: 'gallery.findTopicsWriteScriptsClearDirectionContent',
    prompts: ['gallery.planContentSeriesAroundTopic', 'gallery.turnMaterialIntoShortVideoScript'],
    instructions: 'gallery.contentPlanningCompanionSuggestTopicsApproachesBased',
  },
  {
    id: 'office',
    name: 'gallery.officeAssistant',
    category: 'gallery.everydayWork',
    color: 'orange',
    description: 'gallery.organizeMeetingMinutesReportsDocumentsKeepWork',
    prompts: ['gallery.turnMeetingRecordsIntoMinutesDos', 'gallery.generateWeeklyReportRecords'],
    instructions: 'gallery.officeCollaborationCompanionOrganizeSuppliedRecordsInto',
  },
  {
    id: 'code',
    name: 'gallery.codingCompanion',
    category: 'gallery.learningDevelopment',
    color: 'teal',
    description: 'gallery.explainCodeDiagnoseProblemsHelpImplementVerify',
    prompts: ['gallery.explainHowCodeWorks', 'gallery.diagnoseErrorSuggestVerifiableFix'],
    instructions: 'gallery.codingCompanionReadRelevantCodeProjectRules',
  },
  {
    id: 'learning',
    name: 'gallery.learningCoach',
    category: 'gallery.learningDevelopment',
    color: 'mint',
    description: 'gallery.understandDifficultIdeasThroughClearExplanationsPractice',
    prompts: ['gallery.explainConceptExamples', 'gallery.createPracticalLearningPlanMe'],
    instructions: 'gallery.patientLearningCompanionUnderstandUserSBackground',
  },
  {
    id: 'ideas',
    name: 'gallery.ideaCompanion',
    category: 'gallery.contentCreation',
    color: 'pink',
    description: 'gallery.exploreIdeasCompareDirectionsTurnPromisingOptions',
    prompts: [
      'gallery.giveMeSeveralDistinctApproachesProblem',
      'gallery.challengeIdeaFindWaysImprove',
    ],
    instructions: 'gallery.brainstormingCompanionOfferMeaningfullyDifferentIdeasUser',
  },
] as const;

export function localizePreset(preset: (typeof presets)[number]): BotPreset {
  return {
    ...preset,
    name: t(preset.name),
    category: t(preset.category),
    description: t(preset.description),
    prompts: preset.prompts.map((prompt) => t(prompt)),
    instructions: t(preset.instructions),
  };
}
