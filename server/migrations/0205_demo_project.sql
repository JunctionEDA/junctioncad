-- "Devboard Demo": every account made from now on starts with its own copy of the Cyberboard project
-- (src/demo.rs).  `demo_seeded` says the copy was made, or is not owed: accounts that existed before this
-- migration are marked as done, so only new sign-ups get one.  persist::upsert_user inserts new accounts with
-- false; flipping an existing account back to false hands it the demo on its next sign-in or project list.
ALTER TABLE users ADD COLUMN demo_seeded boolean NOT NULL DEFAULT true;
