CREATE TABLE `purges` (
	`bot` text NOT NULL,
	`id` text NOT NULL,
	`version` text NOT NULL,
	`confirmation` text NOT NULL,
	CONSTRAINT `purges_pk` PRIMARY KEY(`bot`, `id`, `version`)
);
--> statement-breakpoint
CREATE TABLE `uploads` (
	`bot` text NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`data` blob NOT NULL,
	`content` text NOT NULL,
	`deleted` integer DEFAULT 0 NOT NULL,
	`version` text,
	`previous` text,
	CONSTRAINT `uploads_pk` PRIMARY KEY(`bot`, `id`)
);
