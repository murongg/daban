CREATE TABLE `budget_goal_grants` (
	`id` text PRIMARY KEY,
	`owner` text NOT NULL,
	`run` text NOT NULL,
	`target` text NOT NULL,
	`budget` text NOT NULL,
	`revision` integer NOT NULL,
	`epoch` integer NOT NULL,
	`fingerprint` text NOT NULL,
	`claimed` integer DEFAULT false NOT NULL,
	CONSTRAINT `fk_budget_goal_grants_budget_budget_tasks_id_fk` FOREIGN KEY (`budget`) REFERENCES `budget_tasks`(`id`)
);
--> statement-breakpoint
CREATE TABLE `budget_goal_links` (
	`owner` text PRIMARY KEY,
	`budget` text NOT NULL,
	`session` text NOT NULL,
	`goal` text NOT NULL,
	`revision` integer NOT NULL,
	CONSTRAINT `fk_budget_goal_links_budget_budget_tasks_id_fk` FOREIGN KEY (`budget`) REFERENCES `budget_tasks`(`id`)
);
--> statement-breakpoint
CREATE TABLE `budget_human_turns` (
	`id` text PRIMARY KEY,
	`owner` text NOT NULL,
	`epoch` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `budget_humans` (
	`owner` text PRIMARY KEY,
	`epoch` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `budget_tasks` ADD `toolAdjustment` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `budget_tasks` ADD `activeAdjustment` integer DEFAULT 0 NOT NULL;