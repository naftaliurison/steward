CREATE TABLE `google_connections` (
	`person_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`email` text NOT NULL,
	`refresh_token_sealed` text NOT NULL,
	`access_token_sealed` text,
	`access_expires_at` integer,
	`scopes` text NOT NULL,
	`calendars` text NOT NULL,
	`health` text NOT NULL,
	`connected_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `google_connections_workspace_idx` ON `google_connections` (`workspace_id`);