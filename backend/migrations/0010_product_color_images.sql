CREATE TABLE product_color_images (
    request_id uuid PRIMARY KEY,
    task_id uuid NOT NULL REFERENCES product_tasks (task_id) ON DELETE CASCADE,
    color_key text NOT NULL,
    input_draft_version integer NOT NULL,
    name text NOT NULL,
    reference_image_urls jsonb NOT NULL CHECK (jsonb_typeof(reference_image_urls) = 'array'),
    prompt text NOT NULL,
    status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'skipped')),
    result jsonb,
    error jsonb,
    dispatched_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (task_id, color_key)
);
CREATE INDEX product_color_images_pending ON product_color_images (created_at)
    WHERE status IN ('queued', 'running');
