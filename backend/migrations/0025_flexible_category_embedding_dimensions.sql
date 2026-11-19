ALTER TABLE product_category_embedding_indexes
    DROP CONSTRAINT IF EXISTS product_category_embedding_indexes_dimensions_check;

ALTER TABLE product_category_embedding_indexes
    ADD CONSTRAINT product_category_embedding_indexes_dimensions_check
    CHECK (dimensions BETWEEN 1 AND 16000);

ALTER TABLE product_category_embeddings
    ALTER COLUMN embedding TYPE vector USING embedding::vector;
