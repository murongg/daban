import {
  type BrowserBinding,
  type DesktopInput,
  disconnected,
  type RuntimeBot,
  type RuntimeCommand,
  type RuntimeSnapshot,
} from '@daban/protocol';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { vmErrorKey } from '../../shared/vm';
import { type MessageKey, t, useLocale } from '../i18n/locale';
import { taskErrorKey } from '../i18n/tasks';

interface Connection {
  enabled: boolean;
  snapshot: RuntimeSnapshot;
  command: <T = unknown>(command: RuntimeCommand) => Promise<T>;
  input: (
    bot: RuntimeBot,
    epoch: number,
    input: DesktopInput,
    instance?: string,
  ) => Promise<unknown>;
  browserInput: (
    bot: RuntimeBot,
    epoch: number,
    binding: BrowserBinding,
    input: DesktopInput,
    host?: boolean,
  ) => Promise<unknown>;
}
const unavailable = async (): Promise<never> => {
  throw new Error('RUNTIME_OFFLINE');
};
const Context = createContext<Connection>({
  enabled: false,
  snapshot: disconnected(),
  command: unavailable,
  input: unavailable,
  browserInput: unavailable,
});
export function RuntimeProvider({ children }: { children: ReactNode }) {
  useLocale();
  const [bridge] = useState(() => window.daban?.runtime);
  const [snapshot, setSnapshot] = useState(() => disconnected(bridge ? 'connecting' : 'offline'));
  const tails = useRef(new Map<RuntimeBot, Promise<unknown>>());
  const command = useCallback(
    async <T = unknown>(value: RuntimeCommand): Promise<T> => {
      if (!bridge) throw new Error('RUNTIME_OFFLINE');
      const reply = await bridge.invoke<T>(value);
      if (!reply.ok) throw new Error(reply.error);
      if (value.type === 'status' || value.type === 'connect')
        setSnapshot(reply.value as RuntimeSnapshot);
      return reply.value;
    },
    [bridge],
  );
  useEffect(() => {
    if (!bridge) return;
    let live = true;
    const unsubscribe = bridge.subscribe((state) => {
      if (live) setSnapshot(state);
    });
    command<RuntimeSnapshot>({ type: 'status' }).catch(() => {
      // Keep the message ID so a language switch also updates an existing connection error.
      if (live)
        setSnapshot(
          disconnected(
            'offline',
            'errors.unableConnectLocalExecutionEnvironment' satisfies MessageKey,
          ),
        );
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [bridge, command]);
  const input = useCallback(
    (bot: RuntimeBot, epoch: number, value: DesktopInput, instance?: string) => {
      // Capture the target and lease before enqueueing. A late packet must never inherit a new Bot or new owner.
      const next = (tails.current.get(bot) || Promise.resolve())
        .catch(() => {})
        .then(async () => {
          await command({
            type: 'input',
            bot,
            epoch,
            input: value,
            ...(instance === undefined ? {} : { instance }),
          });
        });
      tails.current.set(bot, next);
      return next;
    },
    [command],
  );
  const browserInput = useCallback(
    (
      bot: RuntimeBot,
      epoch: number,
      binding: BrowserBinding,
      value: DesktopInput,
      host = false,
    ) => {
      const next = (tails.current.get(bot) || Promise.resolve())
        .catch(() => {})
        .then(() =>
          command(
            host
              ? {
                  type: 'hostBrowser',
                  request: { action: 'input', bot, epoch, binding, input: value },
                }
              : { type: 'browser.input', bot, epoch, binding, input: value },
          ),
        );
      tails.current.set(bot, next);
      return next;
    },
    [command],
  );
  const value = useMemo(
    () => ({ enabled: !!bridge, snapshot, command, input, browserInput }),
    [bridge, snapshot, command, input, browserInput],
  );
  return <Context value={value}>{children}</Context>;
}
export function useRuntime() {
  return useContext(Context);
}
export function runtimeError(error: unknown) {
  const code = error instanceof Error ? error.message : '';
  const vmKey = vmErrorKey(error);
  if (vmKey) return t(vmKey);
  return runtimeMessage(code, t('errors.operationUnconfirmedCheckConnectionTaskStateRetrying'));
}
export function runtimeMessage(code: string, fallback = code) {
  const key = taskErrorKey(code);
  if (key) return t(key);
  const messages: Record<string, string> = {
    HOST_BROWSER_START_FAILED: t('hostBrowser.startFailed'),
    HOST_BROWSER_DISCONNECTED: t('hostBrowser.disconnected'),
    HOST_BROWSER_UNAVAILABLE: t('hostBrowser.unavailable'),
    HOST_BROWSER_NOT_CONNECTED: t('hostBrowser.disconnected'),
    HOST_BROWSER_INVALID_STATUS: t('hostBrowser.unavailable'),
    HOST_BROWSER_CONNECTED: t('hostBrowser.switchFirst'),
    SEARCH_LEGACY_IN_USE: t('search.legacyInUse'),
    SEARCH_CONFIG_CHANGED: t('search.healthChanged'),
    AGENT_LEGACY_RESTART_REQUIRED: t('agentUpgrade.required'),
    AGENT_LEGACY_RESTART_UNAVAILABLE: t('agentUpgrade.manual'),
    AGENT_LEGACY_SCHEDULES_ACTIVE: t('agentUpgrade.schedules'),
    AGENT_UPDATE_BUSY: t('agentUpgrade.busy'),
    LOCAL_PLATFORM_UNSUPPORTED: t('localComputer.platformUnsupported'),
    LOCAL_SCREEN_PERMISSION: t('localComputer.screenRequired'),
    LOCAL_ACCESSIBILITY_PERMISSION: t('localComputer.inputRequired'),
    LOCAL_MODEL_CHANGED: t('localComputer.modelChanged'),
    LOCAL_COMPUTER_BUSY: t('localComputer.occupied'),
    LOCAL_TASK_BUSY: t('localComputer.taskBusy'),
    LOCAL_AGENT_UPDATE_REQUIRED: t('localComputer.updateRequired'),
    LOCAL_CLIENT_UNAVAILABLE: t('localComputer.unavailable'),
    LOCAL_SESSION_STALE: t('localComputer.stateChanged'),
    LOCAL_DRIVER_UNAVAILABLE: t('localComputer.driverUnavailable'),
    LOCAL_DRIVER_FAILED: t('localComputer.driverUnavailable'),
    LOCAL_SHORTCUT_UNAVAILABLE: t('localComputer.shortcutUnavailable'),
    LOCAL_OTHER_DISPLAY: t('localComputer.primaryDisplay'),
    NOTE_CONFLICT: t('errors.noteUpdatedEditsRetainedReviewLatestRevision'),
    NOTE_TRASHED: t('errors.noteMovedTrashEditsRetainedReviewLatest'),
    NOTE_NOT_FOUND: t('errors.noteNotFoundYetDraftRetainedRefresh'),
    NOTES_UNAVAILABLE: t('errors.notesTemporarilyUnavailableExistingDraftsOperationRecords'),
    NOTES_CORRUPT: t('errors.noteStorageUnreadableHasNotBeenReset'),
    NOTES_CLOSED: t('errors.runtimeClosingReconnectVerifyNotes'),
    NOTE_LIMIT: t('errors.notesLimitHasBeenReachedIncludingTrash'),
    NOTE_OPERATION_LIMIT: t('errors.noteOperationLimitHasBeenReachedCheck'),
    NOTE_ID_CONFLICT: t('errors.noteIdAlreadyUseNoExistingRecord'),
    NOTE_REQUEST_CONFLICT: t('errors.operationDoesNotMatchSavedReceiptOriginalRequest'),
    INVALID_NOTE_WRITE: t('errors.invalidNoteContentCheckTitleStatusText'),
    INVALID_NOTE_QUERY: t('errors.invalidNoteFilterChooseAnotherFilterSearch'),
    INVALID_NOTE_METADATA: t('errors.noteStateCannotVerifiedRightNowCheck'),
    INVALID_NOTE_PAGE: t('errors.noteListResponseDoesNotMatchRefresh'),
    INVALID_NOTE_ITEM: t('errors.noteDetailsDoNotMatchRequestDraft'),
    INVALID_NOTE_ACK: t('errors.noteReceiptDoesNotMatchOriginalOperation'),
    WORK_CONFLICT: t('errors.taskUpdatedEditsRetainedReviewLatestRevision'),
    WORK_TRASHED: t('errors.taskMovedTrashEditsRetainedReviewLatest'),
    WORK_NOT_FOUND: t('errors.taskNotFoundYetDraftRetainedRefresh'),
    WORK_UNAVAILABLE: t('errors.sharedTasksTemporarilyUnavailableDraftsOperationRecords'),
    WORK_CORRUPT: t('errors.taskStorageUnreadableHasNotBeenReset'),
    WORK_CLOSED: t('errors.runtimeClosingReconnectVerifyTasks'),
    WORK_LIMIT: t('errors.taskLimitHasBeenReachedIncludingTrash'),
    WORK_OPERATION_LIMIT: t('errors.retainedTaskOperationLimitHasBeenReached'),
    WORK_ID_CONFLICT: t('errors.taskIdAlreadyUseNoExistingTask'),
    WORK_REQUEST_CONFLICT: t('errors.operationDoesNotMatchSavedReceiptOriginal'),
    INVALID_WORK_WRITE: t('errors.invalidTaskContentCheckTitleStatusText'),
    INVALID_WORK_QUERY: t('errors.invalidTaskFilterChooseAnotherFilterSearch'),
    INVALID_WORK_METADATA: t('errors.taskStateCannotVerifiedRightNowCheck'),
    INVALID_WORK_PAGE: t('errors.taskListResponseDoesNotMatchRefresh'),
    INVALID_WORK_ITEM: t('errors.taskDetailsDoNotMatchRequestDraft'),
    INVALID_WORK_ACK: t('errors.taskReceiptDoesNotMatchOriginalOperation'),
    INVALID_WORK_COMMENT: t('errors.invalidCommentCheckContentLengthPosting'),
    INVALID_WORK_COMMENT_PAGE: t('errors.discussionResponseDoesNotMatchRefreshVerify'),
    INVALID_WORK_COMMENT_ACK: t('errors.postingResultCannotVerifiedRightNowComment'),
    INVALID_BOT_COPY: t('errors.invalidCopyParametersReviewNameSource'),
    INVALID_GROUP_COPY: t('errors.invalidGroupCopyParametersReviewNameSource'),
    INVALID_GROUP_COPY_ACK: t('errors.groupCopyReceiptDoesNotMatchOriginal'),
    GROUP_COPY_CONFLICT: t('errors.copyTargetDiffersOriginalRequestRetainOriginal'),
    INVALID_BOT_COPY_ACK: t('errors.copyReceiptDoesNotMatchOriginalRequest'),
    BOT_COPY_CONFLICT: t('errors.copyTargetDiffersOriginalRequestRetainOriginal'),
    INVALID_BOT_LIFECYCLE: t('errors.invalidBotActionCheckTargetProfileRevision'),
    BOT_ARCHIVED: t('errors.botArchivedHistoryRetainedRestoreSendNew'),
    BOT_CHANGING: t('errors.botStateChangingVerifyResultContinuing'),
    BOT_UNAVAILABLE: t('errors.botArchivedUnavailableRestoreSelecting'),
    COMPUTER_BOT_UNAVAILABLE: t('errors.botUnavailableReconnectComputerRestoring'),
    BOT_TASK_RUNNING: t('errors.botStillHasRunningTasksFinishThem'),
    BOT_COMPUTER_CONNECTED: t('errors.stopBotSComputerConfirmContentSaved'),
    BOT_COMPUTER_STATE_UNAVAILABLE: t('errors.computerStateCannotVerifiedRecoverRuntimeFirst'),
    BOT_GROUP_PENDING: t('errors.botHasQueuedGroupWorkHandleCancel'),
    BOT_REQUEST_ID_REUSED: t('errors.operationIdDiffersOriginalRequestVerifyCurrent'),
    BOT_RESTORE_NOT_READY: t('errors.archivingIncompleteVerifyFinishOriginalArchiveOperation'),
    BOT_ARCHIVE_INCOMPLETE: t('errors.archivingIncompleteBotCannotAcceptTasksYet'),
    BOT_LIFECYCLE_NOT_FOUND: t('errors.operationReceiptWasNotFoundYetCheckCurrent'),
    BOT_LIFECYCLE_FAILED: t('errors.botActionCouldNotConfirmedCheckProfiles'),
    BOT_LIFECYCLE_UNAVAILABLE: t(
      'errors.botArchivingTemporarilyUnavailableExistingHistoryRetained',
    ),
    BOT_LIFECYCLE_CLOSED: t('errors.runtimeClosingReconnectVerifyOperationResults'),
    INVALID_MCP_CONFIG: t('errors.invalidConnectionConfigurationCheckNameHttpsUrl'),
    INVALID_MCP_BINDING: t('errors.invalidToolSelectionReviewCatalogTargetBot'),
    MCP_STORE_UNAVAILABLE: t('errors.externalToolsTemporarilyUnavailableOrdinaryChatRemains'),
    MCP_CONFLICT: t('errors.connectionConfigurationChangedReviewCurrentRevisionInput'),
    MCP_BINDING_CONFLICT: t('errors.botSToolPermissionsChangedReviewThem'),
    MCP_BINDING_UNCONFIRMED: t('errors.authorizationUnconfirmedReviewSavedSelectionsWillNot'),
    MCP_NAME_CONFLICT: t('errors.connectionNameAlreadyExistsChooseAnotherName'),
    MCP_NOT_FOUND: t('errors.connectionNoLongerExistsRefreshListVerify'),
    MCP_BOT_NOT_FOUND: t('errors.botProfilesHaveNotSyncedYetPlease'),
    MCP_ARCHIVED: t('errors.connectionArchivedSelectEnableToolsAgainRestoring'),
    MCP_REVIEW_REQUIRED: t('errors.checkConnectionReviewCurrentToolCatalogEnabling'),
    MCP_TOOL_NOT_FOUND: t('errors.toolCatalogChangedReviewAvailableToolsAgain'),
    MCP_TOOL_LIMIT: t('errors.upExternalToolsCanEnabledPerBot'),
    MCP_CONNECTION_LIMIT: t('errors.limitRetainedConnectionsHasBeenReachedIncluding'),
    MCP_STORAGE_LIMIT: t('errors.externalToolRecordLimitHasBeenReached'),
    MCP_NETWORK_BLOCKED: t('errors.connectionUrlFailedPublicHttpsValidationCheck'),
    MCP_CONNECTION_FAILED: t('errors.unableConnectExternalServiceCheckUrlCredentials'),
    MCP_CHECK_CANCELLED: t('errors.connectionCheckCancelledCanCheckAgain'),
    MCP_CHECK_PENDING: t('errors.checkAlreadyRunningConnectionRefreshShortly'),
    MCP_SECRET_IN_CATALOG: t('errors.serviceToolCatalogContainsSavedCredentialsWas'),
    MCP_SAVE_NOT_FOUND: t('errors.saveReceiptWasNotFoundYetCheck'),
    MCP_APPROVAL_DENIED: t('errors.toolCallWasDeclinedNoOperationWas'),
    MCP_AUTHORITY_CHANGED: t('errors.connectionToolPermissionsChangedUnsentOperationsWere'),
    MCP_OUTCOME_UNKNOWN: t('common.operationMayAlreadyHaveExecutedCheckDestination'),
    INVALID_SKILL_PACKAGE: t('errors.skillPackageInvalid'),
    INVALID_SKILL_PATH: t('errors.skillPackageInvalid'),
    SKILL_PACKAGE_TOO_LARGE: t('errors.skillPackageTooLarge'),
    SKILL_STORAGE_LIMIT: t('errors.skillStorageLimit'),
    SKILL_FILE_NOT_FOUND: t('errors.skillFileMissing'),
    SKILL_SOURCE_INVALID: t('errors.skillSourceInvalid'),
    SKILL_SOURCE_UNAVAILABLE: t('errors.skillSourceUnavailable'),
    SKILL_SOURCE_RATE_LIMITED: t('errors.skillSourceRateLimited'),
    SKILL_SOURCE_BLOCKED: t('errors.skillSourceBlocked'),
    SKILL_SOURCE_AUTH_REQUIRED: t('errors.skillSourceAuth'),
    SKILL_SOURCE_NOT_FOUND: t('errors.skillSourceNotFound'),
    SKILL_SOURCE_CHANGED: t('errors.skillSourceChanged'),
    SKILL_SOURCE_TOO_LARGE: t('errors.skillSourceTooLarge'),
    SKILL_SOURCE_INVALID_RESPONSE: t('errors.skillSourceResponse'),
    SKILL_PACKAGES_UNSUPPORTED: t('errors.skillRuntimeOld'),
    SKILL_SYSTEM_READ_ONLY: t('errors.systemSkillReadOnly'),
    SKILL_SHARED_READ_ONLY: t('capabilities.sharedReadOnly'),
    MCP_SHARED_READ_ONLY: t('capabilities.newConnectionCredentials'),
    INVALID_SKILL: t('errors.invalidSkillInstructionsCheckSkillMdName'),
    SKILLS_UNAVAILABLE: t('common.skillsTemporarilyUnavailableOrdinaryChatExistingWorkspace'),
    SKILL_CONFLICT: t('errors.skillWasChangedElsewhereReviewCurrentRevision'),
    SKILL_BINDING_CONFLICT: t('errors.botSSkillSettingsChangedReviewRetry'),
    SKILL_NAME_CONFLICT: t('errors.skillNameAlreadyExistsContentWasNot'),
    SKILL_BOT_NOT_FOUND: t('errors.botProfilesHaveNotSyncedYetTry'),
    SKILL_NOT_FOUND: t('errors.skillNotFoundRefreshLibraryVerify'),
    SKILL_ARCHIVED: t('errors.skillTrashRestoreEnablingAgain'),
    SKILL_LIMIT: t('errors.skillLibraryLimitHasBeenReachedIncluding'),
    SKILL_ACTIVE_LIMIT: t('errors.upSkillsCanEnabledPerBotDisable'),
    COMPUTER_BUSY: t('errors.botHasOngoingTaskComputerActionRetry'),
    COMPUTER_CHANGING: t('errors.computerConnectingStoppingSendTasksReady'),
    COMPUTER_CONFLICT: t('errors.computerStateChangedVerifyAgain'),
    COMPUTER_CAPACITY: t('errors.allComputerSlotsOccupiedStopAnotherBot'),
    COMPUTER_BOT_NOT_FOUND: t('errors.botProfilesHaveNotSyncedYetTry'),
    COMPUTER_SERVICE_UNAVAILABLE: t('errors.computerServiceUnavailableOrdinaryChatWorkspaceRemain'),
    COMPUTER_STORE_UNAVAILABLE: t('errors.computerRecordsUnavailableExistingContentRetainedVerify'),
    COMPUTER_START_FAILED: t('errors.computerCouldNotConnectCheckExecutionEnvironment'),
    COMPUTER_STOP_UNCONFIRMED: t('errors.stopResultUnconfirmedSlotRemainsReservedVerify'),
    COMPUTER_RUNTIME_FAILED: t('errors.computerUnavailableOrdinaryChatWorkspaceRemainAvailable'),
    COMPUTER_RECOVERY_REQUIRED: t('errors.resourceCleanupUnconfirmedSaveContentOtherComputers'),
    COMPUTER_OUTCOME_UNKNOWN: t('errors.previousComputerActionUnconfirmedWillNotRetried'),
    COMPUTER_STOP_REQUIRED: t('errors.resourcesOldComputerRemainReservedVerifyStop'),
    COMPUTER_REQUEST_STORAGE_UNAVAILABLE: t(
      'errors.appOperationRecordsUnavailableVerifyComputerState',
    ),
    DESKTOP_VIEW_STALE: t('errors.computerInstanceScreenChangedOldOperationWas'),
    INVALID_GROUP_MESSAGE: t('errors.invalidMessageRecipientsCheckRetry'),
    INVALID_CHAT_REQUEST: t('errors.invalidConversationActionCheckBotCurrentConversation'),
    INVALID_CHAT_ACK: t('errors.conversationActionCouldNotConfirmedVerifyResult'),
    INVALID_TASK_ACK: t('errors.messageReceiptCouldNotConfirmedRetryChecking'),
    INVALID_CHAT_QUERY: t('errors.selectValidConversationHistoryNumber'),
    INVALID_CHAT_HISTORY: t('errors.historyResponseFailedValidationLoadAgain'),
    INVALID_TRANSCRIPT_PAGE: t('errors.executionHistoryDoesNotMatchCurrentTask'),
    INVALID_TRANSCRIPT_CONTENT: t('errors.stepContentDiffersCurrentRecordLoadAgain'),
    TRANSCRIPT_NOT_FOUND: t('errors.taskExecutionDetailsNotFoundOriginalConversation'),
    TRANSCRIPT_CORRUPT: t('errors.executionHistoryUnreadablePreserveOriginalDataRepair'),
    TRANSCRIPT_UNAVAILABLE: t('errors.executionHistoryTemporarilyUnavailableCheckLocalEnvironment'),
    CONVERSATION_TRASHED: t('trash.trashed'),
    CONVERSATION_CONFLICT: t('trash.changed'),
    CONVERSATION_RECEIPT_NOT_FOUND: t('errors.operationReceiptWasNotFoundYetCheck'),
    CONVERSATION_REQUEST_ID_REUSED: t('errors.operationIdDiffersOriginalRequestVerifyResult'),
    INVALID_CONVERSATION_REQUEST: t('trash.invalidRequest'),
    INVALID_CONVERSATION_ACK: t('trash.invalidAck'),
    CHAT_BUSY: t('errors.finishCurrentPrivateTaskStartingNewConversation'),
    CHAT_CONFLICT: t('errors.currentConversationChangedDraftRetainedVerifyRetry'),
    CHAT_REVISION_REQUIRED: t('errors.currentConversationWasUpdatedReopenSendingDraft'),
    CHAT_REQUEST_ID_REUSED: t('errors.operationIdDiffersOriginalRequestVerifyResult'),
    CHAT_RECEIPT_NOT_FOUND: t('errors.operationReceiptWasNotFoundYetCheck'),
    CHAT_NOT_FOUND: t('errors.conversationHistoryNotFoundCheckNumberRetry'),
    CHAT_HISTORY_TOO_LARGE: t('errors.historyRecordExceedsReadLimitOriginalRecord'),
    CHAT_HISTORY_CORRUPT: t('errors.historyUnreadablePreserveOriginalDataRepairing'),
    CHAT_CORRUPT: t('errors.conversationStateUnreadablePreserveOriginalDataRepair'),
    CHAT_UNAVAILABLE: t('errors.conversationsTemporarilyUnavailableCheckLocalRuntime'),
    CHAT_LIMIT: t('errors.conversationOperationLimitHasBeenReachedBack'),
    INVALID_GROUP_ACTION: t('errors.invalidGroupActionReviewGroupCurrentRevision'),
    INVALID_GROUP_ACTION_ACK: t('errors.groupActionCouldNotConfirmedVerifyResult'),
    GROUP_ARCHIVED: t('errors.groupArchivedHistoryRetainedRestoreSendNew'),
    GROUP_STATE_CONFLICT: t('errors.groupStateChangedCloseDialogVerifyAgain'),
    GROUP_REVISION_REQUIRED: t('errors.groupWasArchivedRestoredReopenSendingDraft'),
    GROUP_ACTION_ID_REUSED: t('errors.operationIdDiffersOriginalRequestVerifyGroup'),
    GROUP_ACTION_NOT_FOUND: t('errors.groupOperationReceiptWasNotFoundYet'),
    GROUP_ACTION_CORRUPT: t('errors.groupOperationReceiptsUnreadablePreserveOriginalData'),
    GROUP_ACTION_LIMIT: t('errors.groupOperationRecordLimitHasBeenReached'),
    GROUP_LIFECYCLE_UNAVAILABLE: t('errors.groupArchivingUnavailableUpdateReconnectRuntime'),
    GROUP_MEMBER_REQUIRED: t('errors.recipientsChangedSelectGroupMembersAgain'),
    GROUP_BUSY: t('errors.groupHasOngoingQueuedCollaborationWaitFinish'),
    GROUP_CONFLICT: t('errors.groupUpdatedCloseEditorReviewAgainDraft'),
    GROUP_ID_CONFLICT: t('errors.idAlreadyUsedBotCreateGroupAgain'),
    GROUP_LIMIT: t('errors.upGroupsCanSaved'),
    GROUP_QUEUE_LIMIT: t('errors.groupCanQueueUpTurnsWaitCurrent'),
    GROUP_STORAGE_LIMIT: t('errors.retainedGroupContentReachedMbExportInspect'),
    GROUP_REQUEST_ID_REUSED: t('errors.messageIdAlreadyHasDifferentContentVerify'),
    GROUP_NOT_FOUND: t('errors.groupNotFoundCheckConnectionReopen'),
    GROUP_UNAVAILABLE: t('errors.groupStorageUnavailableExistingContentNotReset'),
    GROUP_CORRUPT: t('errors.groupRecordsUnreadablePreserveOriginalFilesRepair'),
    GROUP_OUTCOME_UNKNOWN: t('errors.startupResultUnconfirmedWasInterruptedWillNotRerun'),
    GROUP_INPUT_NOT_FOUND: t('errors.groupMessageAttachmentNotFoundCheckOriginal'),
    INVALID_CREDENTIAL: t('common.checkApiKeyRemoveWhitespaceMakeSure'),
    INVALID_MODEL_SETTINGS: t('errors.invalidModelSettingsCheckModelSelectionKey'),
    MODEL_CONFIG_UNAVAILABLE: t('errors.modelSettingsCannotReadWrittenRightNow'),
    MODEL_OPERATION_UNKNOWN: t('models.operationUnknown'),
    TASK_OUTCOME_UNKNOWN: t('models.unknownToolRecovery'),
    MODEL_SETTINGS_BUSY: t('models.busy'),
    MODEL_FALLBACK_INVALID: t('models.fallbackInvalid'),
    MODEL_PROBE_CONFLICT: t('models.diagnosticsChanged'),
    MODEL_CREDENTIAL_REVOKED: t('models.credentialsRevoked'),
    MODEL_FALLBACK_VISION_REQUIRED: t('models.fallbackVisionRequired'),
    MODEL_FALLBACK_CONTEXT_REQUIRED: t('models.fallbackContextRequired'),
    MODEL_FALLBACK_TOOLS_REQUIRED: t('models.fallbackToolsRequired'),
    MODEL_FALLBACK_TOOLS_UNKNOWN: t('models.fallbackToolsUnknown'),
    MODEL_FALLBACK_UNAVAILABLE: t('models.fallbackUnavailable'),
    MODEL_SHUTDOWN_UNCONFIRMED: t('models.shutdownUnconfirmed'),
    MODEL_FENCE_UNAVAILABLE: t('models.fenceUnavailable'),
    MODEL_PROVIDER_AUTH: t('errors.providerRejectedKeyCheckApiKeyRetry'),
    MODEL_PROVIDER_QUOTA: t('errors.insufficientModelAccountQuotaCheckProviderAccount'),
    MODEL_PROVIDER_RATE_LIMIT: t('errors.tooManyModelRequestsRetryLater'),
    MODEL_PROVIDER_UNAVAILABLE: t('errors.unableReachModelServiceExistingSettingsUnchanged'),
    MODEL_PROVIDER_TIMEOUT: t('errors.modelServiceTimedOutTryAgainLater'),
    MODEL_PROVIDER_UNKNOWN: t('models.failure.unknown'),
    MODEL_SETTINGS_CONFLICT: t('errors.modelSettingsChangedElsewhereReviewCurrentSettings'),
    MODEL_SETTINGS_ID_REUSED: t('errors.saveAlreadyHasDifferentContentCloseEditor'),
    MODEL_SETTINGS_LIMIT: t('errors.modelSettingsReachedRevisionLimitBackUp'),
    MODEL_API_UNAUTHORIZED: t('errors.providerRejectedKeyCheckApiKeyRetry'),
    MODEL_DISCOVERY_UNAVAILABLE: t('errors.providerDoesNotExposeModelListEnter'),
    MODEL_DISCOVERY_LIMIT: t('errors.modelListTooLargePaginationFailedNarrow'),
    MODEL_API_TIMEOUT: t('errors.modelServiceTimedOutTryAgainLater'),
    MODEL_API_BALANCE: t('errors.insufficientModelAccountQuotaCheckProviderAccount'),
    MODEL_API_RATE_LIMIT: t('errors.tooManyModelRequestsRetryLater'),
    MODEL_API_UNAVAILABLE: t('errors.unableReachModelServiceExistingSettingsUnchanged'),
    MODEL_API_INVALID_RESPONSE: t(
      'errors.invalidProviderVerificationResponseExistingSettingsUnchanged',
    ),
    MODEL_API_MODEL_UNAVAILABLE: t('errors.providerDidNotAcceptModelCheckModel'),
    MODEL_UNAVAILABLE: t('errors.selectedModelUnconfiguredRemovedChooseAvailableModel'),
    MODEL_CREDENTIAL_REQUIRED: t('errors.providerNewApiUrlRequiresOwnApi'),
    EXECUTION_UPGRADE_REQUIRED: t('errors.updateLinuxRuntimeUsingModelSavedConfiguration'),
    INVALID_KNOWLEDGE: t('errors.checkDocumentNameContentUtfTextUp'),
    KNOWLEDGE_ENCODING: t('errors.saveFileUtfImportingAvoidCorruptingNon'),
    FILE_ENCODING: t('errors.saveTextUtfAddingAvoidCorruptingNon'),
    KNOWLEDGE_NOT_FOUND: t('errors.botProfileRequestedRevisionNotFoundRefresh'),
    KNOWLEDGE_CONFLICT: t('errors.documentChangedElsewhereDraftRetainedReviewCurrent'),
    KNOWLEDGE_PATH_EXISTS: t('errors.documentNameExistsIncludingTrashRenameEdit'),
    KNOWLEDGE_EDIT_MISMATCH: t('errors.sourceSnippetHasChangedReadAgainEditing'),
    KNOWLEDGE_EDIT_AMBIGUOUS: t('errors.sourceSnippetMatchesMultiplePlacesProvideMore'),
    KNOWLEDGE_LIMIT: t('errors.libraryReachedDocumentsMbCurrentContentOrganize'),
    KNOWLEDGE_UNAVAILABLE: t('errors.documentLibraryUnavailableCheckLocalRuntimeExisting'),
    KNOWLEDGE_CORRUPT: t('errors.documentLibraryStorageUnreadablePreserveOriginalFiles'),
    DOCUMENT_RUNTIME_TOO_OLD: t('errors.updateLocalRuntimeImportPdfOfficeFiles'),
    INVALID_DOCUMENT: t('errors.selectPdfDocxXlsxPptxFileUp'),
    DOCUMENT_UNAVAILABLE: t('files.documentsRequireLinux'),
    DOCUMENT_BUSY: t('errors.anotherDocumentBeingExtractedRetryShortlyExisting'),
    DOCUMENT_EMPTY: t('errors.noUsableTextWasExtractedRunOcr'),
    DOCUMENT_ENCRYPTED: t('errors.fileEncryptedDecryptLocallyImporting'),
    DOCUMENT_UNREADABLE: t('errors.fileCouldNotParsedCheckCorruptionVerify'),
    DOCUMENT_INCOMPLETE: t('errors.extractorReportedPossiblyMissingContentIncompleteDocuments'),
    DOCUMENT_LIMIT: t('errors.documentExceedsExtractionTimeComplexityKbText'),
    DOCUMENT_STORAGE_LIMIT: t('errors.originalImportsBotReachedMbLimitIncluding'),
    INVALID_SCHEDULE: t('errors.invalidNameTaskInstructionsTimingCheckRetry'),
    SCHEDULE_NOT_FOUND: t('errors.scheduledTaskNoLongerExistsRefreshCheck'),
    SCHEDULE_ID_REUSED: t('errors.creationRequestAlreadyHasDifferentContentVerify'),
    SCHEDULE_CONFLICT: t('errors.scheduleUpdatedReviewCurrentRevisionDraftRetained'),
    SCHEDULE_LOCKED: t('errors.lockedPlanSoBotCanOnlyRead'),
    SCHEDULE_LIMIT: t('errors.eachBotCanRetainScheduledTasksEnabled'),
    SCHEDULE_CORRUPT: t('errors.scheduleStorageUnreadableDispatchHasStoppedPreserve'),
    SCHEDULE_UNAVAILABLE: t('errors.schedulingUnavailableCheckLocalRuntimeRetry'),
    SCHEDULE_OUTCOME_UNKNOWN: t('errors.startupResultUnconfirmedWasInterruptedWillNot'),
    INVALID_ATTACHMENT_NAME: t('errors.shortenFilenameRemovePathsControlCharactersAdding'),
    INVALID_ATTACHMENT: t('errors.invalidAttachmentFormatNameSupportsTextPdf'),
    ATTACHMENT_RUNTIME_TOO_OLD: t('errors.updateLocalRuntimeUploadAttachmentTypeChat'),
    ATTACHMENT_NOT_FOUND: t('errors.botSAttachmentsUnavailableKeepDraftSelect'),
    ATTACHMENT_CORRUPT: t('errors.attachmentIntegrityCheckFailedWasNotSent'),
    ATTACHMENT_UNAVAILABLE: t('errors.attachmentStorageUnavailableCheckRuntimeExistingDocuments'),
    ATTACHMENT_TRASHED: t('errors.attachmentTrashRestoreFilesPanelUsing'),
    ATTACHMENT_BUSY: t('errors.taskUsingAttachmentWaitFinishStopTask'),
    ATTACHMENT_CONFLICT: t('errors.attachmentStateUpdatedRefreshConfirmTargetFile'),
    ATTACHMENT_NOT_TRASHED: t('errors.moveAttachmentTrashConfirmingPermanentDeletion'),
    ATTACHMENT_CONFIRMATION: t('errors.confirmationDoesNotMatchAttachmentPermanentDeletion'),
    ATTACHMENT_STORAGE_LIMIT: t('errors.retainedChatAttachmentStorageFullManageAttachments'),
    ATTACHMENT_TOO_LARGE: t('common.fileExceedsKbChooseSmallerTextFile'),
    INVALID_INTERACTION_REPLY: t('errors.replyIncompleteChoicesChangedCheckRetry'),
    INTERACTION_SAVE_FAILED: t('errors.taskStoppedButRequestStateCouldNot'),
    INTERACTION_CLOSED: t('errors.requestWasWithdrawnInterruptedCanNoLonger'),
    INTERACTION_CONFLICT: t('errors.requestAlreadyHasAnotherReplyRefreshView'),
    INTERACTION_NOT_FOUND: t('errors.noRequestFoundTaskRefreshCheckAgain'),
    INVALID_BOT_PROFILE: t('errors.invalidProfileParametersCheckNameRolePreferences'),
    INVALID_BOT_BUNDLE: t('errors.unrecognizedBotExportUseCompleteDabanUtf'),
    BOT_BUNDLE_LIMIT: t('errors.exportExceedsMibSelectFewerDocumentsOriginals'),
    INVALID_BOT_IMPORT_ACK: t('errors.receiptDoesNotMatchImportExistingContent'),
    BOT_IMPORT_ID_REUSED: t('errors.operationBoundDifferentContentSelectOriginalFile'),
    BOT_IMPORT_CANCELLED: t('errors.importWasCancelledLateSubmissionsWillNot'),
    BOT_IMPORT_COMMITTING: t('errors.contentBeingSavedWaitCompletionArchivingNew'),
    BOT_IMPORT_RETRY_REQUIRED: t('errors.savedProgressAlreadyExistsUseContinueVerification'),
    BOT_IMPORT_FILE_REQUIRED: t('errors.completeFileHasNotBeenReceivedSelect'),
    BOT_IMPORT_INTERRUPTED: t('errors.importWasInterruptedExistingProgressRetainedContinue'),
    BOT_IMPORT_CONFLICT: t('errors.existingContentDiffersImportRecordWasNot'),
    BOT_IMPORT_STORE: t('errors.importRecordsUnavailableExistingContentRetainedCheck'),
    BOT_IMPORT_STORE_CHANGED: t('errors.importRecordChangedElsewhereWasNotOverwritten'),
    BOT_IMPORT_LIMIT: t('errors.limitIncompleteImportsRetainedRecordsHasBeen'),
    BOT_TRANSFER_BUSY: t('errors.anotherBotImportExportProgressRetryShortly'),
    BOT_PROFILE_CONFLICT: t('errors.documentUpdatedReviewCurrentContentRetryDraft'),
    INVALID_MEMORY_HISTORY: t('errors.incompletePreferenceHistoryResponseRefreshRecentRevisions'),
    MEMORY_HISTORY_CORRUPT: t('errors.preferenceHistoryUnreadableCurrentContentRetainedBack'),
    BOT_PROFILE_CORRUPT: t('errors.botSDocumentsUnreadablePreserveOriginalFiles'),
    BOT_PROFILE_NOT_FOUND: t('errors.botProfileNotFoundReconnect'),
    RETRY_NOT_FOUND: t('errors.originalTaskRecordUnavailableSubmitInputFiles'),
    INVALID_RETRY: t('errors.originalTaskInputsUnavailableSubmitInputFiles'),
    STALE_CONTROL: t('errors.controlOwnershipChangedOldOperationWasRejected'),
    INVALID_BROWSER_FILE: t('errors.selectUpFilesNoPathsTheirNames'),
    INVALID_BROWSER_URL: t('errors.invalidWebpageUrlUsePublicHttpHttps'),
    BROWSER_HUMAN_REQUIRED: t('errors.webpageNeedsAttentionTakeOverBrowserPanel'),
    BROWSER_VIEW_STALE: t('errors.pageChangedInputOldScreenWasRejected'),
    BROWSER_INSTANCE_CHANGED: t('errors.browserRestartedCheckCurrentPageContinuing'),
    BROWSER_PROMPT_STALE: t('errors.webpageRequestChangedEndedReviewCurrentRequest'),
    BROWSER_PROMPT_TRUNCATED: t(
      'errors.webpageDescriptionIncompleteConfirmationBlockedCancelRequest',
    ),
    BROWSER_STATE_UNAVAILABLE: t('errors.browserRecordsUnavailableKeepDataCheckRuntime'),
    BROWSER_REQUEST_STORAGE_UNAVAILABLE: t('errors.localBrowserOperationRecordsCannotReadWritten'),
    BROWSER_OUTCOME_UNKNOWN: t('errors.operationResultUnconfirmedWillNotRetriedAutomatically'),
    MODEL_ALREADY_RUNNING: t('errors.botWorkingTaskWaitStopCurrentTask'),
    MODEL_NOT_RUNNING: t('errors.taskEndedMessageKeptQueue'),
    GOAL_REQUIRES_NEW_TASK: t('errors.goalRequiresNewTask'),
    GOAL_ROUND_LIMIT: t('errors.goalRoundLimit'),
    GOAL_INCOMPLETE: t('errors.goalIncomplete'),
    TASK_INCOMPLETE: t('errors.taskIncomplete'),
    GOAL_BLOCKED: t('errors.goalBlocked'),
    MODEL_INSERT_FULL: t('errors.taskInsertFullMessageKeptQueue'),
    MODEL_INSERT_UNCERTAIN: t('errors.taskInsertUncertainMessageNotReplayed'),
    TASK_INSERT_STALE: t('errors.taskInsertStaleMessageKeptQueue'),
    INVALID_TASK_INSERT: t('errors.invalidTaskInsertMessageKeptQueue'),
    MODEL_NOT_CONFIGURED: t('errors.addProviderConfigureModelFirst'),
    MODEL_COMPUTER_UNSUPPORTED: t('errors.currentModelCannotObserveDesktopsChooseImage'),
    MODEL_IMAGE_UNSUPPORTED: t('errors.currentModelDoesNotSupportImagesChoose'),
    IMAGE_UNREADABLE: t('errors.imageCouldNotReadCheckCorruptionSave'),
    IMAGE_PREVIEW_UNAVAILABLE: t('errors.staticFirstFramePreviewCouldNotGenerated'),
    IMAGE_LIMIT: t('errors.imageDimensionsTooLargeResizeMostPixels'),
    RUNTIME_TOO_OLD: t('errors.runtimeUpdateRequiredSendingOldAcceptanceProgram'),
    RUNTIME_SESSION_CHANGED: t('errors.executionEnvironmentReconnectedCheckTaskStateRetrying'),
    INVALID_TASK: t('errors.invalidTaskAttachmentParametersEditResend'),
    INVALID_COMMAND: t('errors.invalidOperationParametersRetry'),
    RUNTIME_OFFLINE: t('errors.localRuntimeNotConnectedRetrySettings'),
    RUNTIME_RECOVERY_PENDING: t('errors.runtimeRecoveryNeedsVerificationNewTasksComputer'),
    RECOVERY_BUSY: t('errors.recoveryProgressCheckCurrentPhase'),
    RECOVERY_NEEDS_START: t('errors.runtimeStoppedVerifyRecoveryReceiptThenStart'),
    RECOVERY_TASKS_RUNNING: t('errors.finishTasksRunningAwaitingRepliesRecoveringEntire'),
    RECOVERY_CHANGES_RUNNING: t('errors.submittedOperationStillProgressVerifyAgainShortly'),
    RECOVERY_REVIEW_CHANGED: t('errors.runtimeComputerStateChangedReviewConfirmAgain'),
    RECOVERY_SCOPE_CHANGED: t('errors.originalApprovalScopeHasChangedReceiptRetained'),
    RECOVERY_DRAIN_TIMEOUT: t('errors.queuedWorkStillBeingPreparedEnvironmentHas'),
    RECOVERY_HOST_STORE_UNAVAILABLE: t('errors.localRecoveryRecordsUnavailableKeepExistingData'),
    RECOVERY_STORE_UNAVAILABLE: t('errors.linuxRecoveryRecordsTemporarilyUnavailableKeepExisting'),
    RECOVERY_TARGET_CHANGED: t('errors.connectionConfigurationChangedOldRecoveryRecordsRetained'),
    RECOVERY_STOP_UNCONFIRMED: t('errors.shutdownResultUnconfirmedVerifyFirstAppWill'),
    RECOVERY_START_UNCONFIRMED: t('errors.startupResultUnconfirmedCheckEnvironmentDecidingWhether'),
    RECOVERY_OUTCOME_UNKNOWN: t('errors.operationResultNeedsVerificationReadOriginalReceipt'),
    RECOVERY_ALREADY_CLAIMED: t(
      'errors.recoveryAlreadyExecutingCannotCancelledUnexecutedOperation',
    ),
    RECOVERY_ALREADY_ISSUED: t('errors.shutdownRequestMayAlreadyHaveBeenSent'),
    RECOVERY_REQUEST_NOT_OWNED: t('errors.clientHasNoMatchingRecoveryRecordVerify'),
  };
  return Object.hasOwn(messages, code) ? messages[code] : fallback;
}
