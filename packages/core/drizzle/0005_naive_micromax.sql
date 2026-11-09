ALTER TABLE `demo_sessions` ADD `actions_used` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `statuses_undo_until_idx` ON `statuses` (`undo_until_ms`);