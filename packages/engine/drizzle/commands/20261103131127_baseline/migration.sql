CREATE TABLE `commands` (
	`id` text PRIMARY KEY,
	`fingerprint` text NOT NULL,
	`request` text NOT NULL,
	`phase` text NOT NULL,
	`decision` text,
	`result` text
);
