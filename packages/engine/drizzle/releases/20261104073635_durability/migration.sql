CREATE TABLE `release_reservations` (
	`id` text PRIMARY KEY,
	`fingerprint` text NOT NULL,
	`bot` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `release_history` ADD `at` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `release_plans` ADD `cancelled` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `release_plans` ADD `committed` text;