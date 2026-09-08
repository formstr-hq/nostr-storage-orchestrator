#[test]
fn extract_add_columns_basic() {
    let cols = pg_gateway::sqlanalyze::extract_add_columns(
        r#"alter table "users" add column "is_vanished" boolean not null default '0'"#,
    )
    .unwrap();
    assert_eq!(cols.len(), 1);
    assert_eq!(cols[0]["name"], "is_vanished");
    assert_eq!(cols[0]["type"], "BOOLEAN");
    assert_eq!(cols[0]["notNull"], true);
}
