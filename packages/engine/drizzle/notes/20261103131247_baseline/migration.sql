CREATE TABLE `note_items` (
	`seq` integer PRIMARY KEY AUTOINCREMENT,
	`bot` text NOT NULL,
	`id` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`status` text NOT NULL,
	`revision` integer NOT NULL,
	`deleted` integer NOT NULL,
	`created` text NOT NULL,
	`updated` text NOT NULL,
	`completed` text,
	`creator` text NOT NULL,
	`editor` text NOT NULL,
	CONSTRAINT `note_items_bot_id_unique` UNIQUE(`bot`,`id`)
) STRICT;
--> statement-breakpoint
CREATE TABLE `note_meta` (
	`bot` text PRIMARY KEY,
	`revision` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `note_operations` (
	`bot` text NOT NULL,
	`id` text NOT NULL,
	`note` text NOT NULL,
	`signature` text NOT NULL,
	`revision` integer NOT NULL,
	`at` text NOT NULL,
	CONSTRAINT `note_operations_pk` PRIMARY KEY(`bot`, `id`),
	CONSTRAINT `fk_note_operations_bot_note_note_items_bot_id_fk` FOREIGN KEY (`bot`,`note`) REFERENCES `note_items`(`bot`,`id`)
) STRICT;
