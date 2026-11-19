-- Reference sources keep original inputs only; workflow snapshots own model outputs.
ALTER TABLE product_size_reference_sources
    DROP COLUMN recognition_result,
    DROP COLUMN evidence;

ALTER TABLE product_size_reference_sources ADD COLUMN source_item_id text;
UPDATE product_size_reference_sources s SET source_item_id=t.source_item_id
    FROM product_tasks t WHERE t.task_id=s.task_id;
ALTER TABLE product_size_reference_sources ALTER COLUMN source_item_id SET NOT NULL;
CREATE INDEX product_size_reference_sources_source_item ON product_size_reference_sources(source_item_id);
