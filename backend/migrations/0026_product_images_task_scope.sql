-- Product image plans belong to a task; never adopt another task's source result.
-- Keep existing records, image URLs and files, including detached historical artifacts.
DROP INDEX product_color_images_source_active;
CREATE UNIQUE INDEX product_color_images_task_active
    ON product_color_images(task_id,color_key) WHERE cache_active AND task_id IS NOT NULL;
ALTER TABLE product_image_execution_slot DROP CONSTRAINT product_image_execution_slot_source_item_id_key;
