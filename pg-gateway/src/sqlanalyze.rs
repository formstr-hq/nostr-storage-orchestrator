//! Statement analysis: classifies incoming PG SQL, extracts the target table
//! and (for writes) the primary-key predicate. The gateway supports a small
//!, explicit subset; everything else is rejected with a clear error so we
//! never silently misroute. Statements inside the subset are forwarded to
//! providers verbatim.

use sqlparser::ast::{
    AlterTableOperation, BinaryOperator, ColumnOption, DataType, Expr, GeneratedAs, ObjectName,
    Query, Select, SetExpr, SetOperator, Statement, TableConstraint, TableFactor, Value,
};
use sqlparser::dialect::GenericDialect;
use sqlparser::keywords::Keyword;
use sqlparser::parser::Parser;
use sqlparser::tokenizer::Token;

use crate::error::{GatewayError, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatementKind {
    /// CREATE TABLE
    Create,
    /// CREATE [UNIQUE] INDEX
    CreateIndex,
    Alter,
    Drop,
    Insert,
    Update,
    Delete,
    Select,
}

#[derive(Debug, Clone)]
pub enum AnalyzedStatement {
    Ddl { kind: StatementKind, table: String, sql: String },
    Write {
        kind: StatementKind,
        table: String,
        row_id: String,
        sql: String,
        /// Row-id placeholder name for extended-protocol writes (`$1`).
        row_id_placeholder: Option<String>,
        /// True when the INSERT omits the pk and the gateway must allocate it.
        generate_row_id: bool,
        /// Columns the INSERT asked to RETURN, or None when no RETURNING.
        returning: Option<Vec<String>>,
        /// True for UPDATE/DELETE without a pk predicate (bulk ops). These
        /// are only accepted when broad writes are enabled and are applied
        /// verbatim to every provider.
        broad: bool,
        /// INSERT ... ON CONFLICT (cols) target columns; None = plain insert.
        conflict_columns: Option<Vec<String>>,
        /// Verbatim predicate text of a partial-index conflict target
        /// (`ON CONFLICT (cols) WHERE <pred> DO UPDATE`), rendered as
        /// `WHERE <pred>`. Providers must replay it so the conflict hits
        /// the same partial unique index it hit here.
        conflict_predicate: Option<String>,
    },
    Read { sql: String },
    /// Aggregate/DISTINCT read routed through the map-reduce engine: providers
    /// compute partial aggregates over their exclusive slices, the gateway
    /// merges (see aggregate::merge_partials).
    Aggregate { plan: crate::aggregate::AggregatePlan },
}

/// Default primary-key column when the registry has no descriptor
/// (pre-registration writes, tests). Registered tables always resolve
/// their declared pk via `analyze_with_pk`.
pub const PK_COLUMN: &str = "id";

/// Resolves the pk column of `table` from the registry descriptor, falling
/// back to the default pk name when unregistered or pk-less.
pub fn pk_column_of(table: &crate::central::MeshTable) -> String {
    pk_from_columns(&table.columns).unwrap_or_else(|| PK_COLUMN.to_string())
}

/// Extracts the primary-key column name from a columns descriptor
/// ([{name, type, primaryKey: bool}, ...]).
pub fn pk_from_columns(columns: &serde_json::Value) -> Option<String> {
    columns
        .as_array()
        .and_then(|array| {
            array
                .iter()
                .find(|column| column.get("primaryKey").and_then(|value| value.as_bool()).unwrap_or(false))
                .and_then(|column| column.get("name").and_then(|name| name.as_str()))
                .map(|name| name.to_string())
        })
}

/// Like `analyze`, but pk-aware: writes/point-reads are detected against the
/// table's *declared* pk (e.g. `users.pubkey`), not the hardcoded `id`.
/// Unregistered tables keep the default pk.
pub fn analyze_with_pk(sql: &str, pk_column: Option<&str>) -> Result<AnalyzedStatement> {
    let pk = pk_column.unwrap_or(PK_COLUMN);
    analyze_pk(sql, pk)
}

pub fn analyze(sql: &str) -> Result<AnalyzedStatement> {
    analyze_pk(sql, PK_COLUMN)
}

fn analyze_pk(sql: &str, pk_column: &str) -> Result<AnalyzedStatement> {
    // sqlparser's GenericDialect accepts PostgreSQL syntax for everything in
    // our subset; statements are forwarded verbatim so dialect quirks never
    // change what a provider sees.
    //
    // Exception: `INSERT ... ON CONFLICT (cols) WHERE <pred> DO UPDATE` —
    // Postgres's partial-index conflict target. sqlparser cannot parse the
    // predicate between the column list and DO. The predicate slice is
    // excised (verbatim text is recovered for the provider op), the
    // remainder parses normally, and analysis proceeds on the repaired SQL.
    match Parser::parse_sql(&GenericDialect {}, sql) {
        Err(raw_error) => {
            if let Some(repaired) = strip_conflict_predicate(sql) {
                if Parser::parse_sql(&GenericDialect {}, &repaired.stripped_sql).is_ok() {
                    return analyze_pk_with_predicate(
                        &repaired.stripped_sql,
                        pk_column,
                        Some(repaired.predicate),
                        sql.to_string(),
                    );
                }
            }
            return Err(GatewayError::UnsupportedSql(normalize_parse_error(&raw_error)));
        }
        Ok(statements) => {
            if statements.len() != 1 {
                return Err(GatewayError::UnsupportedSql(
                    "exactly one statement per request is supported".to_string(),
                ));
            }
            analyze_statement(
                statements.into_iter().next().unwrap(),
                sql,
                pk_column,
                None,
                None,
            )
        }
    }
}

/// Result of excising a partial-index conflict-target predicate.
struct RepairedConflict {
    /// SQL with the `WHERE <pred>` slice removed (parses cleanly).
    stripped_sql: String,
    /// Verbatim `WHERE <pred>` text.
    predicate: String,
}

/// Detects and excises `ON CONFLICT (...) WHERE <pred> DO` in an INSERT.
/// Returns None when the statement does not carry the form. The predicate is
/// located between the ON CONFLICT target's closing paren and the DO keyword;
/// paren/quote depth is tracked so nested parens and quoted literals inside
/// the predicate do not break the scan.
fn strip_conflict_predicate(sql: &str) -> Option<RepairedConflict> {
    let upper = sql.to_ascii_uppercase();
    let on_pos = upper.find("ON CONFLICT")?;
    let target_paren = sql[on_pos..].find('(')? + on_pos;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut target_end = 0usize;
    for (offset, byte) in sql[target_paren..].bytes().enumerate() {
        match byte {
            b'\'' => in_string = !in_string,
            b'(' if !in_string => depth += 1,
            b')' if !in_string => {
                depth -= 1;
                if depth == 0 {
                    target_end = target_paren + offset + 1;
                    break;
                }
            }
            _ => {}
        }
    }
    if target_end == 0 || in_string {
        return None;
    }
    let after = sql[target_end..].trim_start();
    let after_upper = after.to_ascii_uppercase();
    // The predicate must start with WHERE and terminate at DO — otherwise
    // this is a plain conflict target and needs no repair.
    if !after_upper.starts_with("WHERE") {
        return None;
    }
    let do_pos = after_upper.find(" DO ")?;
    if do_pos == 0 {
        // `WHERE` immediately followed by ` DO` — empty predicate, malformed.
        return None;
    }
    let predicate = after[..do_pos].trim_end().to_string();
    // Rebuild cleanly: `ON CONFLICT (cols) ` + everything from `DO` onward
    // (verbatim), so the repaired SQL parses like an ordinary conflict form.
    let tail_offset = after.len() - after[do_pos..].len();
    let tail = after[tail_offset..].trim_start();
    let mut stripped_sql = String::with_capacity(sql.len());
    stripped_sql.push_str(&sql[..target_end]);
    stripped_sql.push(' ');
    stripped_sql.push_str(tail);
    Some(RepairedConflict { stripped_sql, predicate })
}

/// Analyze an INSERT whose partial-index predicate was excised. The predicate
/// rides on the resulting Write op; the op's SQL is the ORIGINAL text so
/// providers replay the statement verbatim.
fn analyze_pk_with_predicate(
    stripped_sql: &str,
    pk_column: &str,
    predicate: Option<String>,
    original_sql: String,
) -> Result<AnalyzedStatement> {
    let statements = Parser::parse_sql(&GenericDialect {}, stripped_sql)
        .map_err(|error| GatewayError::UnsupportedSql(normalize_parse_error(&error)))?;
    if statements.len() != 1 {
        return Err(GatewayError::UnsupportedSql(
            "exactly one statement per request is supported".to_string(),
        ));
    }
    analyze_statement(
        statements.into_iter().next().unwrap(),
        &original_sql,
        pk_column,
        predicate,
        Some(stripped_sql),
    )
}

/// Statement dispatch used by both the plain and repaired-analysis paths.
/// `predicate` is Some for the repaired partial-index conflict form;
/// `stripped_sql` (when Some) replaces the original as the SQL text recorded
/// in non-INSERT outcomes (the original never parses, so anything downstream
/// would reject it — but the repaired form is exactly what providers can
/// parse).
fn analyze_statement(
    statement: Statement,
    sql: &str,
    pk_column: &str,
    predicate: Option<String>,
    stripped_sql: Option<&str>,
) -> Result<AnalyzedStatement> {
    let _ = stripped_sql;
    match statement {
        Statement::Query(query) => analyze_select(*query, sql),
        Statement::Insert(insert) => {
            // Only full-row single INSERT (one VALUES tuple) is supported;
            // multi-row goes through as multiple buffer ops per tuple.
            let name = match &insert.table {
                sqlparser::ast::TableObject::TableName(name) => name.clone(),
                _ => {
                    return Err(GatewayError::UnsupportedSql(
                        "INSERT must target a plain table".to_string(),
                    ))
                }
            };
            let table = extract_table_name(&name)?;
            if insert.source.is_none() {
                return Err(GatewayError::UnsupportedSql(
                    "INSERT ... VALUES is required".to_string(),
                ));
            }
            let source = insert.source.as_ref().unwrap();
            let rows = match source.body.as_ref() {
                sqlparser::ast::SetExpr::Values(values) => &values.rows,
                sqlparser::ast::SetExpr::Select(_) => {
                    // INSERT INTO t (...) SELECT ... (no placeholders): used
                    // by migration data-priming steps (e.g. nostream's
                    // events_old -> events backfill). Routed verbatim to
                    // every provider under the broad-write policy, like DDL
                    // fallbacks — never buffered as row ops.
                    if !sql.contains('$') {
                        return Ok(AnalyzedStatement::Write {
                            kind: StatementKind::Insert,
                            table,
                            row_id: String::new(),
                            sql: sql.to_string(),
                            row_id_placeholder: None,
                            generate_row_id: false,
                            returning: None,
                            broad: true,
                            conflict_columns: None,
                            conflict_predicate: None,
                        });
                    }
                    return Err(GatewayError::UnsupportedSql(
                        "INSERT ... SELECT with placeholders is not supported".to_string(),
                    ));
                }
                _ => {
                    return Err(GatewayError::UnsupportedSql(
                        "INSERT with plain VALUES is required".to_string(),
                    ))
                }
            };
            if rows.len() > 1 {
                return Err(GatewayError::UnsupportedSql(
                    "multi-row INSERT is not supported; issue one INSERT per row".to_string(),
                ));
            }
            let conflict_columns = match insert.on.as_ref() {
                None => None,
                Some(sqlparser::ast::OnInsert::OnConflict(on_conflict)) => {
                    let columns = match on_conflict.conflict_target.as_ref() {
                        Some(sqlparser::ast::ConflictTarget::Columns(columns)) => {
                            Some(columns.iter().map(|ident| ident.value.clone()).collect::<Vec<String>>())
                        }
                        Some(_) => {
                            return Err(GatewayError::UnsupportedSql(
                                "ON CONFLICT ON CONSTRAINT is not supported".to_string(),
                            ))
                        }
                        // `ON CONFLICT DO NOTHING` without a target: any
                        // unique constraint dedups at the provider.
                        None => None,
                    };
                    columns
                }
                Some(_) => {
                    return Err(GatewayError::UnsupportedSql(
                        "INSERT OR / DUPLICATE KEY UPDATE is not supported".to_string(),
                    ))
                }
            };
            let row = &rows[0];
            let pk_index = insert
                .columns
                .iter()
                .position(|ident| object_name_eq(ident, pk_column));
            let pk_value = match pk_index {
                Some(index) => row.get(index),
                None => {
                    // INSERT without a column list: first column is the pk.
                    if insert.columns.is_empty() {
                        row.first()
                    } else {
                        // pk omitted -> gateway allocates it (RETURNING id works).
                        None
                    }
                }
            };
            let (row_id, row_id_placeholder, generate_row_id) = match pk_value {
                Some(Expr::Value(vws)) if matches!(vws.value, Value::Placeholder(_)) => {
                    let placeholder = match &vws.value {
                        Value::Placeholder(name) => name.clone(),
                        _ => unreachable!(),
                    };
                    (String::new(), Some(placeholder), false)
                }
                Some(value) => {
                    let row_id = literal_to_string(value)?;
                    (row_id, None, false)
                }
                None => (String::new(), None, true),
            };
            let returning = insert.returning.as_ref().map(|items| {
                items
                    .iter()
                    .filter_map(|item| match item {
                        sqlparser::ast::SelectItem::Wildcard(_) => None,
                        sqlparser::ast::SelectItem::UnnamedExpr(Expr::Identifier(ident)) => {
                            Some(ident.value.clone())
                        }
                        _ => None,
                    })
                    .collect::<Vec<String>>()
            });
            // The partial-index predicate recovered during the pre-parse
            // repair (None for ordinary conflict targets) rides with the
            // buffered op so providers replay the identical conflict clause.
            Ok(AnalyzedStatement::Write {
                kind: StatementKind::Insert,
                table,
                row_id,
                sql: sql.to_string(),
                row_id_placeholder,
                generate_row_id,
                returning,
                broad: false,
                conflict_columns,
                conflict_predicate: predicate,
            })
        }
        Statement::Update(update) => {
            let table = extract_table_factor_name(&update.table.relation)?;
            let pk_result = update.selection.as_ref().map(|expr| extract_pk_equality(expr, pk_column));
            let (row_id, broad) = match pk_result {
                Some(Ok(row_id)) => (row_id, false),
                Some(Err(_)) | None => (String::new(), true),
            };
            Ok(AnalyzedStatement::Write {
                kind: StatementKind::Update,
                table,
                row_id,
                sql: sql.to_string(),
                row_id_placeholder: None,
                generate_row_id: false,
                returning: None,
                broad,
                conflict_columns: None,
                conflict_predicate: None,
            })
        }
        Statement::Delete(delete) => {
            let table = extract_delete_table(delete.from.clone())?;
            let pk_result = delete.selection.as_ref().map(|expr| extract_pk_equality(expr, pk_column));
            let (row_id, broad) = match pk_result {
                Some(Ok(row_id)) => (row_id, false),
                Some(Err(_)) | None => (String::new(), true),
            };
            Ok(AnalyzedStatement::Write {
                kind: StatementKind::Delete,
                table,
                row_id,
                sql: sql.to_string(),
                row_id_placeholder: None,
                generate_row_id: false,
                returning: None,
                broad,
                conflict_columns: None,
                conflict_predicate: None,
            })
        }
        Statement::CreateTable(create) => {
            let table = extract_table_name(&create.name)?;
            Ok(AnalyzedStatement::Ddl { kind: StatementKind::Create, table, sql: sql.to_string() })
        }
        Statement::AlterTable(alter) => {
            let table = extract_table_name(&alter.name)?;
            Ok(AnalyzedStatement::Ddl { kind: StatementKind::Alter, table, sql: sql.to_string() })
        }
        Statement::Drop {
            object_type: sqlparser::ast::ObjectType::Table,
            names,
            ..
        } => {
            let table = extract_table_name(
                names
                    .first()
                    .ok_or_else(|| GatewayError::UnsupportedSql("DROP TABLE needs a name".to_string()))?,
            )?;
            Ok(AnalyzedStatement::Ddl { kind: StatementKind::Drop, table, sql: sql.to_string() })
        }
        Statement::CreateIndex(create_index) => {
            let table = match &create_index.table_name {
                sqlparser::ast::ObjectName(parts) => {
                    let last = parts.last().ok_or_else(|| {
                        GatewayError::UnsupportedSql("CREATE INDEX needs a table".to_string())
                    })?;
                    last.as_ident()
                        .map(|ident| ident.value.clone())
                        .ok_or_else(|| {
                            GatewayError::UnsupportedSql("index table must be an identifier".to_string())
                        })?
                }
            };
            Ok(AnalyzedStatement::Ddl { kind: StatementKind::CreateIndex, table, sql: sql.to_string() })
        }
        Statement::Drop {
            object_type: sqlparser::ast::ObjectType::Index,
            names,
            ..
        } => Ok(AnalyzedStatement::Ddl {
            kind: StatementKind::Drop,
            table: String::new(),
            sql: sql.to_string(),
        }),
        other => Err(GatewayError::UnsupportedSql(format!(
            "statement of kind {} is not supported",
            describe_statement(&other)
        ))),
    }
}

fn analyze_select(query: Query, sql: &str) -> Result<AnalyzedStatement> {
    if query.with.is_some() || query.fetch.is_some() || !query.locks.is_empty() {
        return Err(GatewayError::UnsupportedSql(
            "CTEs, window expressions and locking clauses are not supported".to_string(),
        ));
    }
    // LIMIT is allowed: fan-out applies it per provider (may over-fetch;
    // merge keeps the invariant "at least the requested rows from each
    // provider", which satisfies correctness for replicated data).
    // Set operations are pushed down verbatim: every provider evaluates the
    // whole UNION over its exclusive slice and the gateway merges by primary
    // key. Exclusive placement makes that exact for UNION — a row lives on
    // exactly one provider, so a per-provider evaluation cannot miss or
    // duplicate a row (the pk dedup also collapses a row that matches several
    // branches). EXCEPT/INTERSECT depend on rows that may live on *other*
    // providers, so a per-provider evaluation would be wrong: reject them.
    if let sqlparser::ast::SetExpr::SetOperation { .. } = query.body.as_ref() {
        let mut selects: Vec<&Select> = Vec::new();
        collect_union_selects(query.body.as_ref(), &mut selects)?;
        for select in selects {
            validate_union_select(select)?;
        }
        return Ok(AnalyzedStatement::Read { sql: sql.to_string() });
    }
    let body = match query.body.as_ref() {
        sqlparser::ast::SetExpr::Select(select) => select,
        _ => {
            return Err(GatewayError::UnsupportedSql(
                "plain SELECT is required (no UNION/VALUES on the read path)".to_string(),
            ))
        }
    };
    if body.from.is_empty() {
        // SELECT without FROM (e.g. `SELECT 1`): constant, no providers.
        return Ok(AnalyzedStatement::Read { sql: sql.to_string() });
    }
    // Aggregates / GROUP BY / HAVING: plan a map-reduce execution (providers
    // aggregate their exclusive slices, gateway merges). Falls through to the
    // plain read path when the query has none of these.
    let has_aggregate = query_has_aggregate(&query);
    let has_join = body.from.iter().any(|from| !from.joins.is_empty());
    let has_group_by = !matches!(body.group_by, sqlparser::ast::GroupByExpr::Expressions(ref items, _) if items.is_empty());
    // A bare DISTINCT projects whole rows. Without a join the aggregate engine
    // plans it (exact global tuple-dedup, even when the pk is not projected).
    // With a join that engine rejects the shape, but the plain read path
    // handles it: each provider runs the DISTINCT and the gateway dedups by
    // pk. So only joinless bare DISTINCT goes to the aggregate engine.
    // `DISTINCT ON (...)` is order-dependent and stays on the aggregate path
    // (where it is rejected if it cannot be planned), never the read path.
    let bare_distinct = matches!(body.distinct.as_ref(), Some(sqlparser::ast::Distinct::Distinct));
    let needs_aggregate = has_aggregate
        || body.having.is_some()
        || has_group_by
        || (body.distinct.is_some() && !(bare_distinct && has_join));
    if needs_aggregate {
        match crate::aggregate::plan_aggregate(sql) {
            Ok(plan) => return Ok(AnalyzedStatement::Aggregate { plan }),
            Err(error) => {
                // Not every aggregate shape is supported yet; surface the
                // plan error instead of the generic one.
                return Err(error);
            }
        }
    }
    // A single FROM entry may carry JOINs: they are pushed down to each
    // provider and executed locally. This is correct only for co-located
    // tables — i.e. a co-location group where matching rows always land on the
    // same provider (e.g. a trigger-derived table like nostream's event_tags,
    // which is created locally from the events rows a provider holds). Comma
    // (cross-product) FROM lists are still rejected.
    if body.from.len() != 1 {
        return Err(GatewayError::UnsupportedSql(
            "multiple FROM tables (comma joins) are not supported; use explicit JOIN".to_string(),
        ));
    }
    // Validate the projection so we can reject expressions the merge layer
    // cannot handle (star is fine, identifiers are fine; aggregates were
    // already planned above via the aggregate engine).
    for item in &body.projection {
        match item {
            sqlparser::ast::SelectItem::Wildcard(_) => {}
            sqlparser::ast::SelectItem::UnnamedExpr(expr)
            | sqlparser::ast::SelectItem::ExprWithAlias { expr, .. }
            | sqlparser::ast::SelectItem::ExprWithAliases { expr, .. } => {
                if expr_has_aggregate(expr) {
                    return Err(GatewayError::UnsupportedSql(
                        "aggregates are not supported yet".to_string(),
                    ));
                }
            }
            // `events.*` — the provider expands it to the table's columns;
            // the gateway reads the real columns back via query_with_columns.
            sqlparser::ast::SelectItem::QualifiedWildcard(_, _) => {}
        }
    }
    let _ = extract_table_factor_name(&body.from[0].relation)?;
    Ok(AnalyzedStatement::Read { sql: sql.to_string() })
}

/// True when any projection/order item is an aggregate function call.
fn query_has_aggregate(query: &Query) -> bool {
    if let sqlparser::ast::SetExpr::Select(select) = query.body.as_ref() {
        for item in &select.projection {
            let expr = match item {
                sqlparser::ast::SelectItem::UnnamedExpr(expr) => Some(expr),
                sqlparser::ast::SelectItem::ExprWithAlias { expr, .. } => Some(expr),
                _ => None,
            };
            if let Some(expr) = expr {
                if expr_has_aggregate(expr) {
                    return true;
                }
            }
        }
    }
    false
}

/// Flattens a UNION/UNION ALL tree into its leaf SELECTs. Rejects non-UNION
/// operators (EXCEPT/INTERSECT need cross-provider row knowledge and cannot be
/// evaluated per provider). Parenthesized operands (`SetExpr::Query`) are
/// descended so a branch's own ORDER BY/LIMIT does not hide its SELECT.
fn collect_union_selects<'a>(body: &'a SetExpr, out: &mut Vec<&'a Select>) -> Result<()> {
    match body {
        SetExpr::Select(select) => out.push(select),
        SetExpr::Query(query) => collect_union_selects(query.body.as_ref(), out)?,
        SetExpr::SetOperation { left, op, right, .. } => {
            if !matches!(op, SetOperator::Union) {
                return Err(GatewayError::UnsupportedSql(format!(
                    "{op} set operations are not supported; only UNION"
                )));
            }
            collect_union_selects(left, out)?;
            collect_union_selects(right, out)?;
        }
        _ => {
            return Err(GatewayError::UnsupportedSql(
                "UNION operands must be SELECT statements".to_string(),
            ))
        }
    }
    Ok(())
}

/// Validates one UNION branch. The statement is forwarded to providers
/// verbatim, so the shape must be one whose per-provider result is globally
/// correct under exclusive placement: plain row SELECTs (JOINs allowed,
/// DISTINCT allowed) with no aggregate/GROUP BY/HAVING — those need the
/// map-reduce engine, which cannot be combined inside a set operation.
fn validate_union_select(select: &Select) -> Result<()> {
    if select.having.is_some()
        || !matches!(select.group_by, sqlparser::ast::GroupByExpr::Expressions(ref items, _) if items.is_empty())
    {
        return Err(GatewayError::UnsupportedSql(
            "aggregates/GROUP BY/HAVING are not supported inside a UNION".to_string(),
        ));
    }
    for item in &select.projection {
        let expr = match item {
            sqlparser::ast::SelectItem::UnnamedExpr(expr) => Some(expr),
            sqlparser::ast::SelectItem::ExprWithAlias { expr, .. } => Some(expr),
            sqlparser::ast::SelectItem::ExprWithAliases { expr, .. } => Some(expr),
            _ => None,
        };
        if let Some(expr) = expr {
            if expr_has_aggregate(expr) {
                return Err(GatewayError::UnsupportedSql(
                    "aggregates are not supported inside a UNION".to_string(),
                ));
            }
        }
    }
    Ok(())
}

/// First leaf SELECT of a query body, descending set operations and
/// parenthesized operands. UNION branches must agree on arity (Postgres
/// enforces this), so the first branch's shape describes the result.
fn first_select(body: &SetExpr) -> Option<&Select> {
    match body {
        SetExpr::Select(select) => Some(select),
        SetExpr::Query(query) => first_select(query.body.as_ref()),
        SetExpr::SetOperation { left, .. } => first_select(left),
        _ => None,
    }
}

fn expr_has_aggregate(expr: &Expr) -> bool {
    match expr {
        Expr::Function(function) => {
            let name = function
                .name
                .0
                .last()
                .and_then(|part| part.as_ident().map(|ident| ident.value.to_ascii_lowercase()));
            // Reject aggregates outright until the distributed-aggregation
            // update lands — a naive fan-out merge would return wrong results
            // (notably string_agg/array_agg silently truncating to one node).
            matches!(
                name.as_deref(),
                Some("count") | Some("sum") | Some("avg") | Some("min") | Some("max")
                    | Some("string_agg") | Some("array_agg") | Some("json_agg")
                    | Some("jsonb_agg") | Some("bool_and") | Some("bool_or")
                    | Some("every") | Some("bit_and") | Some("bit_or")
                    | Some("stddev") | Some("stddev_pop") | Some("stddev_samp")
                    | Some("variance") | Some("var_pop") | Some("var_samp")
            )
        }
        Expr::BinaryOp { left, right, .. } => expr_has_aggregate(left) || expr_has_aggregate(right),
        Expr::Nested(inner) => expr_has_aggregate(inner),
        _ => false,
    }
}

fn object_name_eq(name: &ObjectName, expected: &str) -> bool {
    name.0.len() == 1
        && name.0[0]
            .as_ident()
            .map(|ident| ident.value.eq_ignore_ascii_case(expected))
            .unwrap_or(false)
}

fn extract_table_name(name: &ObjectName) -> Result<String> {
    // Accept an optional `public.` schema qualifier. Tools like pgweb (and many
    // ORMs) emit schema-qualified names; the mesh only manages the public
    // schema, so `public.<t>` is just `<t>`. Any other schema is rejected.
    let ident = match name.0.as_slice() {
        [table] => table.as_ident(),
        [schema, table] => {
            let schema_ok = schema
                .as_ident()
                .map(|ident| ident.value.eq_ignore_ascii_case("public"))
                .unwrap_or(false);
            if !schema_ok {
                return Err(GatewayError::UnsupportedSql(
                    "only tables in the public schema are supported".to_string(),
                ));
            }
            table.as_ident()
        }
        _ => {
            return Err(GatewayError::UnsupportedSql(
                "qualified table names deeper than schema.table are not supported".to_string(),
            ));
        }
    };
    let ident = ident
        .ok_or_else(|| GatewayError::UnsupportedSql("table name must be an identifier".to_string()))?;
    Ok(ident.value.clone())
}

fn extract_table_factor_name(factor: &TableFactor) -> Result<String> {
    match factor {
        TableFactor::Table { name, .. } => extract_table_name(name),
        _ => Err(GatewayError::UnsupportedSql(
            "only plain table references are supported".to_string(),
        )),
    }
}

fn extract_delete_table(from: sqlparser::ast::FromTable) -> Result<String> {
    let tables = match from {
        sqlparser::ast::FromTable::WithFromKeyword(tables) => tables,
        sqlparser::ast::FromTable::WithoutKeyword(tables) => tables,
    };
    let item = tables
        .first()
        .ok_or_else(|| GatewayError::UnsupportedSql("DELETE needs a table".to_string()))?;
    extract_table_factor_name(&item.relation)
}

/// Walks a WHERE clause and requires the shape `<pk> = <literal>` or
/// `<literal> = <pk>` (AND-chains are accepted as long as one conjunct
/// constrains the pk).
fn extract_pk_equality(expr: &Expr, pk_column: &str) -> Result<String> {
    match expr {
        Expr::BinaryOp { left, op: BinaryOperator::And, right } => extract_pk_equality(left, pk_column)
            .or_else(|_| extract_pk_equality(right, pk_column)),
        Expr::BinaryOp { left, op: BinaryOperator::Eq, right } => {
            match (identifier_name(left), literal_to_string_expr(right)) {
                (Some(name), Some(value)) if name.eq_ignore_ascii_case(pk_column) => Ok(value),
                _ => match (identifier_name(right), literal_to_string_expr(left)) {
                    (Some(name), Some(value)) if name.eq_ignore_ascii_case(pk_column) => Ok(value),
                    _ => Err(GatewayError::WriteRequiresPk(format!(
                        "WHERE must constrain \"{pk_column}\" to a literal"
                    ))),
                },
            }
        }
        _ => Err(GatewayError::WriteRequiresPk(format!(
            "WHERE must constrain \"{pk_column}\" to a literal"
        ))),
    }
}

fn identifier_name(expr: &Expr) -> Option<String> {
    match expr {
        Expr::Identifier(ident) => Some(ident.value.clone()),
        Expr::CompoundIdentifier(parts) => parts.last().map(|ident| ident.value.clone()),
        _ => None,
    }
}

fn literal_to_string(expr: &Expr) -> Result<String> {
    literal_to_string_expr(expr).ok_or_else(|| {
        GatewayError::UnsupportedSql("primary-key predicate must be a literal".to_string())
    })
}

/// Text form of a literal PK value. Parameter markers are resolved later at
/// bind time by the wire layer (row_id recorded here is the literal form).
fn literal_to_string_expr(expr: &Expr) -> Option<String> {
    match expr {
        Expr::Value(value) => value_to_string(&value.value),
        // Param inlining emits `decode('<hex>','hex')::bytea` for binary
        // values; unwrap cast + function to reach the inner hex literal.
        Expr::Cast { expr: inner, .. } => literal_to_string_expr(inner),
        Expr::Function(function) => {
            let is_decode = function
                .name
                .0
                .last()
                .and_then(|part| part.as_ident())
                .map(|ident| ident.value.eq_ignore_ascii_case("decode"))
                .unwrap_or(false);
            if !is_decode {
                return None;
            }
            let args = match &function.args {
                sqlparser::ast::FunctionArguments::List(list) => &list.args,
                _ => return None,
            };
            let first = args.first()?;
            match first {
                sqlparser::ast::FunctionArg::Unnamed(sqlparser::ast::FunctionArgExpr::Expr(expr)) => {
                    match expr {
                        Expr::Value(vws) => value_to_string(&vws.value),
                        _ => None,
                    }
                }
                _ => None,
            }
        }
        Expr::Identifier(ident) => Some(ident.value.clone()),
        Expr::CompoundIdentifier(parts) => parts.last().map(|ident| ident.value.clone()),
        _ => None,
    }
}

pub fn value_to_string(value: &Value) -> Option<String> {
    match value {
        Value::SingleQuotedString(text) | Value::DoubleQuotedString(text) => Some(text.clone()),
        // PostgreSQL E'...' escape strings (bytea hex literals etc.).
        Value::EscapedStringLiteral(text) => Some(text.clone()),
        Value::Number(number, _) => Some(number.clone()),
        Value::Boolean(flag) => Some(flag.to_string()),
        Value::Null => Some("\u{0}null".to_string()),
        Value::Placeholder(name) => Some(format!("\x1ePARAM:{name}")),
        _ => None,
    }
}

pub fn describe_statement_kind(statement: &Statement) -> &'static str {
    match statement {
        Statement::Query(_) => "SELECT",
        Statement::Insert(_) => "INSERT",
        Statement::Update(_) => "UPDATE",
        Statement::Delete(_) => "DELETE",
        Statement::CreateTable(_) => "CREATE TABLE",
        Statement::AlterTable(_) => "ALTER TABLE",
        Statement::Drop { .. } => "DROP",
        _ => "unknown",
    }
}

fn describe_statement(statement: &Statement) -> String {
    describe_statement_kind(statement).to_string()
}

fn normalize_parse_error(error: &sqlparser::parser::ParserError) -> String {
    match error {
        sqlparser::parser::ParserError::ParserError(message) => message.clone(),
        sqlparser::parser::ParserError::TokenizerError(message) => message.clone(),
        other => other.to_string(),
    }
}

/// Columns of a CREATE TABLE, in declaration order, as the canonical JSON
/// shape stored in the registry:
///   [{name, type, default: "SERIAL" | "UUID" | "NOW" | <literal-json> | null,
///     notNull: bool, primaryKey: bool}]
/// `default` captures exactly the server-generated values the gateway must
/// materialize so every provider replica receives identical rows.
pub fn extract_create_columns(sql: &str) -> Result<serde_json::Value> {
    let statements = Parser::parse_sql(&GenericDialect {}, sql)
        .map_err(|error| GatewayError::UnsupportedSql(normalize_parse_error(&error)))?;
    for statement in statements {
        if let Statement::CreateTable(create) = statement {
            let columns: Vec<serde_json::Value> = create
                .columns
                .iter()
                .map(|column| {
                    let mut default = serde_json::Value::Null;
                    let mut not_null = false;
                    let mut primary_key = false;
                    for option in &column.options {
                        match &option.option {
                            ColumnOption::Default(expr) => {
                                default = default_to_descriptor(&column.data_type, expr);
                            }
                            ColumnOption::NotNull => not_null = true,
                            ColumnOption::PrimaryKey(_) => primary_key = true,
                            // GENERATED ... AS IDENTITY / BIGSERIAL-family handled via
                            // type+default; explicit identity options count as SERIAL.
                            ColumnOption::DialectSpecific(tokens) => {
                                if tokens.iter().any(|token| matches!(token, Token::Word(word) if word.keyword == Keyword::AUTOINCREMENT || word.keyword == Keyword::AUTO_INCREMENT)) {
                                    default = serde_json::json!("SERIAL");
                                }
                            }
                            ColumnOption::Generated { generated_as, sequence_options, .. } => {
                                // `GENERATED ALWAYS/BY DEFAULT AS IDENTITY` is
                                // sequence-backed; sequence_options present marks it.
                                if matches!(generated_as, GeneratedAs::Always | GeneratedAs::ByDefault)
                                    && sequence_options.is_some()
                                {
                                    default = serde_json::json!("SERIAL");
                                }
                            }
                            _ => {}
                        }
                    }
                    if describe_column_type(&column.data_type).to_ascii_lowercase().ends_with("serial") {
                        default = serde_json::json!("SERIAL");
                    }
                    serde_json::json!({
                        "name": column.name.value,
                        "type": describe_column_type(&column.data_type),
                        "default": default,
                        "notNull": not_null,
                        "primaryKey": primary_key,
                    })
                })
                .collect();
            // Table-level PRIMARY KEY constraints mark the pk column too.
            let mut columns = serde_json::Value::Array(columns);
            for constraint in &create.constraints {
                if let TableConstraint::PrimaryKey(pk) = constraint {
                    for index_column in &pk.columns {
                        // IndexColumn wraps an OrderByExpr whose expr is the Ident.
                        let name = match &index_column.column.expr {
                            Expr::Identifier(ident) => ident.value.clone(),
                            _ => continue,
                        };
                        if let Some(entry) = columns
                            .as_array_mut()
                            .unwrap()
                            .iter_mut()
                            .find(|column| column["name"] == name)
                        {
                            entry["primaryKey"] = serde_json::json!(true);
                        }
                    }
                }
            }
            return Ok(columns);
        }
    }
    Err(GatewayError::UnsupportedSql("could not re-parse CREATE TABLE".to_string()))
}

/// Classifies a DEFAULT expression into a gateway-materializable descriptor.
/// Returns "SERIAL" (central sequence), "UUID" (gateway uuid), "NOW"
/// (gateway clock), a JSON literal, or null when unsupported (the DDL is
/// rejected upstream if required).
fn default_to_descriptor(data_type: &DataType, expr: &Expr) -> serde_json::Value {
    let type_text = describe_column_type(data_type).to_ascii_lowercase();
    match expr {
        Expr::Function(function) => {
            let name = function
                .name
                .0
                .last()
                .and_then(|part| part.as_ident())
                .map(|ident| ident.value.to_ascii_lowercase());
            match name.as_deref() {
                Some("gen_random_uuid") | Some("uuid_generate_v4") => serde_json::json!("UUID"),
                Some("now") | Some("current_timestamp") | Some("clock_timestamp") => {
                    serde_json::json!("NOW")
                }
                _ => serde_json::Value::Null,
            }
        }
        Expr::Value(vws) => match &vws.value {
            Value::Number(number, _) => {
                // A numeric literal default on a serial-typed column is a seed.
                if type_text.ends_with("serial") {
                    serde_json::json!("SERIAL")
                } else {
                    serde_json::json!(number.clone())
                }
            }
            Value::SingleQuotedString(text) => serde_json::json!(text.clone()),
            Value::Null => serde_json::Value::Null,
            Value::Boolean(flag) => serde_json::json!(flag),
            _ => serde_json::Value::Null,
        },
        Expr::Cast { .. } | Expr::Nested(_) => serde_json::Value::Null,
        _ => serde_json::Value::Null,
    }
}

/// True when the column type is sequence-backed.
pub fn is_serial_type(type_text: &str) -> bool {
    let lower = type_text.to_ascii_lowercase();
    lower == "serial" || lower == "smallserial" || lower == "bigserial"
}

fn describe_column_type(data_type: &DataType) -> String {
    data_type.to_string()
}

/// Returns true when a DDL statement is inside the additive-only subset.
/// Column descriptors ([{name, type, ...}, ...]) for every ADD COLUMN in an
/// ALTER statement, merged into an existing registry descriptor. Empty when
/// the ALTER adds no plain columns (constraints only).
pub fn extract_add_columns(sql: &str) -> Result<Vec<serde_json::Value>> {
    let statements = Parser::parse_sql(&GenericDialect {}, sql)
        .map_err(|error| GatewayError::UnsupportedSql(normalize_parse_error(&error)))?;
    let mut columns = Vec::new();
    for statement in statements {
        if let Statement::AlterTable(alter) = statement {
            for operation in alter.operations {
                if let AlterTableOperation::AddColumn { column_def, .. } = operation {
                    // Reuse the CREATE-table descriptor shape for one column.
                    let mut default = serde_json::Value::Null;
                    let mut not_null = false;
                    let mut primary_key = false;
                    for option in &column_def.options {
                        match &option.option {
                            ColumnOption::Default(expr) => {
                                default = default_to_descriptor(&column_def.data_type, expr);
                            }
                            ColumnOption::NotNull => not_null = true,
                            ColumnOption::PrimaryKey(_) => primary_key = true,
                            _ => {}
                        }
                    }
                    let name = column_def.name.value.clone();
                    columns.push(serde_json::json!({
                        "name": name,
                        "type": describe_column_type(&column_def.data_type),
                        "default": default,
                        "notNull": not_null,
                        "primaryKey": primary_key,
                    }));
                }
            }
        }
    }
    Ok(columns)
}

pub fn is_additive_ddl(kind: &StatementKind, sql: &str) -> Result<bool> {
    let statements = Parser::parse_sql(&GenericDialect {}, sql)
        .map_err(|error| GatewayError::UnsupportedSql(normalize_parse_error(&error)))?;
    for statement in statements {
        match statement {
            Statement::AlterTable(alter) => {
                for operation in alter.operations {
                    match operation {
                        sqlparser::ast::AlterTableOperation::AddColumn { .. } => {}
                        sqlparser::ast::AlterTableOperation::AddConstraint { .. } => {}
                        _ => {
                            return Err(GatewayError::UnsupportedSql(
                                "only ADD COLUMN and ADD CONSTRAINT alterations are supported"
                                    .to_string(),
                            ))
                        }
                    }
                }
            }
            Statement::CreateTable(_) => {
                debug_assert!(matches!(kind, StatementKind::Create));
            }
            Statement::CreateIndex(_) => {}
            Statement::Drop {
                object_type: sqlparser::ast::ObjectType::Table,
                ..
            } => {
                // DROP TABLE is allowed; it is destructive but explicit.
                return Ok(true);
            }
            Statement::Drop {
                object_type: sqlparser::ast::ObjectType::Index,
                ..
            } => {}
            _ => {
                return Err(GatewayError::UnsupportedSql(
                    "only CREATE TABLE, ALTER TABLE ... ADD COLUMN and DROP TABLE are supported"
                        .to_string(),
                ))
            }
        }
    }
    Ok(true)
}

/// True when the statement is a bare session command the gateway can answer
/// itself without touching providers (psql startup handshakes etc.).
pub fn is_session_command(sql: &str) -> bool {
    let trimmed = sql.trim().trim_end_matches(';').trim();
    let upper = trimmed.to_ascii_uppercase();
    let first = upper.split_whitespace().next().unwrap_or("");
    matches!(
        first,
        "BEGIN" | "COMMIT" | "ROLLBACK" | "SET" | "RESET" | "SHOW" | "DISCARD" | "DEALLOCATE" | "LISTEN" | "UNLISTEN" | "CLOSE"
    ) || upper.starts_with("SELECT CURRENT_USER")
        || upper.starts_with("SELECT CURRENT_SCHEMA")
        || upper.starts_with("SELECT PG_CATALOG.PG_IS_IN_RECOVERY")
        || upper.starts_with("SELECT CURRENT_SETTING")
        || upper.starts_with("SHOW ")
}


/// Row-id literal for point reads: Some when the WHERE clause is exactly one
/// `<pk> = <literal>` (or reversed) equality.
pub fn point_read_row_id(sql: &str) -> Result<Option<String>> {
    point_read_row_id_with_pk(sql, PK_COLUMN)
}

/// Point-read detection against a declared pk column.
pub fn point_read_row_id_with_pk(sql: &str, pk_column: &str) -> Result<Option<String>> {
    let statements = Parser::parse_sql(&GenericDialect {}, sql)
        .map_err(|error| GatewayError::UnsupportedSql(normalize_parse_error(&error)))?;
    for statement in statements {
        if let Statement::Query(query) = statement {
            if let sqlparser::ast::SetExpr::Select(select) = query.body.as_ref() {
                if select.from.len() != 1 {
                    return Ok(None);
                }
                return Ok(match select.selection.as_ref() {
                    Some(where_clause) => extract_pk_equality(where_clause, pk_column).ok(),
                    None => None,
                });
            }
        }
    }
    Ok(None)
}

/// Placeholder name (e.g. "$1") when a statement's WHERE constrains the pk
/// to a parameter marker instead of a literal.
/// Highest `$N` parameter index referenced in the SQL (0 if none). Postgres
/// numbers bind parameters `$1..$N`, so this is the parameter count reported in
/// Describe. Counts the same way `inline_params` substitutes (naive `$N` scan),
/// so the two stay consistent. Clients (pgweb sends `LIMIT $1 OFFSET $2`) reject
/// a Bind whose count disagrees with the Describe.
pub fn max_param_index(sql: &str) -> usize {
    let bytes = sql.as_bytes();
    let mut max = 0usize;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'$' {
            let mut j = i + 1;
            let mut num = 0usize;
            let mut has_digit = false;
            while j < bytes.len() && bytes[j].is_ascii_digit() {
                num = num * 10 + (bytes[j] - b'0') as usize;
                has_digit = true;
                j += 1;
            }
            if has_digit {
                if num > max {
                    max = num;
                }
                i = j;
                continue;
            }
        }
        i += 1;
    }
    max
}

pub fn pk_placeholder(sql: &str) -> Option<String> {
    // Any `ident = $N` equality can be the pk placeholder; the analyzer
    // narrows it to the declared pk at execute time (extended protocol
    // inlines params before analysis anyway, so this only feeds row-id
    // binding for point reads).
    let statements = Parser::parse_sql(&GenericDialect {}, sql).ok()?;
    for statement in statements {
        let selection = match statement {
            Statement::Query(query) => match query.body.as_ref() {
                sqlparser::ast::SetExpr::Select(select) => select.selection.clone(),
                _ => None,
            },
            Statement::Update(update) => update.selection.clone(),
            Statement::Delete(delete) => delete.selection.clone(),
            _ => None,
        };
        if let Some(where_clause) = selection {
            // Any `x = $N` equality in the WHERE clause can be the pk
            // placeholder; the analyzer narrows it to the real pk later.
            if let Some(name) = any_placeholder_equality(&where_clause) {
                return Some(name);
            }
        }
    }
    None
}

/// Placeholder of ANY `<ident> = $N` equality (pk or not): point-read
/// detection refines it against the declared pk at execute time.
fn any_placeholder_equality(expr: &Expr) -> Option<String> {
    match expr {
        Expr::BinaryOp { left, op: BinaryOperator::And, right } => {
            any_placeholder_equality(left).or_else(|| any_placeholder_equality(right))
        }
        Expr::BinaryOp { left, op: BinaryOperator::Eq, right } => {
            for (a, b) in [(left, right), (right, left)] {
                if identifier_name(a).is_some() {
                    if let Expr::Value(vws) = b.as_ref() {
                        if let Value::Placeholder(name) = &vws.value {
                            return Some(name.clone());
                        }
                    }
                }
            }
            None
        }
        _ => None,
    }
}

fn placeholder_in_equality(expr: &Expr) -> Option<String> {
    match expr {
        Expr::BinaryOp { left, op: BinaryOperator::And, right } => {
            placeholder_in_equality(left).or_else(|| placeholder_in_equality(right))
        }
        Expr::BinaryOp { left, op: BinaryOperator::Eq, right } => {
            for (a, b) in [(left, right), (right, left)] {
                let identifier = identifier_name(a)?;
                if !identifier.eq_ignore_ascii_case(PK_COLUMN) {
                    continue;
                }
                if let Expr::Value(vws) = b.as_ref() {
                    if let Value::Placeholder(name) = &vws.value {
                        return Some(name.clone());
                    }
                }
            }
            None
        }
        _ => None,
    }
}

/// True when any leaf SELECT's FROM carries JOINs. For a UNION/UNION ALL, the
/// first branch is representative: Postgres requires every branch to have
/// identical arity, and nostream's unions are over one table. The
/// read-your-writes buffer overlay keys on the base table's pk and cannot
/// re-evaluate join predicates against pending rows, so it is skipped for
/// joins.
pub fn has_join(sql: &str) -> bool {
    let Ok(statements) = Parser::parse_sql(&GenericDialect {}, sql) else {
        return false;
    };
    for statement in statements {
        if let Statement::Query(query) = statement {
            let mut selects: Vec<&Select> = Vec::new();
            if collect_union_selects(query.body.as_ref(), &mut selects).is_ok() {
                return selects.iter().any(|select| select.from.iter().any(|from| !from.joins.is_empty()));
            }
        }
    }
    false
}

/// True when the read is a UNION/UNION ALL (a set operation rather than a
/// single SELECT). The read-your-writes buffer overlay re-evaluates no
/// predicates, so it is skipped for set operations for the same reason it is
/// skipped for joins: a pending row may not match a branch's filter.
pub fn has_set_operation(sql: &str) -> bool {
    let Ok(statements) = Parser::parse_sql(&GenericDialect {}, sql) else {
        return false;
    };
    statements.into_iter().any(|statement| match statement {
        Statement::Query(query) => matches!(query.body.as_ref(), SetExpr::SetOperation { .. }),
        _ => false,
    })
}

/// SQL to send to a provider for a read. `nostream`'s UNIONs render as
/// `(select ...) UNION (select ...)`, which pg-agent rejects because the
/// statement does not begin with SELECT/WITH (`only_single_select_supported`).
/// Wrapping is semantically identical, satisfies "a single read-only SELECT",
/// and requires no provider upgrade.
pub fn provider_read_sql(sql: &str) -> String {
    if !has_set_operation(sql) {
        return sql.to_string();
    }
    // Providers reject a second statement; a trailing semicolon would break
    // the derived-table wrap (`select * from (select ...;)`).
    let trimmed = sql.trim().trim_end_matches(';').trim_end();
    format!("select * from ({trimmed}) as _mesh_union")
}

pub fn read_table_name(sql: &str) -> Option<String> {
    let statements = Parser::parse_sql(&GenericDialect {}, sql).ok()?;
    for statement in statements {
        if let Statement::Query(query) = statement {
            if let Some(select) = first_select(query.body.as_ref()) {
                if let Some(from) = select.from.first() {
                    if let TableFactor::Table { name, .. } = &from.relation {
                        return extract_table_name(name).ok();
                    }
                }
            }
        }
    }
    None
}

/// True when the read projects `*` (its DataRow arity equals the full table
/// column list, so a registry-backed describe is safe to answer).
pub fn is_select_star(sql: &str) -> bool {
    let Ok(statements) = Parser::parse_sql(&GenericDialect {}, sql) else {
        return false;
    };
    for statement in statements {
        if let Statement::Query(query) = statement {
            if let Some(select) = first_select(query.body.as_ref()) {
                return select
                    .projection
                    .iter()
                    .any(|item| matches!(item, sqlparser::ast::SelectItem::Wildcard(_)));
            }
        }
    }
    false
}

/// Projection of a SELECT as (name, is_identifier) pairs, in output order.
/// Plain `*` yields None (the whole table). Unsupported expressions are
/// filtered; describe falls back to TEXT for anything it cannot resolve.
/// For a UNION, the first branch is representative (all branches must agree
/// on arity).
pub fn select_projection(sql: &str) -> Option<Option<Vec<String>>> {
    let Ok(statements) = Parser::parse_sql(&GenericDialect {}, sql) else {
        return None;
    };
    for statement in statements {
        if let Statement::Query(query) = statement {
            if let Some(select) = first_select(query.body.as_ref()) {
                let mut columns = Vec::new();
                for item in &select.projection {
                    match item {
                        sqlparser::ast::SelectItem::Wildcard(_) => {
                            return Some(None);
                        }
                        sqlparser::ast::SelectItem::UnnamedExpr(Expr::Identifier(ident)) => {
                            columns.push(ident.value.clone());
                        }
                        sqlparser::ast::SelectItem::ExprWithAlias {
                            alias, ..
                        } => {
                            columns.push(alias.value.clone());
                        }
                        sqlparser::ast::SelectItem::ExprWithAliases {
                            aliases, ..
                        } => {
                            for alias in aliases.iter() {
                                columns.push(alias.value.clone());
                            }
                        }
                        sqlparser::ast::SelectItem::UnnamedExpr(_) => {
                            // Expression projection: shape unknown here.
                            return Some(Some(Vec::new()));
                        }
                        sqlparser::ast::SelectItem::QualifiedWildcard(kind, _) => {
                            // `<table>.*` on the read's base table is the whole
                            // table (so a registry-backed describe is exact) —
                            // this is what nostream's `select distinct
                            // "events".*` join reads project. A qualifier for
                            // any other table is left unresolved.
                            let qualifier = match kind {
                                sqlparser::ast::SelectItemQualifiedWildcardKind::ObjectName(name) => {
                                    name.0.last().and_then(|part| part.as_ident())
                                }
                                _ => None,
                            };
                            let base = select
                                .from
                                .first()
                                .and_then(|from| match &from.relation {
                                    TableFactor::Table { name, .. } => name.0.last().and_then(|p| p.as_ident()),
                                    _ => None,
                                });
                            match (qualifier, base) {
                                (Some(q), Some(b)) if q.value.eq_ignore_ascii_case(&b.value) => {
                                    return Some(None);
                                }
                                _ => return Some(Some(Vec::new())),
                            }
                        }
                    }
                }
                return Some(Some(columns));
            }
        }
    }
    None
}

/// Best-effort table name of a write statement (INSERT/UPDATE/DELETE);
/// used to resolve the declared pk before analysis. None for non-writes.
pub fn write_or_read_table(sql: &str) -> Option<String> {
    let statements = Parser::parse_sql(&GenericDialect {}, sql).ok()?;
    let statement = statements.into_iter().next()?;
    match statement {
        Statement::Insert(insert) => match &insert.table {
            sqlparser::ast::TableObject::TableName(name) => extract_table_name(name).ok(),
            _ => None,
        },
        Statement::Update(update) => extract_table_factor_name(&update.table.relation).ok(),
        Statement::Delete(delete) => extract_delete_table(delete.from.clone()).ok(),
        Statement::Query(_) => read_table_name(sql),
        _ => None,
    }
}

/// Rewrites an INSERT to force `RETURNING *`, so executing it against the
/// authoritative Postgres yields the complete, resolved row image. The gateway
/// no longer reconstructs rows from the statement — Postgres does, which is why
/// column mapping (and its col0/col1 fallback) is gone.
pub fn insert_capture_sql(sql: &str) -> Result<String> {
    // Partial-index conflict targets do not parse (see strip_conflict_
    // predicate): analyze the repaired form, then re-inject the predicate
    // into the rendered capture SQL at the same spot.
    let repaired = strip_conflict_predicate(sql);
    let parse_sql = repaired
        .as_ref()
        .map(|repaired| repaired.stripped_sql.as_str())
        .unwrap_or(sql);
    let mut statements = Parser::parse_sql(&GenericDialect {}, parse_sql)
        .map_err(|error| GatewayError::UnsupportedSql(normalize_parse_error(&error)))?;
    let Some(Statement::Insert(insert)) = statements.get_mut(0) else {
        return Err(GatewayError::UnsupportedSql("expected INSERT".to_string()));
    };
    insert.returning = Some(vec![sqlparser::ast::SelectItem::Wildcard(
        sqlparser::ast::WildcardAdditionalOptions::default(),
    )]);
    let rendered = statements[0].to_string();
    if let Some(repaired) = repaired {
        // Re-insert `WHERE <pred>` after the conflict column list. The
        // rendered form is `... ON CONFLICT (cols) DO UPDATE ...` — splice
        // before the DO, tracking the column list's closing paren.
        if let Some(position) = rendered.to_ascii_uppercase().find("ON CONFLICT") {
            let after = &rendered[position..];
            let paren = match after.find('(') {
                Some(offset) => position + offset,
                None => return Err(GatewayError::UnsupportedSql("malformed conflict target".to_string())),
            };
            let mut depth = 0usize;
            let mut in_string = false;
            let mut target_end = None;
            for (offset, byte) in rendered[paren..].bytes().enumerate() {
                match byte {
                    b'\'' => in_string = !in_string,
                    b'(' if !in_string => depth += 1,
                    b')' if !in_string => {
                        depth -= 1;
                        if depth == 0 {
                            target_end = Some(paren + offset + 1);
                            break;
                        }
                    }
                    _ => {}
                }
            }
            let target_end = match target_end {
                Some(end) => end,
                None => return Err(GatewayError::UnsupportedSql("malformed conflict target".to_string())),
            };
            let mut capture = String::with_capacity(rendered.len() + repaired.predicate.len() + 1);
            capture.push_str(&rendered[..target_end]);
            capture.push(' ');
            capture.push_str(&repaired.predicate);
            capture.push(' ');
            capture.push_str(rendered[target_end..].trim_start());
            return Ok(capture);
        }
    }
    Ok(rendered)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn union_is_accepted_as_read() {
        let sql = "select * from \"events\" where \"event_kind\" in ('1') union \
                   select * from \"events\" where \"event_kind\" in ('0')";
        assert!(matches!(analyze(sql).unwrap(), AnalyzedStatement::Read { .. }));
    }

    #[test]
    fn union_all_is_accepted_as_read() {
        let sql = "select * from \"events\" union all select * from \"events\"";
        assert!(matches!(analyze(sql).unwrap(), AnalyzedStatement::Read { .. }));
    }

    #[test]
    fn union_nested_and_parenthesized() {
        // nostream emits parenthesized operands with their own ORDER BY/LIMIT.
        let sql = "(select * from \"events\" where \"event_kind\" in ('1')) union \
                   (select * from \"events\" where \"event_kind\" in ('0') \
                    order by \"event_created_at\" desc limit 1) \
                   order by \"event_created_at\" desc limit 1";
        assert!(matches!(analyze(sql).unwrap(), AnalyzedStatement::Read { .. }));
    }

    #[test]
    fn union_with_distinct_and_join_branches() {
        let sql = "select distinct \"events\".* from \"events\" \
                   left join \"event_tags\" on \"events\".\"event_id\" = \"event_tags\".\"event_id\" \
                   where \"event_tags\".tag_name = 'e' union \
                   select * from \"events\" where \"event_kind\" in ('0')";
        assert!(matches!(analyze(sql).unwrap(), AnalyzedStatement::Read { .. }));
    }

    #[test]
    fn except_and_intersect_are_rejected() {
        let except = "select * from \"events\" except select * from \"events\"";
        let intersect = "select * from \"events\" intersect select * from \"events\"";
        assert!(analyze(except).is_err());
        assert!(analyze(intersect).is_err());
    }

    #[test]
    fn aggregates_inside_union_are_rejected() {
        let sql = "select count(*) from \"events\" union select count(*) from \"events\"";
        assert!(analyze(sql).is_err());
    }

    #[test]
    fn union_helpers_pick_first_branch() {
        let sql = "(select * from \"events\") union (select * from \"events\")";
        assert_eq!(read_table_name(sql).as_deref(), Some("events"));
        assert!(has_set_operation(sql));
        assert!(!has_join(sql));
        // `select *` on the first branch.
        assert!(matches!(select_projection(sql), Some(None)));
    }

    #[test]
    fn distinct_over_join_routes_to_read() {
        let sql = "select distinct \"events\".* from \"events\" \
                   left join \"event_tags\" on \"events\".\"event_id\" = \"event_tags\".\"event_id\" \
                   where \"event_tags\".tag_name = 'e'";
        assert!(matches!(analyze(sql).unwrap(), AnalyzedStatement::Read { .. }));
        assert!(has_join(sql));
        // `<table>.*` describes as the whole table, matching Execute's arity.
        assert!(matches!(select_projection(sql), Some(None)));
    }

    #[test]
    fn joinless_distinct_stays_aggregate() {
        let sql = "select distinct event_kind from \"events\"";
        assert!(matches!(analyze(sql).unwrap(), AnalyzedStatement::Aggregate { .. }));
    }

    #[test]
    fn plain_join_read_still_works() {
        let sql = "select \"events\".* from \"events\" \
                   left join \"event_tags\" on \"events\".\"event_id\" = \"event_tags\".\"event_id\" \
                   where \"event_tags\".tag_name = 'e' \
                   order by \"events\".\"event_created_at\" desc limit 2";
        assert!(matches!(analyze(sql).unwrap(), AnalyzedStatement::Read { .. }));
    }

    #[test]
    fn union_branch_without_select_is_rejected() {
        let sql = "select * from \"events\" union values (1, 2)";
        assert!(analyze(sql).is_err());
    }

    #[test]
    fn provider_read_sql_wraps_unions_only() {
        // A plain read is forwarded unchanged.
        let plain = "select * from \"events\" where \"event_kind\" in ('1')";
        assert_eq!(provider_read_sql(plain), plain);
        // A union is wrapped so it starts with SELECT (pg-agent requirement),
        // including when the original carries a trailing semicolon.
        let union = "(select * from \"events\") union (select * from \"events\");";
        let wrapped = provider_read_sql(union);
        assert!(wrapped.starts_with("select * from ("));
        assert!(wrapped.contains(") union ("));
        assert!(wrapped.ends_with(") as _mesh_union"));
        assert!(!wrapped.contains(';'));
    }
}
