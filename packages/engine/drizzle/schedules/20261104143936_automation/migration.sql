CREATE TABLE `automation_events` (
	`id` text PRIMARY KEY,
	`schedule` text NOT NULL,
	`configRevision` integer NOT NULL,
	`cursor` integer NOT NULL,
	`before` text NOT NULL,
	`after` text NOT NULL,
	`paths` text NOT NULL,
	`observed` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `automations` (
	`schedule` text PRIMARY KEY,
	`configRevision` integer NOT NULL,
	`policy` text NOT NULL,
	`committed` text,
	`candidate` text,
	`consecutive` integer DEFAULT 0 NOT NULL,
	`cursor` integer DEFAULT 0 NOT NULL,
	`nextPoll` integer DEFAULT 0 NOT NULL,
	`observeError` text,
	`resultDigest` text,
	`resultError` text,
	`noticeRevision` integer DEFAULT 0 NOT NULL,
	`notice` text
) STRICT;
--> statement-breakpoint
ALTER TABLE `firings` ADD `source` text;--> statement-breakpoint
ALTER TABLE `firings` ADD `monitor` text;