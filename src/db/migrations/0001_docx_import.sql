CREATE TABLE `field_subjects` (
	`field` text PRIMARY KEY NOT NULL,
	`subject_id` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`subject_id`) REFERENCES `subjects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `questions` ADD `dev_criterion_no` text;--> statement-breakpoint
ALTER TABLE `questions` ADD `dev_item_no` integer;--> statement-breakpoint
ALTER TABLE `questions` ADD `dev_field` text;--> statement-breakpoint
ALTER TABLE `questions` ADD `knowledge_level` text;--> statement-breakpoint
ALTER TABLE `questions` ADD `expected_difficulty` text;--> statement-breakpoint
ALTER TABLE `questions` ADD `dev_intent` text;--> statement-breakpoint
ALTER TABLE `questions` ADD `dev_objection_review` text;--> statement-breakpoint
ALTER TABLE `questions` ADD `dev_basis` text;--> statement-breakpoint
CREATE INDEX `questions_dev_key_idx` ON `questions` (`dev_criterion_no`,`dev_item_no`);--> statement-breakpoint
CREATE INDEX `questions_dev_field_idx` ON `questions` (`dev_field`);