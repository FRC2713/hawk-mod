-- Step 6 of the lifecycle sync: onboarding requests and the welcome message
-- (docs/lifecycle-sync.md, "What hawk-mod asks a human to do").
--
--   findings.alert_channel  the channel an alert was posted in. Until now
--                           every alert went to the alert channel, so the
--                           timestamp alone found it again. Onboarding
--                           requests go to their own channel, and either
--                           setting can change after a post; the redraw has
--                           to find the message where it actually is. NULL on
--                           every older row, which means the alert channel.
--
--   onboarding_messages     each message hawk-mod has sent an adult about
--                           enrolling, once per kind: the welcome when they
--                           arrive in Slack, and one reminder a week later.
--                           Kept so a restart, or an hourly run, never sends
--                           either twice. 'baseline' marks an adult who was
--                           already in Slack when this shipped, and is sent
--                           nothing.

ALTER TABLE findings ADD COLUMN alert_channel TEXT;

CREATE TABLE onboarding_messages (
  slack_user_id TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('baseline', 'welcome', 'reminder')),
  sent_at       TEXT NOT NULL,
  PRIMARY KEY (slack_user_id, kind)
);
