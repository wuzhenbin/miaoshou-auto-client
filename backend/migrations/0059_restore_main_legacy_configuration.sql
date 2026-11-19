-- main still persists editor settings and model services in these tables.
-- They were removed by the multi-account branch's 0054 migration.
CREATE TABLE IF NOT EXISTS product_editor_settings (
    id smallint PRIMARY KEY CHECK (id = 1),
    config jsonb NOT NULL,
    version text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS model_services (
    id text PRIMARY KEY,
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    base_url text NOT NULL,
    api_keys jsonb NOT NULL CHECK (jsonb_typeof(api_keys) = 'array'),
    protocol text NOT NULL CHECK (protocol IN ('openai-responses', 'openrouter', 'juxchen-image', 'cangyuan-image')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    diagnostic_capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
    selected_models jsonb NOT NULL DEFAULT '{}'::jsonb,
    model_catalogs jsonb NOT NULL DEFAULT '{}'::jsonb,
    disabled_keys jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(disabled_keys) = 'array')
);
