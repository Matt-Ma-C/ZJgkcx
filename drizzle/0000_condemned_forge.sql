CREATE TABLE `ai_leases` (
	`token` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ai_quota` (
	`scope` text PRIMARY KEY NOT NULL,
	`minute_start` integer NOT NULL,
	`minute_count` integer NOT NULL,
	`day_start` integer NOT NULL,
	`day_count` integer NOT NULL
);
