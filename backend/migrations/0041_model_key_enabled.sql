ALTER TABLE model_services ADD COLUMN disabled_keys jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(disabled_keys) = 'array');
