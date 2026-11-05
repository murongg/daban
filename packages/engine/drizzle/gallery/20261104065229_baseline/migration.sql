CREATE TABLE `gallery_releases` (
	`template` text NOT NULL,
	`version` text NOT NULL,
	`content` text NOT NULL,
	CONSTRAINT `gallery_releases_pk` PRIMARY KEY(`template`, `version`)
);
--> statement-breakpoint
CREATE TABLE `gallery_requests` (
	`key` text PRIMARY KEY,
	`fingerprint` text NOT NULL,
	`result` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `gallery_sessions` (
	`hash` text PRIMARY KEY,
	`token` text NOT NULL,
	`csrf` text NOT NULL,
	`expires` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `gallery_settings` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `gallery_templates` (
	`id` text PRIMARY KEY,
	`namespace` text NOT NULL,
	`slug` text NOT NULL,
	`content` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `gallery_tokens` (
	`id` text PRIMARY KEY,
	`hash` text NOT NULL UNIQUE,
	`principal` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gallery_namespace_slug` ON `gallery_templates` (`namespace`,`slug`);