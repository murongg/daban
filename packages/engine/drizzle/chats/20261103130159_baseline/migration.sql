CREATE TABLE `chat_meta` (
	`id` integer PRIMARY KEY,
	`revision` integer NOT NULL,
	CONSTRAINT "chat_meta_singleton" CHECK("id" = 1)
);
--> statement-breakpoint
CREATE TABLE `chat_receipts` (
	`id` text PRIMARY KEY,
	`bot` text NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `chats` (
	`bot` text PRIMARY KEY,
	`value` text NOT NULL
);
