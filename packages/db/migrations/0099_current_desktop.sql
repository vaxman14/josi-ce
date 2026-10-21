-- Legacy VM presence stays isolated; new host sessions explicitly report false.
ALTER TABLE automation_workspace_presence ADD COLUMN IF NOT EXISTS isolated boolean NOT NULL DEFAULT true;
