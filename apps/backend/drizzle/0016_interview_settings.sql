CREATE TABLE app.interview_settings (
  language text PRIMARY KEY CHECK (language IN ('de', 'en')),
  guide_id text NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT interview_settings_guide_language_fk FOREIGN KEY (guide_id, language)
    REFERENCES app.guides(id, source_language) ON DELETE RESTRICT
);
