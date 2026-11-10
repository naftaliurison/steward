ALTER TABLE `status_targets` ADD `next_attempt_at` integer;--> statement-breakpoint
CREATE INDEX `status_targets_retry_idx` ON `status_targets` (`state`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `statuses_state_start_idx` ON `statuses` (`state`,`start_ms`);