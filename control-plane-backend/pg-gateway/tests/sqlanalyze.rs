use pg_gateway::error::GatewayError;
use pg_gateway::sqlanalyze::{analyze, point_read_row_id, pk_placeholder, read_table_name, AnalyzedStatement, StatementKind};

fn write_of(sql: &str) -> (StatementKind, String, String) {
    match analyze(sql).unwrap() {
        AnalyzedStatement::Write { kind, table, row_id, .. } => (kind, table, row_id),
        other => panic!("expected write, got {other:?}"),
    }
}

#[test]
fn classifies_point_writes() {
    let (kind, table, row_id) = write_of("INSERT INTO notes (id, body) VALUES ('a1', 'hello')");
    assert_eq!(kind, StatementKind::Insert);
    assert_eq!(table, "notes");
    assert_eq!(row_id, "a1");

    let (kind, table, row_id) = write_of("UPDATE notes SET body = 'x' WHERE id = 'a1'");
    assert_eq!(kind, StatementKind::Update);
    assert_eq!(table, "notes");
    assert_eq!(row_id, "a1");

    let (kind, table, row_id) = write_of("DELETE FROM notes WHERE id = 'a1'");
    assert_eq!(kind, StatementKind::Delete);
    assert_eq!(table, "notes");
    assert_eq!(row_id, "a1");
}

#[test]
fn numeric_pk_literals() {
    let (_, _, row_id) = write_of("DELETE FROM items WHERE id = 42");
    assert_eq!(row_id, "42");
}

#[test]
fn reversed_pk_equality() {
    let (_, _, row_id) = write_of("DELETE FROM items WHERE 42 = id");
    assert_eq!(row_id, "42");
}

#[test]
fn rejects_writes_without_pk() {
    for sql in [
        "UPDATE notes SET body = 'x' WHERE body = 'y'",
        "UPDATE notes SET body = 'x'",
        "DELETE FROM notes",
        "DELETE FROM notes WHERE body = 'y'",
    ] {
        let error = pg_gateway::sqlanalyze::analyze(sql).unwrap_err();
        assert!(matches!(error, GatewayError::WriteRequiresPk(_)), "{sql}: {error:?}");
    }
}

#[test]
fn rejects_multi_row_insert_and_conflict() {
    assert!(pg_gateway::sqlanalyze::analyze(
        "INSERT INTO notes (id, body) VALUES ('a', 'x'), ('b', 'y')"
    )
    .is_err());
    assert!(pg_gateway::sqlanalyze::analyze(
        "INSERT INTO notes (id, body) VALUES ('a', 'x') ON CONFLICT DO NOTHING"
    )
    .is_err());
}

#[test]
fn reads_classify_and_rejects_joins_and_aggregates() {
    assert!(matches!(
        pg_gateway::sqlanalyze::analyze("SELECT * FROM notes"),
        Ok(AnalyzedStatement::Read { .. })
    ));
    assert!(matches!(
        pg_gateway::sqlanalyze::analyze("SELECT body FROM notes WHERE id = 'x'"),
        Ok(AnalyzedStatement::Read { .. })
    ));
    assert!(pg_gateway::sqlanalyze::analyze("SELECT * FROM a JOIN b ON a.id = b.id").is_err());
    assert!(pg_gateway::sqlanalyze::analyze("SELECT COUNT(*) FROM notes").is_err());
    assert!(pg_gateway::sqlanalyze::analyze("SELECT DISTINCT id FROM notes").is_err());
}

#[test]
fn classifies_ddl() {
    let analyzed = pg_gateway::sqlanalyze::analyze("CREATE TABLE notes (id text PRIMARY KEY, body text)").unwrap();
    match analyzed {
        AnalyzedStatement::Ddl { kind, table, .. } => {
            assert_eq!(kind, StatementKind::Create);
            assert_eq!(table, "notes");
        }
        other => panic!("expected ddl, got {other:?}"),
    }
    let analyzed =
        pg_gateway::sqlanalyze::analyze("ALTER TABLE notes ADD COLUMN done boolean DEFAULT false").unwrap();
    assert!(matches!(analyzed, AnalyzedStatement::Ddl { kind: StatementKind::Alter, .. }));
    let analyzed = pg_gateway::sqlanalyze::analyze("DROP TABLE notes").unwrap();
    assert!(matches!(analyzed, AnalyzedStatement::Ddl { kind: StatementKind::Drop, .. }));
}

#[test]
fn additive_ddl_subset() {
    assert!(pg_gateway::sqlanalyze::is_additive_ddl(&StatementKind::Create, "CREATE TABLE t (id text)").is_ok());
    assert!(pg_gateway::sqlanalyze::is_additive_ddl(
        &StatementKind::Alter,
        "ALTER TABLE t ADD COLUMN x text"
    )
    .is_ok());
    assert!(pg_gateway::sqlanalyze::is_additive_ddl(
        &StatementKind::Alter,
        "ALTER TABLE t DROP COLUMN x"
    )
    .is_err());
    assert!(pg_gateway::sqlanalyze::is_additive_ddl(&StatementKind::Drop, "DROP TABLE t").is_ok());
}

#[test]
fn extract_create_columns_shapes_registry() {
    let columns = pg_gateway::sqlanalyze::extract_create_columns(
        "CREATE TABLE notes (id text PRIMARY KEY, body text, done boolean)",
    )
    .unwrap();
    let array = columns.as_array().unwrap();
    assert_eq!(array.len(), 3);
    assert_eq!(array[0]["name"], "id");
    assert_eq!(array[1]["name"], "body");
    assert_eq!(array[2]["type"].as_str().unwrap().to_ascii_lowercase(), "boolean");
}

#[test]
fn point_read_detection() {
    assert_eq!(
        point_read_row_id("SELECT * FROM notes WHERE id = 'abc'").unwrap(),
        Some("abc".to_string())
    );
    assert_eq!(point_read_row_id("SELECT * FROM notes").unwrap(), None);
    assert_eq!(point_read_row_id("SELECT * FROM notes WHERE body = 'x'").unwrap(), None);
    assert_eq!(read_table_name("SELECT * FROM notes"), Some("notes".to_string()));
}

#[test]
fn pk_placeholder_detection() {
    assert_eq!(
        pk_placeholder("SELECT * FROM notes WHERE id = $1").unwrap(),
        "$1".to_string()
    );
    assert_eq!(pk_placeholder("SELECT * FROM notes WHERE body = $1"), None);
    assert_eq!(
        pk_placeholder("UPDATE notes SET body = 'x' WHERE id = $2").unwrap(),
        "$2".to_string()
    );
}

#[test]
fn insert_payload_extraction() {
    let payload =
        pg_gateway::sqlanalyze::insert_row_payload("INSERT INTO notes (id, body) VALUES ('a1', 'hello')")
            .unwrap();
    assert_eq!(payload["id"], "a1");
    assert_eq!(payload["body"], "hello");
}

#[test]
fn session_commands_recognized() {
    assert!(pg_gateway::sqlanalyze::is_session_command("BEGIN"));
    assert!(pg_gateway::sqlanalyze::is_session_command("COMMIT;"));
    assert!(pg_gateway::sqlanalyze::is_session_command("SET search_path TO public"));
    assert!(pg_gateway::sqlanalyze::is_session_command("SELECT CURRENT_USER"));
    assert!(!pg_gateway::sqlanalyze::is_session_command("SELECT * FROM notes"));
}

#[test]
fn rejects_unsupported_statement_kinds() {
    assert!(pg_gateway::sqlanalyze::analyze("TRUNCATE TABLE notes").is_err());
    assert!(pg_gateway::sqlanalyze::analyze("GRANT ALL ON notes TO public").is_err());
    assert!(pg_gateway::sqlanalyze::analyze("SELECT * FROM notes; SELECT 1").is_err());
}