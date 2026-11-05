CREATE TABLE `budget_actions` (
	`id` text PRIMARY KEY,
	`fingerprint` text NOT NULL,
	`result` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `budget_prices` (
	`id` text PRIMARY KEY,
	`snapshot` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `budget_receipts` (
	`id` text PRIMARY KEY,
	`budget` text NOT NULL,
	`revision` integer NOT NULL,
	`run` text NOT NULL,
	`modelAttempt` text NOT NULL,
	`session` text NOT NULL,
	`rootSession` text NOT NULL,
	`purpose` text NOT NULL,
	`route` text NOT NULL,
	`auth` text NOT NULL,
	`fingerprint` text NOT NULL,
	`phase` text NOT NULL,
	`tokens` integer NOT NULL,
	`micros` integer,
	`estimated` integer,
	`price` text,
	`usage` text,
	`created` text NOT NULL,
	CONSTRAINT `fk_budget_receipts_budget_budget_tasks_id_fk` FOREIGN KEY (`budget`) REFERENCES `budget_tasks`(`id`)
);
--> statement-breakpoint
CREATE TABLE `budget_runs` (
	`id` text PRIMARY KEY,
	`budget` text NOT NULL,
	`activeMs` integer DEFAULT 0 NOT NULL,
	`coverage` text DEFAULT '{}' NOT NULL,
	CONSTRAINT `fk_budget_runs_budget_budget_tasks_id_fk` FOREIGN KEY (`budget`) REFERENCES `budget_tasks`(`id`)
);
--> statement-breakpoint
CREATE TABLE `budget_settings` (
	`scope` text DEFAULT '' NOT NULL,
	`id` integer PRIMARY KEY,
	`revision` integer NOT NULL,
	`policy` text NOT NULL,
	`prices` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `budget_tasks` (
	`id` text PRIMARY KEY,
	`root` text NOT NULL,
	`revision` integer NOT NULL,
	`policy` text NOT NULL,
	`prices` text NOT NULL,
	`state` text NOT NULL,
	`warned` integer DEFAULT false NOT NULL,
	`historyUnmetered` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `budget_tools` (
	`id` text PRIMARY KEY,
	`budget` text NOT NULL,
	CONSTRAINT `fk_budget_tools_budget_budget_tasks_id_fk` FOREIGN KEY (`budget`) REFERENCES `budget_tasks`(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `budget_root` ON `budget_tasks` (`root`);