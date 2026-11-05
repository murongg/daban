CREATE TABLE `authored_releases` (
	`template` text NOT NULL,
	`version` text NOT NULL,
	`digest` text NOT NULL,
	CONSTRAINT `authored_releases_pk` PRIMARY KEY(`template`, `version`)
);
