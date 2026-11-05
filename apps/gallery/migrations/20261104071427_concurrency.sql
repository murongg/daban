ALTER TABLE `gallery_releases` ADD `revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `gallery_releases` ADD `mutation` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `gallery_templates` ADD `revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `gallery_templates` ADD `state` text DEFAULT 'active' NOT NULL;