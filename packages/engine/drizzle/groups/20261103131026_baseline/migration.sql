CREATE TABLE `group_actions` (
	`id` text PRIMARY KEY,
	`grp` text NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `group_collaborations` (
	`source` text PRIMARY KEY,
	`grp` text NOT NULL,
	`turn` text NOT NULL,
	`signature` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `group_defs` (
	`id` text PRIMARY KEY,
	`value` text NOT NULL,
	`copy_origin` text
);
--> statement-breakpoint
CREATE TABLE `group_deliveries` (
	`id` text PRIMARY KEY,
	`grp` text NOT NULL,
	`source` text NOT NULL,
	`bot` text NOT NULL,
	`position` integer NOT NULL,
	`state` text NOT NULL,
	`run` text,
	`context` text,
	`name` text,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `group_handoffs` (
	`source` text PRIMARY KEY,
	`signature` text NOT NULL,
	`target` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `group_messages` (
	`seq` integer PRIMARY KEY AUTOINCREMENT,
	`id` text NOT NULL,
	`grp` text NOT NULL,
	`source` text NOT NULL,
	`role` text NOT NULL,
	`text` text NOT NULL,
	`created` text NOT NULL,
	`author` text,
	`name` text,
	`phase` text,
	`model` text,
	`files` text,
	`run` text,
	CONSTRAINT `group_messages_grp_id` UNIQUE(`grp`,`id`)
);
--> statement-breakpoint
CREATE TABLE `group_meta` (
	`id` integer PRIMARY KEY,
	`revision` integer NOT NULL,
	CONSTRAINT "group_meta_singleton" CHECK("id" = 1)
);
--> statement-breakpoint
CREATE TABLE `group_turns` (
	`grp` text NOT NULL,
	`id` text NOT NULL,
	`prompt` text NOT NULL,
	`recipients` text NOT NULL,
	`signature` text NOT NULL,
	`seq` integer,
	`created` text NOT NULL,
	`state` text NOT NULL,
	`inputs` text DEFAULT '[]' NOT NULL,
	CONSTRAINT `group_turns_pk` PRIMARY KEY(`grp`, `id`)
);
--> statement-breakpoint
CREATE INDEX `group_actions_owner` ON `group_actions` (`grp`);--> statement-breakpoint
CREATE INDEX `group_deliveries_queue` ON `group_deliveries` (`grp`,`source`,`position`);--> statement-breakpoint
CREATE INDEX `group_messages_page` ON `group_messages` (`grp`,`seq`);