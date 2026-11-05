CREATE TABLE `group_budget_resumes` (
	`id` text PRIMARY KEY,
	`signature` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `group_deliveries` ADD `retryOf` text;--> statement-breakpoint
ALTER TABLE `group_deliveries` ADD `retryStage` text;--> statement-breakpoint
ALTER TABLE `group_turns` ADD `budget` text;