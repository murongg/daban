CREATE TABLE `computer_commands` (
	`id` text PRIMARY KEY,
	`bot` text NOT NULL,
	`signature` text NOT NULL,
	`action` text NOT NULL,
	`phase` text NOT NULL,
	`error` text,
	`uncertain` integer DEFAULT 0 NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `computer_meta` (
	`id` integer PRIMARY KEY,
	`revision` integer NOT NULL,
	CONSTRAINT "computer_meta_singleton" CHECK("id" = 1)
) STRICT;
--> statement-breakpoint
CREATE TABLE `computers` (
	`bot` text PRIMARY KEY,
	`revision` integer NOT NULL,
	`phase` text NOT NULL,
	`desired` integer NOT NULL,
	`slot` integer UNIQUE,
	`instance` text,
	`boot` text NOT NULL,
	`error` text,
	`recovery` text,
	`updated` text NOT NULL
) STRICT;
