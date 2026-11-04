CREATE TABLE `project_bindings` (
	`project` text PRIMARY KEY,
	`value` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `project_items` (
	`id` text PRIMARY KEY,
	`value` text NOT NULL,
	`revision` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `project_operations` (
	`id` text PRIMARY KEY,
	`signature` text NOT NULL,
	`request` text NOT NULL,
	`resources` text NOT NULL,
	`receipt` text NOT NULL
) STRICT;
