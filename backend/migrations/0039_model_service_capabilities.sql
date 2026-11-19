ALTER TABLE model_services ADD COLUMN diagnostic_capabilities jsonb NOT NULL DEFAULT '{}'::jsonb;
