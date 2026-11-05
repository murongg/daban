CREATE TABLE `gallery_auth_accounts` (
	`id` text PRIMARY KEY,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_gallery_auth_accounts_user_id_gallery_auth_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `gallery_auth_users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `gallery_auth_sessions` (
	`id` text PRIMARY KEY,
	`token` text NOT NULL UNIQUE,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	CONSTRAINT `fk_gallery_auth_sessions_user_id_gallery_auth_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `gallery_auth_users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `gallery_namespaces` (
	`namespace` text PRIMARY KEY,
	`user_id` text UNIQUE
);
--> statement-breakpoint
CREATE TABLE `gallery_auth_rate_limits` (
	`id` text PRIMARY KEY,
	`key` text NOT NULL UNIQUE,
	`count` integer NOT NULL,
	`last_request` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `gallery_auth_users` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`email` text NOT NULL UNIQUE,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `gallery_auth_verifications` (
	`id` text PRIMARY KEY,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gallery_auth_provider_account` ON `gallery_auth_accounts` (`provider_id`,`account_id`);--> statement-breakpoint
CREATE INDEX `gallery_auth_account_user` ON `gallery_auth_accounts` (`user_id`);--> statement-breakpoint
CREATE INDEX `gallery_auth_session_user` ON `gallery_auth_sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `gallery_auth_verification_identifier` ON `gallery_auth_verifications` (`identifier`);