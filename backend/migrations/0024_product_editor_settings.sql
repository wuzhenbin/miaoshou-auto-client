CREATE TABLE product_editor_settings (
    id smallint PRIMARY KEY CHECK (id = 1),
    config jsonb NOT NULL,
    version text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
