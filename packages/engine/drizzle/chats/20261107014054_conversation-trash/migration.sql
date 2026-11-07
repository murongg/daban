CREATE TABLE `conversation_receipts` (
	`id` text PRIMARY KEY,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `conversation_states` (
	`bot` text NOT NULL,
	`revision` integer NOT NULL,
	`value` text NOT NULL,
	CONSTRAINT `conversation_states_pk` PRIMARY KEY(`bot`, `revision`)
);
