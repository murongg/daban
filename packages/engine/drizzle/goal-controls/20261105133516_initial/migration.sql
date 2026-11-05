CREATE TABLE `goal_grants` (
	`id` text PRIMARY KEY,
	`owner` text NOT NULL,
	`run` text NOT NULL,
	`target` text NOT NULL,
	`epoch` integer NOT NULL,
	`fingerprint` text NOT NULL,
	`claimed` integer DEFAULT false NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `goal_human_turns` (
	`id` text PRIMARY KEY,
	`owner` text NOT NULL,
	`epoch` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `goal_humans` (
	`owner` text PRIMARY KEY,
	`epoch` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `goal_links` (
	`owner` text PRIMARY KEY,
	`session` text NOT NULL,
	`goal` text NOT NULL,
	`revision` integer NOT NULL
) STRICT;
