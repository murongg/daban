CREATE TABLE `remote_devices` (
	`id` text PRIMARY KEY,
	`publicKey` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`server` text NOT NULL,
	`workspace` text NOT NULL,
	`platform` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `remote_receipts` (
	`device` text NOT NULL,
	`id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`phase` text NOT NULL,
	`result` text,
	`created` integer NOT NULL,
	CONSTRAINT `remote_receipts_pk` PRIMARY KEY(`device`, `id`)
) STRICT;
--> statement-breakpoint
CREATE TABLE `remote_settings` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL
) STRICT;
