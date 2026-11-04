CREATE TABLE `project_candidates` (
	`id` text PRIMARY KEY,
	`project` text NOT NULL,
	`scopeRevision` integer NOT NULL,
	`proposer` text NOT NULL,
	`revision` integer NOT NULL,
	`state` text NOT NULL,
	`content` text NOT NULL,
	`reason` text NOT NULL,
	`refs` text NOT NULL,
	`digest` text NOT NULL,
	`created` text NOT NULL,
	`updated` text NOT NULL,
	`reviewed` text,
	CONSTRAINT `project_candidate_dedup` UNIQUE(`project`,`scopeRevision`,`proposer`,`digest`)
);
--> statement-breakpoint
CREATE TABLE `project_documents` (
	`id` text PRIMARY KEY,
	`project` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`revision` integer NOT NULL,
	`content` text NOT NULL,
	`bytes` integer NOT NULL,
	`deleted` integer NOT NULL,
	`origin` text,
	`created` text NOT NULL,
	`updated` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `project_memory_operations` (
	`project` text NOT NULL,
	`actor` text NOT NULL,
	`request` text NOT NULL,
	`signature` text NOT NULL,
	`result` text NOT NULL,
	CONSTRAINT `project_memory_operations_pk` PRIMARY KEY(`project`, `actor`, `request`)
);
--> statement-breakpoint
CREATE TABLE `project_revisions` (
	`project` text NOT NULL,
	`document` text NOT NULL,
	`revision` integer NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`bytes` integer NOT NULL,
	`deleted` integer NOT NULL,
	`origin` text,
	`at` text NOT NULL,
	CONSTRAINT `project_revisions_pk` PRIMARY KEY(`project`, `document`, `revision`)
);
--> statement-breakpoint
CREATE INDEX `project_candidate_owner` ON `project_candidates` (`project`,`proposer`,`state`);--> statement-breakpoint
CREATE INDEX `project_document_owner` ON `project_documents` (`project`,`deleted`,`updated`);