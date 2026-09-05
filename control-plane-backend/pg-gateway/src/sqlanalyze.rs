//! Statement analysis: classifies incoming PG SQL, extracts the target table
//! and (for writes) the primary-key predicate. The gateway supports a small
//!, explicit subset; everything else is rejected with a clear error so we
//! never silently misroute. Statements inside the subset are forwarded to
//! providers verbatim.

use sqlparser::ast::{
    BinaryOperator, ColumnOption, DataType, Expr, GeneratedAs, ObjectName, Query, Statement,
    TableConstraint, TableFactor, Value,
};
use sqlparser::dialect::GenericDialect;
use sqlparser::keywords::Keyword;
use sqlparser::parser::Parser;
use sqlparser::tokenizer::Token;

use crate::error::{GatewayError, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatementKind {
    Create,
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
    },
    Read { sql: String },
}

/// Single supported primary-key column name.
pub const PK_COLUMN: &str = "id";

pub fn analyze(sql: &str) -> Result<AnalyzedStatement> {
    // sqlparser's GenericDialect accepts PostgreSQL syntax for everything in
    // our subset; statements are forwarded verbatim so dialect quirks never
    // change what a provider sees.
    let statements = Parser::parse_sql(&GenericDialect {}, sql)
        .map_err(|error| GatewayError::UnsupportedSql(normalize_parse_error(&error)))?;
    if statements.len() != 1 {
        return Err(GatewayError::UnsupportedSql(
            "exactly one statement per request is supported".to_string(),
        ));
    }
    match statements.into_iter().next().unwrap() {
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
            if insert.on.is_some() {
                return Err(GatewayError::UnsupportedSql(
                    "ON CONFLICT / DO NOTHING is not supported".to_string(),
                ));
            }
            let row = &rows[0];
            let pk_index = insert
                .columns
                .iter()
                .position(|ident| object_name_eq(ident, PK_COLUMN));
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
            Ok(AnalyzedStatement::Write {
                kind: StatementKind::Insert,
                table,
                row_id,
                sql: sql.to_string(),
                row_id_placeholder,
                generate_row_id,
                returning,
            })
        }
        Statement::Update(update) => {
            let table = extract_table_factor_name(&update.table.relation)?;
            match update.selection.as_ref() {
                Some(where_clause) => {
                    let row_id = extract_pk_equality(where_clause)?;
                    Ok(AnalyzedStatement::Write {
                        kind: StatementKind::Update,
                        table,
                        row_id,
                        sql: sql.to_string(),
                        row_id_placeholder: None,
                        generate_row_id: false,
                        returning: None,
                    })
                }
                None => Err(GatewayError::WriteRequiresPk(
                    "UPDATE requires WHERE <pk> = <literal>".to_string(),
                )),
            }
        }
        Statement::Delete(delete) => {
            let table = extract_delete_table(delete.from.clone())?;
            match delete.selection.as_ref() {
                Some(where_clause) => {
                    let row_id = extract_pk_equality(where_clause)?;
                    Ok(AnalyzedStatement::Write {
                        kind: StatementKind::Delete,
                        table,
                        row_id,
                        sql: sql.to_string(),
                        row_id_placeholder: None,
                        generate_row_id: false,
                        returning: None,
                    })
                }
                None => Err(GatewayError::WriteRequiresPk(
                    "DELETE requires WHERE <pk> = <literal>".to_string(),
                )),
            }
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
        other => Err(GatewayError::UnsupportedSql(format!(
            "statement of kind {} is not supported",
            describe_statement(&other)
        ))),
    }
}

fn analyze_select(query: Query, sql: &str) -> Result<AnalyzedStatement> {
    if query.with.is_some() || query.limit_clause.is_some() || query.fetch.is_some() || !query.locks.is_empty() {
        return Err(GatewayError::UnsupportedSql(
            "CTEs, window expressions and locking clauses are not supported".to_string(),
        ));
    }
    let body = match query.body.as_ref() {
        sqlparser::ast::SetExpr::Select(select) => select,
        _ => {
            return Err(GatewayError::UnsupportedSql(
                "plain SELECT is required (no UNION/VALUES on the read path)".to_string(),
            ))
        }
    };
    if body.distinct.is_some() || !matches!(body.group_by, sqlparser::ast::GroupByExpr::Expressions(ref items, _) if items.is_empty()) || body.having.is_some() {
        return Err(GatewayError::UnsupportedSql(
            "DISTINCT/GROUP BY/HAVING are not supported yet".to_string(),
        ));
    }
    if body.from.is_empty() {
        // SELECT without FROM (e.g. `SELECT 1`): constant, no providers.
        return Ok(AnalyzedStatement::Read { sql: sql.to_string() });
    }
    if body.from.len() != 1 || !body.from[0].joins.is_empty() {
        return Err(GatewayError::UnsupportedSql(
            "exactly one plain table (no JOINs) is supported".to_string(),
        ));
    }
    // Validate the projection so we can reject expressions the merge layer
    // cannot handle (star is fine, identifiers are fine, aggregates rejected).
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
            sqlparser::ast::SelectItem::QualifiedWildcard(_, _) => {
                return Err(GatewayError::UnsupportedSql(
                    "qualified wildcards are not supported".to_string(),
                ));
            }
        }
    }
    let _ = extract_table_factor_name(&body.from[0].relation)?;
    Ok(AnalyzedStatement::Read { sql: sql.to_string() })
}

fn expr_has_aggregate(expr: &Expr) -> bool {
    match expr {
        Expr::Function(function) => {
            let name = function
                .name
                .0
                .last()
                .and_then(|part| part.as_ident().map(|ident| ident.value.to_ascii_lowercase()));
            matches!(
                name.as_deref(),
                Some("count") | Some("sum") | Some("avg") | Some("min") | Some("max")
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
    if name.0.len() != 1 {
        return Err(GatewayError::UnsupportedSql(
            "qualified table names (schema.table) are not supported".to_string(),
        ));
    }
    let first = &name.0[0];
    let ident = first
        .as_ident()
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
fn extract_pk_equality(expr: &Expr) -> Result<String> {
    match expr {
        Expr::BinaryOp { left, op: BinaryOperator::And, right } => extract_pk_equality(left)
            .or_else(|_| extract_pk_equality(right)),
        Expr::BinaryOp { left, op: BinaryOperator::Eq, right } => {
            match (identifier_name(left), literal_to_string_expr(right)) {
                (Some(name), Some(value)) if name.eq_ignore_ascii_case(PK_COLUMN) => Ok(value),
                _ => match (identifier_name(right), literal_to_string_expr(left)) {
                    (Some(name), Some(value)) if name.eq_ignore_ascii_case(PK_COLUMN) => Ok(value),
                    _ => Err(GatewayError::WriteRequiresPk(format!(
                        "WHERE must constrain \"{PK_COLUMN}\" to a literal"
                    ))),
                },
            }
        }
        _ => Err(GatewayError::WriteRequiresPk(format!(
            "WHERE must constrain \"{PK_COLUMN}\" to a literal"
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
        Expr::Identifier(ident) => Some(ident.value.clone()),
        Expr::CompoundIdentifier(parts) => parts.last().map(|ident| ident.value.clone()),
        _ => None,
    }
}

pub fn value_to_string(value: &Value) -> Option<String> {
    match value {
        Value::SingleQuotedString(text) | Value::DoubleQuotedString(text) => Some(text.clone()),
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
pub fn is_additive_ddl(kind: &StatementKind, sql: &str) -> Result<bool> {
    let statements = Parser::parse_sql(&GenericDialect {}, sql)
        .map_err(|error| GatewayError::UnsupportedSql(normalize_parse_error(&error)))?;
    for statement in statements {
        match statement {
            Statement::AlterTable(alter) => {
                for operation in alter.operations {
                    match operation {
                        sqlparser::ast::AlterTableOperation::AddColumn { .. } => {}
                        _ => {
                            return Err(GatewayError::UnsupportedSql(
                                "only ADD COLUMN alterations are supported".to_string(),
                            ))
                        }
                    }
                }
            }
            Statement::CreateTable(_) => {
                debug_assert!(matches!(kind, StatementKind::Create));
            }
            Statement::Drop {
                object_type: sqlparser::ast::ObjectType::Table,
                ..
            } => {
                // DROP TABLE is allowed; it is destructive but explicit.
                return Ok(true);
            }
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
    let statements = Parser::parse_sql(&GenericDialect {}, sql)
        .map_err(|error| GatewayError::UnsupportedSql(normalize_parse_error(&error)))?;
    for statement in statements {
        if let Statement::Query(query) = statement {
            if let sqlparser::ast::SetExpr::Select(select) = query.body.as_ref() {
                if select.from.len() != 1 {
                    return Ok(None);
                }
                return Ok(match select.selection.as_ref() {
                    Some(where_clause) => extract_pk_equality(where_clause).ok(),
                    None => None,
                });
            }
        }
    }
    Ok(None)
}

/// Placeholder name (e.g. "$1") when a statement's WHERE constrains the pk
/// to a parameter marker instead of a literal.
pub fn pk_placeholder(sql: &str) -> Option<String> {
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
            if let Some(name) = placeholder_in_equality(&where_clause) {
                return Some(name);
            }
        }
    }
    None
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

/// Table name of a SELECT, when it is a plain single-table read.
pub fn read_table_name(sql: &str) -> Option<String> {
    let statements = Parser::parse_sql(&GenericDialect {}, sql).ok()?;
    for statement in statements {
        if let Statement::Query(query) = statement {
            if let sqlparser::ast::SetExpr::Select(select) = query.body.as_ref() {
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

/// Full row payload for a single-tuple INSERT, as {column: value} JSON with
/// values wire-serialized as strings (gateway serves them back as TEXT).
pub fn insert_row_payload(sql: &str) -> Result<serde_json::Value> {
    let statements = Parser::parse_sql(&GenericDialect {}, sql)
        .map_err(|error| GatewayError::UnsupportedSql(normalize_parse_error(&error)))?;
    for statement in statements {
        if let Statement::Insert(insert) = statement {
            let source = insert
                .source
                .ok_or_else(|| GatewayError::UnsupportedSql("INSERT ... VALUES is required".to_string()))?;
            let rows = match source.body.as_ref() {
                sqlparser::ast::SetExpr::Values(values) => &values.rows,
                _ => {
                    return Err(GatewayError::UnsupportedSql(
                        "INSERT with plain VALUES is required".to_string(),
                    ))
                }
            };
            let row = &rows[0];
            let mut payload = serde_json::Map::new();
            if insert.columns.is_empty() {
                for (index, value) in row.iter().enumerate() {
                    payload.insert(format!("col{index}"), json_value(value));
                }
            } else {
                for (index, name) in insert.columns.iter().enumerate() {
                    let value = row
                        .get(index)
                        .ok_or_else(|| GatewayError::UnsupportedSql("INSERT tuple width mismatch".to_string()))?;
                    payload.insert(object_name_string(name), json_value(value));
                }
            }
            return Ok(serde_json::Value::Object(payload));
        }
    }
    Err(GatewayError::UnsupportedSql("could not re-parse INSERT".to_string()))
}

fn object_name_string(name: &ObjectName) -> String {
    name.0
        .last()
        .and_then(|part| part.as_ident().map(|ident| ident.value.clone()))
        .unwrap_or_default()
}

fn json_value(expr: &Expr) -> serde_json::Value {
    match expr {
        Expr::Value(vws) => match &vws.value {
            Value::Null => serde_json::Value::Null,
            Value::Boolean(flag) => serde_json::Value::Bool(*flag),
            Value::Number(number, _) => {
                serde_json::Value::Number(number.parse().unwrap_or(serde_json::Number::from(0)))
            }
            Value::SingleQuotedString(text) | Value::DoubleQuotedString(text) => {
                serde_json::Value::String(text.clone())
            }
            other => serde_json::Value::String(other.to_string()),
        },
        _ => serde_json::Value::String(expr.to_string()),
    }
}
