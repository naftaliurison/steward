CREATE TABLE `audit` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`person_id` text NOT NULL,
	`action` text NOT NULL,
	`result` text NOT NULL,
	`detail` text,
	`at` integer NOT NULL,
	`idempotency_key` text
);
--> statement-breakpoint
CREATE TABLE `people` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`slack_user_id` text NOT NULL,
	`display_name` text NOT NULL,
	`tz` text DEFAULT 'UTC' NOT NULL,
	`user_token_sealed` text
);
--> statement-breakpoint
CREATE INDEX `people_workspace_idx` ON `people` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `status_targets` (
	`id` text PRIMARY KEY NOT NULL,
	`status_id` text NOT NULL,
	`system` text NOT NULL,
	`op` text NOT NULL,
	`spec` text NOT NULL,
	`state` text NOT NULL,
	`external_id` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`idempotency_key` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `status_targets_idempotency_key_unique` ON `status_targets` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `status_targets_status_idx` ON `status_targets` (`status_id`);--> statement-breakpoint
CREATE TABLE `statuses` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`person_id` text NOT NULL,
	`type` text NOT NULL,
	`start_ms` integer NOT NULL,
	`end_ms` integer NOT NULL,
	`text` text NOT NULL,
	`emoji` text NOT NULL,
	`state` text NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	`undo_until_ms` integer,
	`replaced_status_id` text
);
--> statement-breakpoint
CREATE INDEX `statuses_person_state_idx` ON `statuses` (`person_id`,`state`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`bot_token_sealed` text NOT NULL,
	`bot_user_id` text NOT NULL,
	`installed_at` integer NOT NULL
);
