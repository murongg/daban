CREATE TABLE `work_checklists` (
	`workId` text PRIMARY KEY,
	`revision` integer NOT NULL,
	`items` text NOT NULL,
	CONSTRAINT `fk_work_checklists_workId_work_items_id_fk` FOREIGN KEY (`workId`) REFERENCES `work_items`(`id`)
) STRICT;
--> statement-breakpoint
CREATE TABLE `work_decisions` (
	`attemptId` text PRIMARY KEY,
	`requestId` text NOT NULL UNIQUE,
	`value` text NOT NULL,
	CONSTRAINT `fk_work_decisions_attemptId_work_deliveries_id_fk` FOREIGN KEY (`attemptId`) REFERENCES `work_deliveries`(`id`)
) STRICT;
--> statement-breakpoint
CREATE TABLE `work_deliveries` (
	`seq` integer PRIMARY KEY AUTOINCREMENT,
	`id` text NOT NULL UNIQUE,
	`workId` text NOT NULL,
	`requestId` text NOT NULL UNIQUE,
	`activeWorkId` text UNIQUE,
	`value` text NOT NULL,
	CONSTRAINT `fk_work_deliveries_workId_work_items_id_fk` FOREIGN KEY (`workId`) REFERENCES `work_items`(`id`)
) STRICT;
--> statement-breakpoint
CREATE TABLE `work_delivery_operations` (
	`id` text PRIMARY KEY,
	`workId` text NOT NULL,
	`signature` text NOT NULL,
	`value` text NOT NULL,
	CONSTRAINT `fk_work_delivery_operations_workId_work_items_id_fk` FOREIGN KEY (`workId`) REFERENCES `work_items`(`id`)
) STRICT;
