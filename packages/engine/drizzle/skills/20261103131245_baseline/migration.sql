CREATE TABLE `skill_bindings` (
	`bot` text NOT NULL,
	`skill` text NOT NULL,
	`revision` integer NOT NULL,
	`enabled` integer NOT NULL,
	CONSTRAINT `skill_bindings_pk` PRIMARY KEY(`bot`, `skill`)
);
--> statement-breakpoint
CREATE TABLE `skill_files` (
	`package` text NOT NULL,
	`path` text NOT NULL,
	`data` blob NOT NULL,
	`sha` text NOT NULL,
	`executable` integer NOT NULL,
	CONSTRAINT `skill_files_pk` PRIMARY KEY(`package`, `path`)
);
--> statement-breakpoint
CREATE TABLE `skill_meta` (
	`id` integer PRIMARY KEY,
	`revision` integer NOT NULL,
	CONSTRAINT "skill_meta_singleton" CHECK("id" = 1)
);
--> statement-breakpoint
CREATE TABLE `skill_packages` (
	`digest` text PRIMARY KEY,
	`manifest` text NOT NULL,
	`bytes` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `skills` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`revision` integer NOT NULL,
	`content` text NOT NULL,
	`deleted` integer NOT NULL,
	`created` text NOT NULL,
	`updated` text NOT NULL,
	`resources` text,
	`owner` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skill_owner_name` ON `skills` (COALESCE("owner", ''),`name`);
--> statement-breakpoint
INSERT INTO `skill_meta` (`id`, `revision`) VALUES (1, 0);
