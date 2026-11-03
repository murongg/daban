CREATE TABLE `call_receipts` (
	`id` text PRIMARY KEY,
	`hash` text NOT NULL,
	`semantic` text NOT NULL,
	`bot` text NOT NULL,
	`run` text NOT NULL,
	`session` text NOT NULL,
	`connection` text NOT NULL,
	`config_revision` integer NOT NULL,
	`tool` text NOT NULL,
	`phase` text NOT NULL,
	`preview` text NOT NULL,
	`result` text,
	`error` text,
	`created` text NOT NULL,
	`updated` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `config_commands` (
	`id` text PRIMARY KEY,
	`hash` text NOT NULL,
	`connection` text NOT NULL,
	`revision` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `integration_bindings` (
	`bot` text NOT NULL,
	`connection` text NOT NULL,
	`revision` integer NOT NULL,
	`config_revision` integer NOT NULL,
	`digest` text,
	`tools` text NOT NULL,
	`enabled` integer NOT NULL,
	CONSTRAINT `integration_bindings_pk` PRIMARY KEY(`bot`, `connection`)
);
--> statement-breakpoint
CREATE TABLE `integration_meta` (
	`id` integer PRIMARY KEY,
	`revision` integer NOT NULL,
	CONSTRAINT "integration_meta_singleton" CHECK("id" = 1)
);
--> statement-breakpoint
CREATE TABLE `integrations` (
	`id` text PRIMARY KEY,
	`revision` integer NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`endpoint` text NOT NULL,
	`bearer` text,
	`deleted` integer NOT NULL,
	`health` text NOT NULL,
	`catalog` text NOT NULL,
	`digest` text,
	`checked` text,
	`error` text,
	`created` text NOT NULL,
	`updated` text NOT NULL,
	`owner` text
);
--> statement-breakpoint
CREATE INDEX `receipt_owner` ON `call_receipts` (`bot`,`run`,`semantic`);--> statement-breakpoint
CREATE UNIQUE INDEX `integration_owner_name` ON `integrations` (COALESCE("owner",''),`name_key`);