import {
  diagnosticModel,
  isModelSaved,
  type ModelDiagnoseRequest,
  type ModelDiagnostic,
  type RuntimeCommand,
} from '@daban/protocol';

export class ModelProbeError extends Error {
  constructor(
    code: string,
    readonly settled = false,
  ) {
    super(code);
  }
}
export function modelProbeSettled(error: unknown) {
  return (
    (error instanceof ModelProbeError && error.settled) ||
    (error instanceof Error &&
      [
        'INVALID_MODEL_SETTINGS',
        'MODEL_SETTINGS_CONFLICT',
        'MODEL_SCOPE_MISMATCH',
        'MODEL_PROBE_CONFLICT',
        'MODEL_CREDENTIAL_REQUIRED',
        'MODEL_SETTINGS_ID_REUSED',
        'MODEL_SETTINGS_BUSY',
        'MODEL_SETTINGS_LIMIT',
      ].includes(error.message))
  );
}
export async function modelProbe(
  command: (value: RuntimeCommand) => Promise<unknown>,
  input: ModelDiagnoseRequest,
  queryOnly: boolean,
): Promise<ModelDiagnostic> {
  const result = await command(
    queryOnly
      ? {
          type: 'model.saved',
          input: {
            scope: input.scope,
            requestId: input.requestId,
            revision: input.revision,
            connection: input.connection.id,
            model: diagnosticModel(input),
          },
        }
      : { type: 'model.diagnose', input },
  );
  if (
    !isModelSaved(result) ||
    result.scope !== input.scope ||
    result.requestId !== input.requestId ||
    result.revision !== input.revision ||
    result.connection !== input.connection.id ||
    result.model !== diagnosticModel(input) ||
    result.kind !== 'diagnose'
  )
    throw new ModelProbeError('INVALID_RUNTIME_STATE');
  if (result.phase !== 'settled') throw new ModelProbeError('MODEL_OPERATION_UNKNOWN');
  if (result.error) throw new ModelProbeError(result.error, true);
  if (!result.diagnostic || result.diagnostic.kind !== input.kind)
    throw new ModelProbeError('INVALID_RUNTIME_STATE');
  return result.diagnostic;
}
