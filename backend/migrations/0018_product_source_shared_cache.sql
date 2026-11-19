-- Keep the newest snapshot per source before removing task ownership.
DELETE FROM product_common_detail_cache a USING product_common_detail_cache b
WHERE a.source_item_id=b.source_item_id AND (a.fetched_at,a.task_id)<(b.fetched_at,b.task_id);
ALTER TABLE product_common_detail_cache DROP COLUMN task_id;
ALTER TABLE product_common_detail_cache ADD PRIMARY KEY (source_item_id);
DELETE FROM product_1688_source_cache a USING product_1688_source_cache b
WHERE a.source_item_id=b.source_item_id AND (a.fetched_at,a.task_id)<(b.fetched_at,b.task_id);
ALTER TABLE product_1688_source_cache DROP COLUMN task_id;
ALTER TABLE product_1688_source_cache ADD PRIMARY KEY (source_item_id);

-- task_id is only a live dispatch owner; deleting it must preserve generated assets.
ALTER TABLE product_color_images ADD COLUMN source_item_id text;
UPDATE product_color_images i SET source_item_id=t.source_item_id FROM product_tasks t WHERE i.task_id=t.task_id;
ALTER TABLE product_color_images ALTER COLUMN source_item_id SET NOT NULL;
ALTER TABLE product_color_images DROP CONSTRAINT product_color_images_task_id_fkey;
ALTER TABLE product_color_images ALTER COLUMN task_id DROP NOT NULL;
ALTER TABLE product_color_images ADD FOREIGN KEY (task_id) REFERENCES product_tasks(task_id) ON DELETE SET NULL;
ALTER TABLE product_color_images DROP CONSTRAINT product_color_images_task_id_color_key_key;
-- Retain all historical results. Select one execution owner per source; prefer completed sets.
ALTER TABLE product_color_images ADD COLUMN cache_active boolean NOT NULL DEFAULT true;
WITH ranked AS (SELECT task_id, source_item_id, row_number() OVER (PARTITION BY source_item_id
    ORDER BY bool_or(status='succeeded') DESC, max(completed_images) DESC, max(updated_at) DESC, task_id DESC) AS rank
    FROM product_color_images GROUP BY source_item_id,task_id)
UPDATE product_color_images i SET cache_active=false FROM ranked r
WHERE i.task_id=r.task_id AND i.source_item_id=r.source_item_id AND r.rank>1;
CREATE UNIQUE INDEX product_color_images_source_active ON product_color_images(source_item_id,color_key) WHERE cache_active;

CREATE TABLE product_size_image_cache (
    source_item_id text PRIMARY KEY,
    data jsonb NOT NULL CHECK (jsonb_typeof(data)='object'),
    fetched_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO product_size_image_cache(source_item_id,data,fetched_at)
SELECT DISTINCT ON (t.source_item_id) t.source_item_id,r.data,r.completed_at
FROM product_edit_runs r JOIN product_tasks t USING(task_id)
WHERE r.node_key='size_image' AND r.status='succeeded' AND r.data->>'imageUrl' IS NOT NULL
ORDER BY t.source_item_id,r.completed_at DESC,r.run_id DESC;
