CREATE TABLE `approval_rule_edits` (
	`id` text PRIMARY KEY,
	`bot` text NOT NULL,
	`hash` text NOT NULL,
	`receipt` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `approval_rule_meta` (
	`id` integer PRIMARY KEY,
	`revision` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `approval_rules` (
	`id` text PRIMARY KEY,
	`bot` text NOT NULL,
	`revision` integer NOT NULL,
	`deleted` integer NOT NULL,
	`value` text NOT NULL
);
