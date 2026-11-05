import type { ApprovalRulesCommand } from '@daban/protocol';
import { Fault } from './control.js';
import type { ModelRuns } from './model.js';

export async function approvalCommand(models: ModelRuns, command: ApprovalRulesCommand) {
  const scope = command.type === 'approval.rules.write' ? command.request.scope : command.scope;
  const current = () => {
    if (scope.kind === 'bot') {
      models.profiles.assertRegistered(scope.bot);
      if (command.type === 'approval.rules.write') models.profiles.assertActive(scope.bot);
    } else throw new Fault('PROJECT_RETIRED', 409);
  };
  // Original edit receipts remain readable after scope revision changes or archive; this never renews execution authority.
  if (command.type === 'approval.rules.receipt')
    return models.approvalRules.receipt(scope, command.requestId);
  if (command.type === 'approval.rules.write')
    return models.approvalRules.write(command.request, current);
  if (command.type === 'approval.rules.list') {
    if (scope.kind === 'bot') models.profiles.assertRegistered(scope.bot);
    else throw new Fault('PROJECT_RETIRED', 409);
    return models.approvalRules.snapshot(scope);
  }
  current();
  switch (command.type) {
    case 'approval.rules.preview': {
      const result = await models.approvalRules.evaluate(
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
      current();
      return result;
    }
  }
}
