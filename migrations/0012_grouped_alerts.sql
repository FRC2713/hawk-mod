-- One alert for many findings of a kind (#86): when a sweep raises four or
-- more new condition findings of one kind — 1 August, when every returning
-- student's Slack Consent and every mentor's training run out together —
-- they share one summary message rather than posting one alert each.
--
--   findings.alert_grouped  1 when the finding's alert_ts is a summary shared
--                           with others of its kind. The message is redrawn
--                           from every grouped finding that still points at
--                           it, so it stays a summary even once only one is
--                           left there. 0 on every older row: a single alert.

ALTER TABLE findings ADD COLUMN alert_grouped INTEGER NOT NULL DEFAULT 0;
