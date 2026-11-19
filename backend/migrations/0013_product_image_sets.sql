-- Null plan preserves historical per-color tasks. New tasks contain a whole-product plan.
ALTER TABLE product_color_images ADD COLUMN plan jsonb CHECK (plan IS NULL OR jsonb_typeof(plan) = 'object');
ALTER TABLE product_color_images ADD COLUMN completed_images integer NOT NULL DEFAULT 0 CHECK (completed_images BETWEEN 0 AND 10);
