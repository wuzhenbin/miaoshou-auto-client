CREATE TABLE model_services (
    id text PRIMARY KEY,
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    base_url text NOT NULL,
    api_keys jsonb NOT NULL CHECK (jsonb_typeof(api_keys) = 'array'),
    protocol text NOT NULL CHECK (protocol IN ('openai-responses', 'openrouter', 'juxchen-image', 'cangyuan-image')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
