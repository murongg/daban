ALTER TABLE `oauth_attempts` ADD `app` text DEFAULT 'notion' NOT NULL;--> statement-breakpoint
ALTER TABLE `oauth_attempts` ADD `client_id` text;--> statement-breakpoint
ALTER TABLE `oauth_attempts` ADD `client_secret` text;--> statement-breakpoint
ALTER TABLE `oauth_attempts` ADD `redirect_uri` text;--> statement-breakpoint
ALTER TABLE `oauth_grants` ADD `app` text DEFAULT 'notion' NOT NULL;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_oauth_grants` (
	`connection` text PRIMARY KEY,
	`app` text DEFAULT 'notion' NOT NULL,
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
	`expires_at` integer,
	`scope` text NOT NULL,
	`identity` text
);
--> statement-breakpoint
INSERT INTO `__new_oauth_grants`(`connection`, `epoch`, `state`, `issuer`, `resource`, `client_id`, `client_secret`, `redirect_uri`, `token_endpoint`, `access_token`, `refresh_token`, `expires_at`, `scope`, `identity`) SELECT `connection`, `epoch`, `state`, `issuer`, `resource`, `client_id`, `client_secret`, `redirect_uri`, `token_endpoint`, `access_token`, `refresh_token`, `expires_at`, `scope`, `identity` FROM `oauth_grants`;--> statement-breakpoint
DROP TABLE `oauth_grants`;--> statement-breakpoint
ALTER TABLE `__new_oauth_grants` RENAME TO `oauth_grants`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
