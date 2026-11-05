CREATE TABLE `release_drafts` (
	`template` text PRIMARY KEY,
	`revision` integer NOT NULL,
	`content` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `release_history` (
	`bot` text NOT NULL,
	`revision` integer NOT NULL,
	`snapshot` text NOT NULL,
	`base` text NOT NULL,
	`version` text NOT NULL,
	CONSTRAINT `release_history_pk` PRIMARY KEY(`bot`, `revision`)
);
--> statement-breakpoint
CREATE TABLE `release_installations` (
	`bot` text PRIMARY KEY,
	`template` text NOT NULL,
	`version` text NOT NULL,
	`base` text NOT NULL,
	`snapshot` text NOT NULL,
	`source` text,
	`revision` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `release_operations` (
	`id` text PRIMARY KEY,
	`fingerprint` text NOT NULL,
	`result` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `release_packages` (
	`digest` text PRIMARY KEY,
	`bytes` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `release_plans` (
	`id` text PRIMARY KEY,
	`bot` text NOT NULL,
	`revision` integer NOT NULL,
	`content` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `release_snapshots` (
	`digest` text PRIMARY KEY,
	`content` text NOT NULL
);
