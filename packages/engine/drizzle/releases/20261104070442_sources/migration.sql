CREATE TABLE `release_sources` (
	`origin` text PRIMARY KEY,
	`sourceId` text NOT NULL,
	`name` text NOT NULL,
	`token` text
);
--> statement-breakpoint
ALTER TABLE `release_drafts` ADD `bot` text;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_release_drafts` (
	`bot` text UNIQUE,
	`template` text PRIMARY KEY,
	`revision` integer NOT NULL,
	`content` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_release_drafts`(`template`, `revision`, `content`) SELECT `template`, `revision`, `content` FROM `release_drafts`;--> statement-breakpoint
DROP TABLE `release_drafts`;--> statement-breakpoint
ALTER TABLE `__new_release_drafts` RENAME TO `release_drafts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;