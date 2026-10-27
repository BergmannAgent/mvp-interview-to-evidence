ALTER TABLE app.interviews ADD COLUMN display_name text;
ALTER TABLE app.interviews ADD CONSTRAINT interviews_display_name_valid
  CHECK (display_name IS NULL OR (length(display_name) BETWEEN 1 AND 200 AND btrim(display_name) <> ''));
