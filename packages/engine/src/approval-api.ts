import type { ApprovalRulesCommand } from '@daban/protocol';
import type { ModelRuns } from './model.js';

export async function approvalCommand(models: ModelRuns, command: ApprovalRulesCommand) {
  const scope = command.type === 'approval.rules.write' ? command.request.scope : command.scope;
  models.profiles.assertRegistered(scope.bot);
  if (command.type === 'approval.rules.write') models.profiles.assertActive(scope.bot);
  switch (command.type) {
    case 'approval.rules.list':
      return models.approvalRules.snapshot(scope);
    case 'approval.rules.write':
      return models.approvalRules.write(command.request);
    case 'approval.rules.receipt':
      return models.approvalRules.receipt(scope, command.requestId);
    case 'approval.rules.preview':
      return models.approvalRules.evaluate(
        {
          scope,
          selector: command.selector,
          trigger: command.trigger,
          mode: command.mode,
          baseline: command.mode === 'full' ? 'allow' : 'ask',
          allowEligible: false,
        },
        command.rule,
      );
  }
}
