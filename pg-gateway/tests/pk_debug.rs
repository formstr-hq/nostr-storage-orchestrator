#[test]
fn debug_projection() {
    let sql = r#"select "is_admitted", "balance", "pubkey" from "users" where "pubkey" = $1"#;
    println!("projection: {:?}", pg_gateway::sqlanalyze::select_projection(sql));
    println!("table: {:?}", pg_gateway::sqlanalyze::read_table_name(sql));
}
