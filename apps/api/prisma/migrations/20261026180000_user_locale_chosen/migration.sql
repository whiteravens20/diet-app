-- Whether an account's language is its owner's. The accounts there are now were
-- given English when they were made, whatever language they signed up in, so
-- none of them counts as chosen: each takes the language its reader uses the
-- next time it opens a page of the web application.
ALTER TABLE "User" ADD COLUMN "localeChosen" BOOLEAN NOT NULL DEFAULT false;
