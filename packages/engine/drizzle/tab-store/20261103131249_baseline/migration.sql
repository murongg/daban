CREATE TABLE `browser_active` (
	`bot` text PRIMARY KEY,
	`tab` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `browser_commands` (
	`id` text PRIMARY KEY,
	`bot` text NOT NULL,
	`signature` text NOT NULL,
	`phase` text NOT NULL,
	`error` text,
	`uncertain` integer
) STRICT;
--> statement-breakpoint
CREATE TABLE `browser_meta` (
	`id` integer PRIMARY KEY,
	`revision` integer NOT NULL,
	CONSTRAINT "browser_meta_singleton" CHECK("id" = 1)
) STRICT;
--> statement-breakpoint
CREATE TABLE `browser_tabs` (
	`id` text PRIMARY KEY,
	`bot` text NOT NULL,
	`url` text NOT NULL,
	`title` text NOT NULL,
	`position` integer NOT NULL
) STRICT;
