CREATE TABLE product_semi_inbox_item_checkpoint (
    account_id text NOT NULL,
    temu_detail_id text NOT NULL,
    common_detail_id text NOT NULL,
    source_list jsonb NOT NULL CHECK (jsonb_typeof(source_list) = 'array'),
    fetched_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, temu_detail_id)
);

INSERT INTO product_semi_inbox_item_checkpoint
    (account_id, temu_detail_id, common_detail_id, source_list, fetched_at)
SELECT DISTINCT ON (account_id, temu_detail_id)
    account_id, temu_detail_id, common_detail_id, source_list, fetched_at
FROM (
    SELECT c.account_id, identity.value->>0 AS temu_detail_id,
        identity.value->>1 AS common_detail_id, source.value AS source_list, c.fetched_at,
        c.page_no
    FROM product_semi_inbox_sync_checkpoint c
    CROSS JOIN LATERAL jsonb_array_elements(c.identities) WITH ORDINALITY AS identity(value, position)
    JOIN LATERAL jsonb_array_elements(c.source_lists) WITH ORDINALITY AS source(value, position)
        ON source.position = identity.position
) saved
WHERE jsonb_typeof(source_list) = 'array'
ORDER BY account_id, temu_detail_id, fetched_at DESC, page_no DESC;

DROP TABLE product_semi_inbox_sync_checkpoint;
