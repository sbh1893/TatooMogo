CREATE TABLE `admins` (
	`id` integer PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`invited_by` integer,
	`created_at` integer NOT NULL,
	`last_login_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `admins_email_unique` ON `admins` (`email`);--> statement-breakpoint
CREATE TABLE `answers` (
	`attempt_id` integer NOT NULL,
	`exam_question_id` integer NOT NULL,
	`choice_id` integer,
	`saved_at` integer NOT NULL,
	PRIMARY KEY(`attempt_id`, `exam_question_id`),
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`exam_question_id`) REFERENCES `exam_questions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`choice_id`) REFERENCES `choices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `answers_eq_choice_idx` ON `answers` (`exam_question_id`,`choice_id`);--> statement-breakpoint
CREATE TABLE `attempts` (
	`id` integer PRIMARY KEY NOT NULL,
	`exam_id` integer NOT NULL,
	`examinee_no` text NOT NULL,
	`examinee_name` text NOT NULL,
	`seed` text NOT NULL,
	`session_hash` text NOT NULL,
	`started_at` integer NOT NULL,
	`deadline_at` integer NOT NULL,
	`submitted_at` integer,
	`submit_reason` text,
	`total_correct` integer,
	`avg_pct` integer,
	`passed` integer,
	`subject_scores` text,
	`last_seen_at` integer,
	`device_switches` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`exam_id`) REFERENCES `exams`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attempts_exam_examinee_uq` ON `attempts` (`exam_id`,`examinee_no`);--> statement-breakpoint
CREATE INDEX `attempts_exam_submitted_idx` ON `attempts` (`exam_id`,`submitted_at`);--> statement-breakpoint
CREATE INDEX `attempts_session_idx` ON `attempts` (`session_hash`);--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` integer PRIMARY KEY NOT NULL,
	`admin_id` integer,
	`admin_email` text NOT NULL,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`detail` text,
	`ip` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`admin_id`) REFERENCES `admins`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `audit_logs_created_idx` ON `audit_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `audit_logs_admin_created_idx` ON `audit_logs` (`admin_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `choices` (
	`id` integer PRIMARY KEY NOT NULL,
	`question_id` integer NOT NULL,
	`ord` integer NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`image_key` text,
	`is_correct` integer NOT NULL,
	FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `choices_question_ord_uq` ON `choices` (`question_id`,`ord`);--> statement-breakpoint
CREATE TABLE `exam_questions` (
	`id` integer PRIMARY KEY NOT NULL,
	`exam_id` integer NOT NULL,
	`question_id` integer NOT NULL,
	`position` integer NOT NULL,
	`points` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`exam_id`) REFERENCES `exams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `exam_questions_exam_question_uq` ON `exam_questions` (`exam_id`,`question_id`);--> statement-breakpoint
CREATE INDEX `exam_questions_exam_pos_idx` ON `exam_questions` (`exam_id`,`position`);--> statement-breakpoint
CREATE INDEX `exam_questions_question_idx` ON `exam_questions` (`question_id`);--> statement-breakpoint
CREATE TABLE `exams` (
	`id` integer PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`code` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`time_limit_min` integer NOT NULL,
	`opens_at` integer,
	`closes_at` integer,
	`pass_subject_pct` integer DEFAULT 40 NOT NULL,
	`pass_avg_pct` integer DEFAULT 60 NOT NULL,
	`shuffle_questions` integer DEFAULT true NOT NULL,
	`shuffle_within_subject` integer DEFAULT true NOT NULL,
	`shuffle_choices` integer DEFAULT true NOT NULL,
	`reveal_explanations` integer DEFAULT true NOT NULL,
	`notice` text DEFAULT '' NOT NULL,
	`layout` text,
	`created_by` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `admins`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `exams_code_unique` ON `exams` (`code`);--> statement-breakpoint
CREATE TABLE `questions` (
	`id` integer PRIMARY KEY NOT NULL,
	`code` integer NOT NULL,
	`version` integer NOT NULL,
	`is_latest` integer NOT NULL,
	`subject_id` integer NOT NULL,
	`source_file_id` integer,
	`source_no` integer,
	`stem` text NOT NULL,
	`stem_image_key` text,
	`explanation` text DEFAULT '' NOT NULL,
	`fixed_choices` integer DEFAULT false NOT NULL,
	`group_key` text,
	`status` text NOT NULL,
	`created_by` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`subject_id`) REFERENCES `subjects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_file_id`) REFERENCES `source_files`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `admins`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `questions_code_version_uq` ON `questions` (`code`,`version`);--> statement-breakpoint
CREATE INDEX `questions_latest_subject_status_idx` ON `questions` (`is_latest`,`subject_id`,`status`);--> statement-breakpoint
CREATE INDEX `questions_source_idx` ON `questions` (`source_file_id`);--> statement-breakpoint
CREATE INDEX `questions_group_idx` ON `questions` (`group_key`);--> statement-breakpoint
CREATE TABLE `source_files` (
	`id` integer PRIMARY KEY NOT NULL,
	`r2_key` text NOT NULL,
	`filename` text NOT NULL,
	`round_label` text,
	`subject_id` integer,
	`size_bytes` integer NOT NULL,
	`kind` text,
	`status` text DEFAULT 'uploaded' NOT NULL,
	`uploaded_by` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`subject_id`) REFERENCES `subjects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`uploaded_by`) REFERENCES `admins`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_files_r2_key_unique` ON `source_files` (`r2_key`);--> statement-breakpoint
CREATE INDEX `source_files_status_idx` ON `source_files` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `subjects` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`sort_order` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subjects_name_unique` ON `subjects` (`name`);--> statement-breakpoint
CREATE INDEX `subjects_sort_idx` ON `subjects` (`sort_order`);