CREATE TABLE `oauth_attempts` (
	`request_id` text PRIMARY KEY,
	`attempt` text NOT NULL UNIQUE,
	`hash` text NOT NULL,
	`bot` text NOT NULL,
	`connection` text NOT NULL,
	`revision` integer NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`phase` text NOT NULL,
	`deadline` integer NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `oauth_grants` (
	`connection` text PRIMARY KEY,
	`epoch` integer NOT NULL,
	`state` text NOT NULL,
	`issuer` text NOT NULL,
	`resource` text NOT NULL,
	`client_id` text NOT NULL,
	`client_secret` text,
	`redirect_uri` text NOT NULL,
	`token_endpoint` text NOT NULL,
	`access_token` text NOT NULL,
	`refresh_token` text,
	`expires_at` integer NOT NULL,
	`scope` text NOT NULL,
	`identity` text
);
--> statement-breakpoint
ALTER TABLE `integrations` ADD `auth_kind` text DEFAULT 'bearer' NOT NULL;--> statement-breakpoint
ALTER TABLE `integrations` ADD `credential_epoch` integer DEFAULT 0 NOT NULL;