CREATE TABLE `work_comments` (
	`seq` integer PRIMARY KEY AUTOINCREMENT,
	`id` text NOT NULL UNIQUE,
	`item` text NOT NULL,
	`body` text NOT NULL,
	`creator` text NOT NULL,
	`signature` text NOT NULL,
	`revision` integer NOT NULL,
	`at` text NOT NULL,
	CONSTRAINT `fk_work_comments_item_work_items_id_fk` FOREIGN KEY (`item`) REFERENCES `work_items`(`id`)
) STRICT;
--> statement-breakpoint
CREATE TABLE `work_items` (
	`seq` integer PRIMARY KEY AUTOINCREMENT,
	`id` text NOT NULL UNIQUE,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`progress` text NOT NULL,
	`status` text NOT NULL,
	`revision` integer NOT NULL,
	`deleted` integer NOT NULL,
	`created` text NOT NULL,
	`updated` text NOT NULL,
	`completed` text,
	`creator` text NOT NULL,
	`editor` text NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`assignee` text,
	CONSTRAINT "work_items_priority" CHECK("priority" IN ('low','normal','high','urgent'))
) STRICT;
--> statement-breakpoint
CREATE TABLE `work_meta` (
	`id` integer PRIMARY KEY,
	`revision` integer NOT NULL,
	`comments` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "work_meta_singleton" CHECK("id" = 1),
	CONSTRAINT "work_meta_comments" CHECK("comments" >= 0)
) STRICT;
--> statement-breakpoint
CREATE TABLE `work_operations` (
	`id` text PRIMARY KEY,
	`item` text NOT NULL,
	`signature` text NOT NULL,
	`revision` integer NOT NULL,
	`at` text NOT NULL,
	CONSTRAINT `fk_work_operations_item_work_items_id_fk` FOREIGN KEY (`item`) REFERENCES `work_items`(`id`)
) STRICT;
--> statement-breakpoint
INSERT INTO `work_meta` (`id`, `revision`, `comments`) VALUES (1, 0, 0);
