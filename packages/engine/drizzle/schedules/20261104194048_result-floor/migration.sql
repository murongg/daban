ALTER TABLE `automations` ADD `resultFloor` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Old files have no ownership checkpoint; a pending receipt may already have cleared its monitor.
UPDATE automations SET resultFloor = COALESCE((
  SELECT MAX(firings.rowid) FROM firings
  WHERE firings.schedule = automations.schedule
    AND json_extract(firings.source, '$.configRevision') = automations.configRevision
    AND (firings.monitor IS NOT NULL OR (
      automations.resultError IS NOT NULL
      AND firings.state IN ('claimed', 'running', 'completed', 'failed', 'interrupted')
    ))
), 0);
--> statement-breakpoint
-- A capability fault requires a firing accepted after the fault, even when the executor returns.
UPDATE automations SET resultFloor = COALESCE((
  SELECT MAX(firings.rowid) FROM firings
  WHERE firings.schedule = automations.schedule
    AND json_extract(firings.source, '$.configRevision') = automations.configRevision
), 0) + 1
WHERE resultError = 'AUTOMATION_MONITOR_UNAVAILABLE';
