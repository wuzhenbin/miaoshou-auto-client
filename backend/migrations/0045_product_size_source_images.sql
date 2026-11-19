-- Source OCR samples, distinct from generated size images and browser caches.
CREATE TABLE product_size_source_images (
    task_id uuid NOT NULL REFERENCES product_tasks(task_id) ON DELETE CASCADE,
    source_key text NOT NULL CHECK (length(source_key)=64),
    image_urls jsonb NOT NULL CHECK (jsonb_typeof(image_urls)='array' AND jsonb_array_length(image_urls)>0),
    source text NOT NULL CHECK (source IN ('miaoshou','1688','unknown')),
    recognition_result jsonb NOT NULL,
    evidence jsonb NOT NULL DEFAULT '{}',
    collection_kind text NOT NULL CHECK (collection_kind IN ('automatic','manual','history')),
    source_run_id uuid REFERENCES product_edit_runs(run_id) ON DELETE SET NULL,
    recognized_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(task_id,source_key)
);
CREATE INDEX product_size_source_images_recognized ON product_size_source_images(recognized_at,task_id);
