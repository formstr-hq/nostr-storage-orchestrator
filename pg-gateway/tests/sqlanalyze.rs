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
fn writes_without_pk_are_marked_broad() {
    for sql in [
        "UPDATE notes SET body = 'x' WHERE body = 'y'",
        "UPDATE notes SET body = 'x'",
        "DELETE FROM notes",
        "DELETE FROM notes WHERE body = 'y'",
    ] {
        match pg_gateway::sqlanalyze::analyze(sql).unwrap() {
            AnalyzedStatement::Write { broad, row_id, .. } => {
                assert!(broad, "{sql} should be broad");
                assert!(row_id.is_empty(), "{sql} should have no row id");
            }
            other => panic!("{sql}: expected write, got {other:?}"),
        }
    }
}

#[test]
fn rejects_multi_row_insert_and_conflict() {
    assert!(pg_gateway::sqlanalyze::analyze(
        "INSERT INTO notes (id, body) VALUES ('a', 'x'), ('b', 'y')"
    )
    .is_err());
    // Target-less ON CONFLICT DO NOTHING is now supported (provider-side
    // dedup on any unique constraint).
    assert!(pg_gateway::sqlanalyze::analyze(
        "INSERT INTO notes (id, body) VALUES ('a', 'x') ON CONFLICT DO NOTHING"
    )
    .is_ok());
}

#[test]
fn reads_allow_colocated_joins_reject_aggregates() {
    assert!(matches!(
        pg_gateway::sqlanalyze::analyze("SELECT * FROM notes"),
        Ok(AnalyzedStatement::Read { .. })
    ));
    assert!(matches!(
        pg_gateway::sqlanalyze::analyze("SELECT body FROM notes WHERE id = 'x'"),
        Ok(AnalyzedStatement::Read { .. })
    ));
    // Explicit JOINs are pushed down to co-located providers (allowed).
    assert!(matches!(
        pg_gateway::sqlanalyze::analyze("SELECT a.* FROM a JOIN b ON a.id = b.id"),
        Ok(AnalyzedStatement::Read { .. })
    ));
    assert!(pg_gateway::sqlanalyze::has_join("SELECT a.* FROM a JOIN b ON a.id = b.id"));
    // Comma / cross-product FROM lists stay rejected.
    assert!(pg_gateway::sqlanalyze::analyze("SELECT * FROM a, b WHERE a.id = b.id").is_err());
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
    // Any `x = $N` equality is treated as the pk candidate at Describe time
    // (the analyzer narrows it against the declared pk at Execute, after
    // params are inlined — see pk_placeholder docs).
    assert_eq!(
        pk_placeholder("SELECT * FROM notes WHERE body = $1").unwrap(),
        "$1".to_string()
    );
    assert_eq!(
        pk_placeholder("UPDATE notes SET body = 'x' WHERE id = $2").unwrap(),
        "$2".to_string()
    );
}

#[test]
fn insert_capture_forces_returning_star() {
    // Column-less INSERT: the gateway no longer maps columns — it just forces
    // RETURNING * and lets the authoritative Postgres produce the row.
    let sql = pg_gateway::sqlanalyze::insert_capture_sql("INSERT INTO notes VALUES ('a1', 'hello')")
        .unwrap();
    assert!(sql.to_uppercase().contains("RETURNING *"), "got: {sql}");
    // An existing RETURNING clause is normalized to RETURNING *.
    let sql = pg_gateway::sqlanalyze::insert_capture_sql(
        "INSERT INTO notes (id, body) VALUES ('a1', 'hello') RETURNING id",
    )
    .unwrap();
    assert!(sql.to_uppercase().contains("RETURNING *"), "got: {sql}");
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
#[test]
fn insert_without_pk_is_gateway_generated() {
    match pg_gateway::sqlanalyze::analyze("INSERT INTO notes (body) VALUES ('hi')").unwrap() {
        AnalyzedStatement::Write { generate_row_id, row_id_placeholder, returning, .. } => {
            assert!(generate_row_id);
            assert_eq!(row_id_placeholder, None);
            assert_eq!(returning, None);
        }
        other => panic!("expected write, got {other:?}"),
    }
}

#[test]
fn insert_returning_columns() {
    match pg_gateway::sqlanalyze::analyze("INSERT INTO notes (body) VALUES ('hi') RETURNING id, body").unwrap() {
        AnalyzedStatement::Write { returning, generate_row_id, .. } => {
            assert_eq!(returning, Some(vec!["id".to_string(), "body".to_string()]));
            assert!(generate_row_id);
        }
        other => panic!("expected write, got {other:?}"),
    }
}

#[test]
fn create_table_defaults_descriptor() {
    let columns = pg_gateway::sqlanalyze::extract_create_columns(
        "CREATE TABLE events (
            id bigserial PRIMARY KEY,
            external_id uuid DEFAULT gen_random_uuid(),
            created_at timestamptz DEFAULT now(),
            body text NOT NULL
        )",
    )
    .unwrap();
    let array = columns.as_array().unwrap();
    let by_name = |name: &str| {
        array
            .iter()
            .find(|column| column["name"] == name)
            .unwrap()
            .clone()
    };
    assert_eq!(by_name("id")["default"], "SERIAL");
    assert_eq!(by_name("id")["primaryKey"], true);
    assert_eq!(by_name("external_id")["default"], "UUID");
    assert_eq!(by_name("created_at")["default"], "NOW");
    assert_eq!(by_name("body")["notNull"], true);
    assert_eq!(by_name("body")["default"], serde_json::json!(null));
    assert_eq!(by_name("body")["primaryKey"], false);
}

#[test]
fn serial_and_identity_types_detected() {
    let columns = pg_gateway::sqlanalyze::extract_create_columns(
        "CREATE TABLE t (
            a serial,
            b bigint GENERATED BY DEFAULT AS IDENTITY,
            c text
        )",
    )
    .unwrap();
    let array = columns.as_array().unwrap();
    assert_eq!(array[0]["default"], "SERIAL");
    assert_eq!(array[1]["default"], "SERIAL");
    assert_eq!(array[2]["default"], serde_json::json!(null));
    assert!(pg_gateway::sqlanalyze::is_serial_type("bigserial"));
    assert!(!pg_gateway::sqlanalyze::is_serial_type("text"));
}

#[test]
fn table_level_pk_detected() {
    let columns = pg_gateway::sqlanalyze::extract_create_columns(
        "CREATE TABLE t (id uuid, body text, PRIMARY KEY (id))",
    )
    .unwrap();
    let array = columns.as_array().unwrap();
    assert_eq!(array[0]["primaryKey"], true);
    assert_eq!(array[1]["primaryKey"], false);
}

#[test]
fn literal_defaults_captured() {
    let columns = pg_gateway::sqlanalyze::extract_create_columns(
        "CREATE TABLE t (done boolean DEFAULT false, tag text DEFAULT 'inbox')",
    )
    .unwrap();
    let array = columns.as_array().unwrap();
    assert_eq!(array[0]["default"], false);
    assert_eq!(array[1]["default"], "inbox");
}

/// nostream's replaceable-event upsert: partial-index conflict target.
/// sqlparser cannot parse the predicate, so analysis must repair the
/// statement pre-parse and recover the verbatim predicate text.
#[test]
fn partial_index_conflict_upsert_analyzed() {
    let sql = "INSERT INTO events (id, event_pubkey, event_kind, event_created_at, event_content, event_tags, event_signature) VALUES ('11111111-1111-1111-1111-111111111111', '\\x0208', 0, 5, 'hi', '[[]]', '\\x0309') ON CONFLICT (event_pubkey, event_kind, event_deduplication) WHERE (event_kind = 0 OR event_kind = 3 OR event_kind = 41 OR (event_kind >= 10000 AND event_kind < 20000) OR (event_kind >= 30000 AND event_kind < 40000)) DO UPDATE SET event_created_at = 6, event_content = 'hi2' WHERE events.event_created_at < 6";
    match analyze(sql).unwrap() {
        AnalyzedStatement::Write {
            kind,
            table,
            row_id,
            broad,
            conflict_columns,
            conflict_predicate,
            ..
        } => {
            assert_eq!(kind, StatementKind::Insert);
            assert_eq!(table, "events");
            assert_eq!(row_id, "11111111-1111-1111-1111-111111111111");
            assert!(!broad);
            assert_eq!(
                conflict_columns,
                Some(vec![
                    "event_pubkey".to_string(),
                    "event_kind".to_string(),
                    "event_deduplication".to_string()
                ])
            );
            let predicate = conflict_predicate.expect("predicate must be recovered");
            assert!(predicate.starts_with("WHERE (event_kind = 0"));
            assert!(predicate.contains("event_kind >= 30000 AND event_kind < 40000"));
        }
        other => panic!("expected write, got {other:?}"),
    }
}

/// Predicate scan must not be confused by quoted parens or nested parens.
#[test]
fn partial_index_predicate_with_quotes_and_nesting() {
    let sql = "INSERT INTO t (id, body) VALUES ('a', 'x') ON CONFLICT (id) WHERE (body <> ')(' AND (body IS NOT NULL)) DO UPDATE SET body = 'y' WHERE t.id <> ''";
    match analyze(sql).unwrap() {
        AnalyzedStatement::Write { conflict_predicate, .. } => {
            assert_eq!(
                conflict_predicate.as_deref(),
                Some("WHERE (body <> ')(' AND (body IS NOT NULL))")
            );
        }
        other => panic!("expected write, got {other:?}"),
    }
}

/// A normal conflict target (no predicate) must not be "repaired".
#[test]
fn plain_conflict_has_no_predicate() {
    for sql in [
        "INSERT INTO notes (id, body) VALUES ('a', 'x') ON CONFLICT (id) DO UPDATE SET body = 'y'",
        "INSERT INTO notes (id, body) VALUES ('a', 'x') ON CONFLICT DO NOTHING",
    ] {
        match analyze(sql).unwrap() {
            AnalyzedStatement::Write { conflict_predicate, .. } => {
                assert!(conflict_predicate.is_none(), "{sql}");
            }
            other => panic!("{sql}: expected write, got {other:?}"),
        }
    }
}

/// Migration data-priming INSERT..SELECT (nostream's events_old -> events)
/// routes as a broad write (verbatim to every provider), not a row op.
#[test]
fn insert_select_routes_broad() {
    match analyze("INSERT INTO events (id, body) SELECT id, body FROM events_old ON CONFLICT DO NOTHING").unwrap() {
        AnalyzedStatement::Write { kind, broad, sql, .. } => {
            assert_eq!(kind, StatementKind::Insert);
            assert!(broad);
            assert!(sql.to_lowercase().contains("from events_old"));
        }
        other => panic!("expected write, got {other:?}"),
    }
    // Placeholders stay rejected (extended-protocol INSERT..SELECT).
    assert!(analyze("INSERT INTO t (id) SELECT id FROM old WHERE x = $1").is_err());
}

/// FROM-less function call (nostream's `select confirm_invoice($1,$2,$3)`):
/// classified as a read so fan-out executes it verbatim on providers.
#[test]
fn from_less_function_call_is_read() {
    assert!(matches!(
        analyze("select confirm_invoice('abc', 100, '2026-01-01T00:00:00Z')").unwrap(),
        AnalyzedStatement::Read { .. }
    ));
}
