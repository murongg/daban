# Scheduled tasks

[User guide](README.md) · [简体中文](../zh-CN/schedules.md)

Select a Bot and open **Schedules**. At the configured time, the backend submits work to that Bot and returns results to its conversation.

Only time-based schedules remain. File-change triggers and quiet monitoring have been removed. After upgrading, old file monitors stop triggering; already started tasks and their execution history are retained.

## Create a schedule

1. Enter a name and complete task instructions.
2. Select one-time, daily, weekdays, Friday, selected weekly days, interval, or Cron.
3. Enter the required date, time, interval, or expression and check the time zone, such as `Asia/Shanghai`.
4. Review upcoming occurrences, save, and check whether the schedule is enabled.

Example: “At 18:00 on weekdays, summarize the work records I supplied and retained; state when records are missing rather than inventing them.” Execution depends on the models, sources, network, and permissions available at that time.

## Enable, pause, and lock

- The enable switch controls future triggering.
- Locking protects a plan from modification; it does not pause execution. Bots cannot remove a human lock. Unlock manually before editing a locked plan.
- Run-now submits a task; a busy Bot may wait until available.
- Review pending firings and recent history after frequency changes, pausing, or removal. These actions do not necessarily reverse external work already started.

## Inspect results

Recent firings show pending, running, completed, failed, interrupted, withdrawn, and related states. Open the Bot's conversation to inspect the actual result. Coalesced pending work does not mean every missed occurrence will be replayed separately.

Verify an uncertain save through the original request instead of creating another schedule. Each execution can incur model charges; begin with longer intervals.

## Execution requirements

Scheduling runs in the local background service, not a hosted cloud scheduler. The execution computer must be powered on, awake, connected, and have its backend available. Quitting the client can leave background work running, but it stops discovering new desktop notifications and revokes native desktop authorization.

Graphical tasks also depend on computer connections, slots, and authorization. Archiving a Bot pauses relevant automation; review and manually re-enable it after restoration. Group schedules are not currently available.
