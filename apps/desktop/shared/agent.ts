import { type RuntimeSnapshot, recoveryBlocked } from '@daban/protocol';
export const legacyAgentError = 'AGENT_LEGACY_RESTART_REQUIRED';
export function agentUpgradeBlocked(snapshot: RuntimeSnapshot) {
  if (
    snapshot.phase !== 'ready' ||
    !snapshot.model.available ||
    snapshot.protocolVersion < 24 ||
    !snapshot.schedules?.available ||
    !snapshot.groups?.available
  )
    return 'AGENT_LEGACY_RESTART_UNAVAILABLE';
  if (
    recoveryBlocked(snapshot) ||
    Object.values(snapshot.agents).some((task) => task.running) ||
    snapshot.computers?.items.some((computer) =>
      ['connecting', 'stopping'].includes(computer.phase),
    ) ||
    snapshot.schedules.items.some((schedule) =>
      schedule.history.some((firing) => ['pending', 'claimed', 'running'].includes(firing.state)),
    )
  )
    return 'AGENT_UPDATE_BUSY';
  if (snapshot.schedules.items.some((schedule) => schedule.enabled))
    return 'AGENT_LEGACY_SCHEDULES_ACTIVE';
  return undefined;
}
