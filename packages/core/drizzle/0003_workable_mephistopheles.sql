DROP INDEX `demo_events_session_seq_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `demo_events_session_seq_idx` ON `demo_events` (`session_id`,`seq`);--> statement-breakpoint
CREATE INDEX `audit_workspace_idx` ON `audit` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `statuses_workspace_idx` ON `statuses` (`workspace_id`);