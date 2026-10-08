-- JIRA-8834: emails arrive with arbitrary casing from the signup form and
-- the support tool. Enforce uniqueness case-insensitively going forward;
-- existing rows are normalized by the backfill that runs before this file.
create unique index if not exists users_email_unique
  on users (lower(email));
