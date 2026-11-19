-- Extend the already migrated image samples into original size reference sources.
ALTER TABLE product_size_source_images RENAME TO product_size_reference_sources;
ALTER TABLE product_size_reference_sources
    DROP CONSTRAINT product_size_source_images_image_urls_check,
    ADD COLUMN source_kind text NOT NULL DEFAULT 'image',
    ADD COLUMN source_text text,
    ADD CONSTRAINT product_size_reference_sources_content_check CHECK (
        jsonb_typeof(image_urls)='array' AND (
            (source_kind='image' AND jsonb_array_length(image_urls)>0 AND source_text IS NULL)
            OR (source_kind='description_text' AND jsonb_array_length(image_urls)=0 AND length(btrim(source_text))>0 AND source_text IS NOT NULL)
        )
    );
ALTER INDEX product_size_source_images_recognized RENAME TO product_size_reference_sources_recognized;
