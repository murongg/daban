CREATE TABLE `transcript_events` (
	`run` text NOT NULL,
	`seq` integer NOT NULL,
	`source` text NOT NULL,
	`meta` text NOT NULL,
	`body` text NOT NULL,
	CONSTRAINT `transcript_events_pk` PRIMARY KEY(`run`, `seq`),
	CONSTRAINT `transcript_events_run_source` UNIQUE(`run`,`source`)
);
--> statement-breakpoint
CREATE TABLE `transcript_runs` (
	`run` text PRIMARY KEY,
	`scope` text NOT NULL,
	`state` text NOT NULL
);
