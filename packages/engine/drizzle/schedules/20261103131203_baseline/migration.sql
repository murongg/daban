CREATE TABLE `firings` (
	`id` text PRIMARY KEY,
	`schedule` text NOT NULL,
	`bot` text NOT NULL,
	`occurrence` text NOT NULL,
	`created` text NOT NULL,
	`state` text NOT NULL,
	`prompt` text NOT NULL,
	`run` text,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` text PRIMARY KEY,
	`bot` text NOT NULL,
	`input` text NOT NULL,
	`record` text NOT NULL,
	`revision` integer NOT NULL,
	`enabled` integer NOT NULL,
	`deleted` integer DEFAULT 0 NOT NULL,
	`created` text NOT NULL,
	`updated` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `firing_schedule` ON `firings` (`schedule`,`created`);--> statement-breakpoint
CREATE INDEX `firing_pending` ON `firings` (`state`,`created`);