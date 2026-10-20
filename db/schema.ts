import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Operational counters only: no IP addresses, API keys, filters or job records.
export const aiQuota = sqliteTable("ai_quota", {
  scope: text("scope").primaryKey(),
  minuteStart: integer("minute_start").notNull(),
  minuteCount: integer("minute_count").notNull(),
  dayStart: integer("day_start").notNull(),
  dayCount: integer("day_count").notNull(),
});

export const aiLeases = sqliteTable("ai_leases", {
  token: text("token").primaryKey(),
  expiresAt: integer("expires_at").notNull(),
});
