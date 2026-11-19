ALTER TABLE model_services
    ADD COLUMN selected_models jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN model_catalogs jsonb NOT NULL DEFAULT '{}'::jsonb;
