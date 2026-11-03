CREATE TABLE `documents` (
	`id` text PRIMARY KEY,
	`bot` text NOT NULL,
	`path` text NOT NULL,
	`revision` integer NOT NULL,
	`content` text NOT NULL,
	`bytes` integer NOT NULL,
	`deleted` integer NOT NULL,
	`created` text NOT NULL,
	`updated` text NOT NULL,
	CONSTRAINT `documents_bot_path` UNIQUE(`bot`,`path`)
);
--> statement-breakpoint
CREATE TABLE `knowledge_imports` (
	`bot` text PRIMARY KEY,
	`digest` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `revisions` (
	`document` text NOT NULL,
	`revision` integer NOT NULL,
	`path` text NOT NULL,
	`content` text NOT NULL,
	`bytes` integer NOT NULL,
	`deleted` integer NOT NULL,
	`at` text NOT NULL,
	`actor` text NOT NULL,
	`run` text,
	CONSTRAINT `revisions_pk` PRIMARY KEY(`document`, `revision`)
);
--> statement-breakpoint
CREATE TABLE `sources` (
	`document` text PRIMARY KEY,
	`bot` text NOT NULL,
	`name` text NOT NULL,
	`bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`data` blob NOT NULL,
	CONSTRAINT `sources_bot_name` UNIQUE(`bot`,`name`)
);
--> statement-breakpoint
CREATE INDEX `document_owner` ON `documents` (`bot`,`deleted`,`updated`);