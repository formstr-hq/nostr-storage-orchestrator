//! Map-reduce aggregation over exclusive data nodes.
//!
//! Each provider holds an exclusive slice of a table, so every aggregate can
//! be computed per-provider (map) and combined here (reduce). The gateway
//! pushes the aggregate down: every provider runs the GROUP BY/aggregate over
//! its exclusive slice and returns partial rows; the gateway merges:
//!
//! - `count(*)/count(x)` -> sum of per-node counts
//! - `sum(x)`            -> sum of partial sums
//! - `avg(x)`            -> weighted mean of partial (sum, count) pairs
//! - `min(x)`/`max(x)`   -> min/max over partial minima/maxima
//! - `count(distinct x)` -> union of per-node distinct value sets (exact)
//! - `bool_and/or`,`every` -> fold over partial booleans
//! - `stddev*`/`var*`    -> combine (n, mean, sum-of-squares) partials
//! - `string_agg`/`array_agg`/`json*agg` -> concatenation (unordered)
//!
//! GROUP BY keys are evaluated on providers; the gateway merges by key tuple.
//! DISTINCT SELECT (no aggregates) collapses merged rows by their tuple.
//! HAVING filters merged rows; ORDER BY/LIMIT/OFFSET apply post-merge.

use crate::error::{GatewayError, Result};
use serde_json::Value;
use std::collections::HashMap;
use sqlparser::ast::{
    Distinct, Expr, FunctionArg, FunctionArgExpr, GroupByExpr, OrderBy, OrderByKind, Query,
    SelectItem, SetExpr, Statement, TableFactor,
};
use sqlparser::dialect::GenericDialect;
use sqlparser::parser::Parser;

#[derive(Debug, Clone, PartialEq)]
pub enum AggregateKind {
    Count,
    CountDistinct,
    Sum,
    Avg,
    Min,
    Max,
    BoolAnd,
    BoolOr,
    Variance { sample: bool },
    StdDev { sample: bool },
    StringAgg,
    ArrayAgg,
    JsonAgg,
}

#[derive(Debug, Clone)]
pub struct AggregateSpec {
    pub kind: AggregateKind,
    /// Raw argument expression text (e.g. `event_kind`, `*`).
    pub arg: String,
    /// Output name: the alias when given, else the bare function name
    /// (mirroring Postgres's unaliased aggregate column naming).
    pub output: String,
    /// Original expression text as written (e.g. `count(*)`) — used to map
    /// HAVING/ORDER BY references onto the output name.
    pub original: String,
}

/// A plan for a distributed aggregate query.
#[derive(Debug, Clone)]
pub struct AggregatePlan {
    /// Base table (no schema qualifier).
    pub table: String,
    /// WHERE text (verbatim, may be empty).
    pub filter: String,
    /// GROUP BY key expression texts.
    pub group_keys: Vec<String>,
    /// The aggregates to compute per node.
    pub aggregates: Vec<AggregateSpec>,
    /// Plain (non-aggregate) projected items: (group key text, output name).
    pub plain_columns: Vec<(String, String)>,
    /// SELECT DISTINCT rows (no aggregates): projected column texts in order.
    pub distinct_only: Option<Vec<(String, String)>>,
    /// HAVING predicate text (applied post-merge), empty = none.
    pub having: String,
    /// ORDER BY items (output name, desc) applied post-merge.
    pub order_by: Vec<(String, bool)>,
    /// LIMIT applied post-merge.
    pub limit: Option<u64>,
    /// OFFSET applied post-merge.
    pub offset: Option<u64>,
}

/// Parses a SELECT with aggregates/DISTINCT/GROUP BY into a distributed plan.
/// Returns Err when the query uses unsupported shapes — callers surface the
/// rejection to the client.
pub fn plan_aggregate(sql: &str) -> Result<AggregatePlan> {
    let statements = Parser::parse_sql(&GenericDialect {}, sql)
        .map_err(|error| GatewayError::UnsupportedSql(error.to_string()))?;
    let Some(Statement::Query(query)) = statements.into_iter().next() else {
        return Err(GatewayError::UnsupportedSql("expected SELECT".to_string()));
    };
    plan_query(&query)
}

fn plan_query(query: &Query) -> Result<AggregatePlan> {
    if query.with.is_some() || query.fetch.is_some() || !query.locks.is_empty() {
        return Err(GatewayError::UnsupportedSql("CTEs/windows/locking unsupported".to_string()));
    }
    let SetExpr::Select(select) = query.body.as_ref() else {
        return Err(GatewayError::UnsupportedSql("plain SELECT required".to_string()));
    };
    if select.from.len() != 1 {
        return Err(GatewayError::UnsupportedSql("single FROM required".to_string()));
    }
    let table = match &select.from[0].relation {
        TableFactor::Table { name, .. } => name
            .0
            .last()
            .and_then(|part| part.as_ident())
            .map(|ident| ident.value.clone())
            .ok_or_else(|| GatewayError::UnsupportedSql("table expected".to_string()))?,
        _ => {
            return Err(GatewayError::UnsupportedSql(
                "aggregates over subqueries/derived tables are not supported".to_string(),
            ))
        }
    };
    if !select.from[0].joins.is_empty() {
        return Err(GatewayError::UnsupportedSql(
            "aggregates over joins are not supported yet".to_string(),
        ));
    }
    let filter = select
        .selection
        .as_ref()
        .map(|expr| expr.to_string())
        .unwrap_or_default();
    let group_keys: Vec<String> = match &select.group_by {
        GroupByExpr::Expressions(items, _) => items.iter().map(|e| e.to_string()).collect(),
        GroupByExpr::All(_) => {
            return Err(GatewayError::UnsupportedSql("GROUP BY ALL not supported".to_string()))
        }
    };
    let having = select
        .having
        .as_ref()
        .map(|e| e.to_string())
        .unwrap_or_default();
    let distinct_all = matches!(select.distinct.as_ref(), Some(Distinct::Distinct));

    let mut aggregates: Vec<AggregateSpec> = Vec::new();
    let mut plain_columns: Vec<(String, String)> = Vec::new();
    let mut distinct_items: Vec<(String, String)> = Vec::new();
    let mut has_aggregate = false;

    for item in &select.projection {
        match item {
            SelectItem::Wildcard(_) | SelectItem::QualifiedWildcard(_, _) => {
                return Err(GatewayError::UnsupportedSql(
                    "wildcard projection cannot be aggregated".to_string(),
                ))
            }
            SelectItem::ExprWithAliases { .. } => {
                return Err(GatewayError::UnsupportedSql("multi-alias projection unsupported".to_string()))
            }
            SelectItem::UnnamedExpr(expr) => {
                classify_expr(
                    expr,
                    &group_keys,
                    &mut aggregates,
                    &mut plain_columns,
                    &mut has_aggregate,
                    &mut distinct_items,
                    None,
                )?;
            }
            SelectItem::ExprWithAlias { expr, alias } => {
                let alias = alias.value.clone();
                let before = aggregates.len();
                classify_expr(
                    expr,
                    &group_keys,
                    &mut aggregates,
                    &mut plain_columns,
                    &mut has_aggregate,
                    &mut distinct_items,
                    Some(alias.clone()),
                )?;
                if aggregates.len() > before {
                    aggregates.last_mut().unwrap().output = alias.clone();
                }
            }
        }
    }

    let (order_by, limit, offset) = parse_order_limit(query.order_by.as_ref(), &query.limit_clause);

    if !has_aggregate {
        if distinct_all {
            if distinct_items.is_empty() {
                return Err(GatewayError::UnsupportedSql("empty distinct projection".to_string()));
            }
            return Ok(AggregatePlan {
                table,
                filter,
                group_keys: vec![],
                aggregates: vec![],
                plain_columns: vec![],
                distinct_only: Some(distinct_items),
                having,
                order_by,
                limit,
                offset,
            });
        }
        return Err(GatewayError::UnsupportedSql("not an aggregate query".to_string()));
    }

    // Every projected plain column must be grouped (Postgres semantics).
    for (expr, _alias) in &plain_columns {
        if !group_keys.iter().any(|k| k.eq_ignore_ascii_case(expr)) {
            return Err(GatewayError::UnsupportedSql(format!(
                "column {expr} must appear in GROUP BY"
            )));
        }
    }
    // GROUP BY keys must be plain (possibly qualified) columns so providers
    // can project them; expressions like substr(x,1,2) are rejected.
    for key in &group_keys {
        if !is_plain_column(key) {
            return Err(GatewayError::UnsupportedSql(format!(
                "GROUP BY expression {key} must be a plain column"
            )));
        }
    }
    // ORDER BY may reference aggregates by their expression text
    // (ORDER BY count(*) DESC): map those texts to the output names.
    let order_by = order_by
        .into_iter()
        .map(|(name, desc)| {
            let mapped = aggregates
                .iter()
                .find(|spec| spec.original.eq_ignore_ascii_case(&name))
                .map(|spec| spec.output.clone())
                .unwrap_or(name);
            (mapped, desc)
        })
        .collect::<Vec<_>>();
    // ORDER BY must reference projected outputs only.
    let outputs: Vec<String> = plan_outputs(&plain_columns, &group_keys, &aggregates);
    for (name, _) in &order_by {
        if !outputs.iter().any(|o| o.eq_ignore_ascii_case(name)) {
            return Err(GatewayError::UnsupportedSql(format!(
                "ORDER BY {name} must reference a projected output"
            )));
        }
    }

    // HAVING references aggregates by expression text too; rewrite them onto
    // output names so the post-merge evaluator can find them in result rows.
    let having = if having.is_empty() {
        having
    } else {
        let mut text = having;
        for spec in &aggregates {
            text = rewrite_having_agg(&text, &spec.original, &spec.output);
        }
        text
    };

    Ok(AggregatePlan {
        table,
        filter,
        group_keys,
        aggregates,
        plain_columns,
        distinct_only: None,
        having,
        order_by,
        limit,
        offset,
    })
}

/// Replaces an aggregate expression reference inside HAVING with the output
/// name, case-insensitively and whitespace-tolerantly: `count(*)` matches
/// `COUNT( * )`, `count ( * )` etc.
fn rewrite_having_agg(having: &str, original: &str, output: &str) -> String {
    let normalized: String = original.split_whitespace().collect::<Vec<_>>().join("");
    let mut result = String::new();
    let lower = having.to_ascii_lowercase();
    let needle = normalized.to_ascii_lowercase();
    let mut i = 0usize;
    while i < lower.len() {
        if lower[i..].starts_with(&needle) {
            result.push_str(output);
            i += needle.len();
        } else {
            result.push_str(&having[i..i + 1]);
            i += 1;
        }
    }
    result
}

fn parse_order_limit(
    order_by: Option<&OrderBy>,
    limit_clause: &Option<sqlparser::ast::LimitClause>,
) -> (Vec<(String, bool)>, Option<u64>, Option<u64>) {
    let mut items: Vec<(String, bool)> = Vec::new();
    if let Some(order) = order_by {
        if let OrderByKind::Expressions(exprs) = &order.kind {
            for item in exprs {
                let text = item.expr.to_string();
                let desc = matches!(item.options.asc, Some(false));
                items.push((text, desc));
            }
        }
    }
    let (limit, offset) = match limit_clause {
        Some(sqlparser::ast::LimitClause::LimitOffset { limit, offset, .. }) => {
            (limit.as_ref().and_then(expr_as_u64), offset.as_ref().and_then(|o| expr_as_u64(&o.value)))
        }
        Some(sqlparser::ast::LimitClause::OffsetCommaLimit { offset, limit, .. }) => {
            (expr_as_u64(limit), expr_as_u64(offset))
        }
        None => (None, None),
    };
    (items, limit, offset)
}

fn plan_outputs(
    plain_columns: &[(String, String)],
    group_keys: &[String],
    aggregates: &[AggregateSpec],
) -> Vec<String> {
    let mut out: Vec<String> = plain_columns.iter().map(|(_, a)| a.clone()).collect();
    for key in group_keys {
        if !plain_columns.iter().any(|(e, _)| e.eq_ignore_ascii_case(key)) {
            out.push(key.clone());
        }
    }
    out.extend(aggregates.iter().map(|s| s.output.clone()));
    out
}

fn is_plain_column(text: &str) -> bool {
    let Ok(statements) = Parser::parse_sql(&GenericDialect {}, &format!("SELECT {text} FROM t")) else {
        return false;
    };
    let Some(Some(Statement::Query(query))) = statements.into_iter().next().map(Some) else {
        return false;
    };
    match query.body.as_ref() {
        SetExpr::Select(select) => matches!(
            select.projection.first(),
            Some(SelectItem::UnnamedExpr(Expr::Identifier(_)))
                | Some(SelectItem::UnnamedExpr(Expr::CompoundIdentifier(_)))
        ),
        _ => false,
    }
}

fn classify_expr(
    expr: &Expr,
    group_keys: &[String],
    aggregates: &mut Vec<AggregateSpec>,
    plain_columns: &mut Vec<(String, String)>,
    has_aggregate: &mut bool,
    distinct_items: &mut Vec<(String, String)>,
    alias: Option<String>,
) -> Result<()> {
    if let Expr::Function(function) = expr {
        let name = function
            .name
            .0
            .last()
            .and_then(|part| part.as_ident())
            .map(|ident| ident.value.to_ascii_lowercase())
            .ok_or_else(|| GatewayError::UnsupportedSql("function name expected".to_string()))?;
        let args = match &function.args {
            sqlparser::ast::FunctionArguments::List(list) => list.args.clone(),
            sqlparser::ast::FunctionArguments::None => vec![],
            sqlparser::ast::FunctionArguments::Subquery(_) => {
                return Err(GatewayError::UnsupportedSql("aggregate over subquery unsupported".to_string()))
            }
        };
        if function.filter.is_some() {
            return Err(GatewayError::UnsupportedSql("FILTER not supported yet".to_string()));
        }
        let is_distinct = match &function.args {
            sqlparser::ast::FunctionArguments::List(list) => {
                matches!(list.duplicate_treatment, Some(sqlparser::ast::DuplicateTreatment::Distinct))
            }
            _ => false,
        };
        let arg_text = match args.first() {
            Some(FunctionArg::Unnamed(FunctionArgExpr::Wildcard))
            | Some(FunctionArg::Named { arg: FunctionArgExpr::Wildcard, .. })
            | Some(FunctionArg::ExprNamed { arg: FunctionArgExpr::Wildcard, .. }) => "*".to_string(),
            Some(FunctionArg::Unnamed(FunctionArgExpr::Expr(e)))
            | Some(FunctionArg::Named { arg: FunctionArgExpr::Expr(e), .. })
            | Some(FunctionArg::ExprNamed { arg: FunctionArgExpr::Expr(e), .. }) => e.to_string(),
            Some(_) => {
                return Err(GatewayError::UnsupportedSql("unsupported aggregate argument".to_string()))
            }
            None => {
                if name == "count" {
                    "*".to_string()
                } else {
                    return Err(GatewayError::UnsupportedSql("aggregate needs an argument".to_string()));
                }
            }
        };
        let kind = match name.as_str() {
            "count" if is_distinct => AggregateKind::CountDistinct,
            "count" => AggregateKind::Count,
            "sum" => AggregateKind::Sum,
            "avg" | "mean" => AggregateKind::Avg,
            "min" => AggregateKind::Min,
            "max" => AggregateKind::Max,
            "bool_and" | "every" => AggregateKind::BoolAnd,
            "bool_or" | "any" => AggregateKind::BoolOr,
            "variance" | "var_samp" => AggregateKind::Variance { sample: true },
            "var_pop" => AggregateKind::Variance { sample: false },
            "stddev" | "stddev_samp" => AggregateKind::StdDev { sample: true },
            "stddev_pop" => AggregateKind::StdDev { sample: false },
            "string_agg" | "group_concat" => AggregateKind::StringAgg,
            "array_agg" => AggregateKind::ArrayAgg,
            "json_agg" | "jsonb_agg" => AggregateKind::JsonAgg,
            other => {
                return Err(GatewayError::UnsupportedSql(format!(
                    "aggregate {other} not supported"
                )))
            }
        };
        if kind == AggregateKind::CountDistinct && arg_text == "*" {
            return Err(GatewayError::UnsupportedSql(
                "count(distinct *) is not supported".to_string(),
            ));
        }
        // Ordered aggregates (string_agg ORDER BY) cannot preserve order.
        if let sqlparser::ast::FunctionArguments::List(list) = &function.args {
            if list
                .clauses
                .iter()
                .any(|c| matches!(c, sqlparser::ast::FunctionArgumentClause::OrderBy(_)))
            {
                return Err(GatewayError::UnsupportedSql(
                    "ORDER BY inside aggregates is not supported".to_string(),
                ));
            }
        }
        *has_aggregate = true;
        let original = expr.to_string();
        aggregates.push(AggregateSpec {
            kind,
            arg: arg_text,
            // Postgres names unaliased aggregates by their bare function name
            // ("count", "sum"...), which is also the most merge-friendly key.
            output: alias.unwrap_or_else(|| name.clone()),
            original,
        });
        return Ok(());
    }
    if expr_has_aggregate(expr) {
        return Err(GatewayError::UnsupportedSql(
            "aggregates inside expressions are not supported".to_string(),
        ));
    }
    // Plain column reference: must be a GROUP BY key.
    let (full, last) = match expr {
        Expr::Identifier(ident) => (ident.value.clone(), ident.value.clone()),
        Expr::CompoundIdentifier(parts) => {
            let full = parts.iter().map(|p| p.value.clone()).collect::<Vec<_>>().join(".");
            (full.clone(), parts.last().unwrap().value.clone())
        }
        other => {
            return Err(GatewayError::UnsupportedSql(format!(
                "projection expression {other} is not a column or aggregate"
            )))
        }
    };
    // No GROUP BY (SELECT DISTINCT): every column is its own dedup key.
    let matched = if group_keys.is_empty() {
        full.clone()
    } else {
        group_keys
            .iter()
            .find(|k| k.eq_ignore_ascii_case(&full) || k.eq_ignore_ascii_case(&last))
            .cloned()
            .ok_or_else(|| {
                GatewayError::UnsupportedSql(format!("column {full} must appear in GROUP BY"))
            })?
    };
    distinct_items.push((matched.clone(), alias.clone().unwrap_or_else(|| last.clone())));
    if !plain_columns.iter().any(|(e, _)| e.eq_ignore_ascii_case(&matched)) {
        plain_columns.push((matched, alias.unwrap_or(last)));
    }
    Ok(())
}

fn expr_as_u64(expr: &Expr) -> Option<u64> {
    if let Expr::Value(value) = expr {
        if let sqlparser::ast::Value::Number(n, _) = &value.value {
            return n.parse::<u64>().ok();
        }
    }
    None
}

pub fn expr_has_aggregate(expr: &Expr) -> bool {
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

impl AggregatePlan {
    /// The map-side query each provider runs: its own GROUP BY/aggregate over
    /// its exclusive slice. AVG and variance/stddev additionally request the
    /// count/sum partials the gateway needs for the combine step.
    pub fn partial_sql(&self) -> String {
        if let Some(items) = &self.distinct_only {
            let projections = items
                .iter()
                .map(|(expr, alias)| format!("{expr} AS \"{alias}\""))
                .collect::<Vec<_>>()
                .join(", ");
            let mut sql = format!("SELECT DISTINCT {projections} FROM {}", self.table);
            if !self.filter.is_empty() {
                sql.push_str(" WHERE ");
                sql.push_str(&self.filter);
            }
            return sql;
        }
        let mut projections: Vec<String> = Vec::new();
        for (expr, alias) in &self.plain_columns {
            projections.push(format!("{expr} AS \"{alias}\""));
        }
        for key in &self.group_keys {
            if !self.plain_columns.iter().any(|(e, _)| e.eq_ignore_ascii_case(key)) {
                projections.push(format!("{key} AS \"{key}\""));
            }
        }
        for spec in &self.aggregates {
            let arg = spec.arg.clone();
            match spec.kind {
                AggregateKind::Avg => {
                    let col = if arg == "*" { "*".to_string() } else { arg.clone() };
                    projections.push(format!("count({col}) AS \"__c_{}_{}\"", spec.output, spec.arg));
                    projections.push(format!("sum({arg}) AS \"__s_{}_{}\"", spec.output, spec.arg));
                }
                AggregateKind::Variance { .. } | AggregateKind::StdDev { .. } => {
                    projections.push(format!("count({arg}) AS \"__n_{}_{}\"", spec.output, spec.arg));
                    projections.push(format!("avg({arg}) AS \"__m_{}_{}\"", spec.output, spec.arg));
                    projections.push(format!("sum(({arg}) * ({arg})) AS \"__q_{}_{}\"", spec.output, spec.arg));
                }
                AggregateKind::CountDistinct => {
                    projections.push(format!("array_agg(DISTINCT {arg}) AS \"{}\"", spec.output));
                }
                _ => {
                    let star = if arg == "*" { "*" } else { &arg };
                    projections.push(format!(
                        "{}({star}) AS \"{}\"",
                        agg_name(&spec.kind),
                        spec.output
                    ));
                }
            }
        }
        let mut sql = format!("SELECT {} FROM {}", projections.join(", "), self.table);
        if !self.filter.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&self.filter);
        }
        if !self.group_keys.is_empty() {
            sql.push_str(" GROUP BY ");
            sql.push_str(&self.group_keys.join(", "));
        }
        sql
    }
}

/// Builds the partial SQL with `$N` params inlined. The plan was created from
/// already-inlined SQL, so this re-plans the inlined statement — params ride
/// in `sql` at plan time; this helper exists for the extended protocol path
/// where inlining happens right before execution.
pub fn plan_aggregate_inline(plan: &AggregatePlan, params: &[Option<String>]) -> Result<String> {
    let _ = params;
    // The plan's filter already carries inlined literals (the analyzer plans
    // from the fully-inlined SQL in execute_sql_bound). No extra work needed.
    Ok(plan.partial_sql())
}

fn agg_name(kind: &AggregateKind) -> &'static str {
    match kind {
        AggregateKind::Count | AggregateKind::CountDistinct => "count",
        AggregateKind::Sum => "sum",
        AggregateKind::Avg => "avg",
        AggregateKind::Min => "min",
        AggregateKind::Max => "max",
        AggregateKind::BoolAnd => "bool_and",
        AggregateKind::BoolOr => "bool_or",
        AggregateKind::Variance { .. } => "variance",
        AggregateKind::StdDev { .. } => "stddev",
        AggregateKind::StringAgg => "string_agg",
        AggregateKind::ArrayAgg => "array_agg",
        AggregateKind::JsonAgg => "json_agg",
    }
}

/// Running accumulator for one group during the reduce phase.
struct Acc {
    key: Vec<Value>,
    counts: HashMap<String, f64>,
    sums: HashMap<String, f64>,
    mins: HashMap<String, Value>,
    maxes: HashMap<String, Value>,
    bools_and: HashMap<String, bool>,
    bools_or: HashMap<String, bool>,
    distinct_sets: HashMap<String, Vec<Value>>,
    lists: HashMap<String, Vec<Value>>,
}

/// Merges per-provider partial rows into final result rows.
pub fn merge_partials(plan: &AggregatePlan, partials: &[Vec<Value>]) -> Vec<Value> {
    if let Some(items) = &plan.distinct_only {
        return merge_distinct(items, partials, &plan.order_by, plan.limit, plan.offset);
    }
    let mut groups: HashMap<String, Acc> = HashMap::new();

    for rows in partials {
        for row in rows {
            let key: Vec<Value> = plan
                .group_keys
                .iter()
                .chain(plan.plain_columns.iter().map(|(e, _)| e))
                .map(|k| {
                    row.get(k)
                        .cloned()
                        .or_else(|| row.get(&k.rsplit('.').next().unwrap_or(k)).cloned())
                        .unwrap_or(Value::Null)
                })
                .collect();
            let key_str = serde_json::to_string(&key).unwrap_or_default();
            let acc = groups.entry(key_str).or_insert_with(|| Acc {
                key,
                counts: HashMap::new(),
                sums: HashMap::new(),
                mins: HashMap::new(),
                maxes: HashMap::new(),
                bools_and: HashMap::new(),
                bools_or: HashMap::new(),
                distinct_sets: HashMap::new(),
                lists: HashMap::new(),
            });
            for spec in &plan.aggregates {
                // AVG/VARIANCE inputs ride on __-prefixed helper columns.
                match spec.kind {
                    AggregateKind::Avg => {
                        let count_col = &format!("__c_{}_{}", spec.output, spec.arg);
                        let sum_col = &format!("__s_{}_{}", spec.output, spec.arg);
                        if let Some(n) = value_of(row, count_col).as_ref().and_then(json_num) {
                            *acc.counts.entry(spec.output.clone()).or_insert(0.0) += n;
                        }
                        if let Some(n) = value_of(row, sum_col).as_ref().and_then(json_num) {
                            *acc.sums.entry(spec.output.clone()).or_insert(0.0) += n;
                        }
                    }
                    AggregateKind::Variance { .. } | AggregateKind::StdDev { .. } => {
                        let n_col = &format!("__n_{}_{}", spec.output, spec.arg);
                        let m_col = &format!("__m_{}_{}", spec.output, spec.arg);
                        let q_col = &format!("__q_{}_{}", spec.output, spec.arg);
                        let n_partial = value_of(row, n_col).as_ref().and_then(json_num).unwrap_or(0.0);
                        let m_partial = value_of(row, m_col).as_ref().and_then(json_num);
                        let q_partial = value_of(row, q_col).as_ref().and_then(json_num);
                        if n_partial > 0.0 {
                            if let Some(mean) = m_partial {
                                // Reconstruct the partial's sum and stash the
                                // sum-of-squares the gateway combines later.
                                *acc.sums.entry(format!("__sum_{}_{}", spec.output, spec.arg)).or_insert(0.0) +=
                                    mean * n_partial;
                                *acc.sums.entry(format!("__q_{}_{}", spec.output, spec.arg)).or_insert(0.0) +=
                                    q_partial.unwrap_or(0.0);
                                *acc.counts.entry(spec.output.clone()).or_insert(0.0) += n_partial;
                            }
                        }
                    }
                    AggregateKind::CountDistinct => {
                        if let Some(items) = value_of(row, &spec.output) {
                            if let Value::Array(array) = &items {
                                acc.distinct_sets
                                    .entry(spec.output.clone())
                                    .or_default()
                                    .extend(array.iter().cloned());
                            }
                        }
                    }
                    AggregateKind::StringAgg | AggregateKind::ArrayAgg | AggregateKind::JsonAgg => {
                        if let Some(v) = value_of(row, &spec.output) {
                            acc.lists.entry(spec.output.clone()).or_default().push(v);
                        }
                    }
                    AggregateKind::Count => {
                        if let Some(n) = value_of(row, &spec.output).as_ref().and_then(json_num) {
                            *acc.counts.entry(spec.output.clone()).or_insert(0.0) += n;
                        }
                    }
                    AggregateKind::Sum => {
                        if let Some(n) = value_of(row, &spec.output).as_ref().and_then(json_num) {
                            *acc.sums.entry(spec.output.clone()).or_insert(0.0) += n;
                        }
                    }
                    AggregateKind::Min => {
                        if let Some(v) = value_of(row, &spec.output) {
                            if v.is_null() {
                                continue;
                            }
                            match acc.mins.get(&spec.output) {
                                Some(current) if json_le(current, &v) => {}
                                _ => {
                                    acc.mins.insert(spec.output.clone(), v);
                                }
                            }
                        }
                    }
                    AggregateKind::Max => {
                        if let Some(v) = value_of(row, &spec.output) {
                            if v.is_null() {
                                continue;
                            }
                            match acc.maxes.get(&spec.output) {
                                Some(current) if json_ge(current, &v) => {}
                                _ => {
                                    acc.maxes.insert(spec.output.clone(), v);
                                }
                            }
                        }
                    }
                    AggregateKind::BoolAnd => {
                        if let Some(flag) = value_of(row, &spec.output).and_then(as_bool) {
                            acc.bools_and
                                .entry(spec.output.clone())
                                .and_modify(|b| *b &= flag)
                                .or_insert(flag);
                        }
                    }
                    AggregateKind::BoolOr => {
                        if let Some(flag) = value_of(row, &spec.output).and_then(as_bool) {
                            acc.bools_or
                                .entry(spec.output.clone())
                                .and_modify(|b| *b = *b || flag)
                                .or_insert(flag);
                        }
                    }
                }
            }
        }
    }

    let mut out: Vec<Value> = Vec::new();
    for acc in groups.into_values() {
        let mut object = serde_json::Map::new();
        // plain columns first (they lead the key), then bare group keys, then
        // aggregates — mirroring the output order of the original query.
        let mut idx = 0usize;
        for (_, alias) in &plan.plain_columns {
            if let Some(v) = acc.key.get(idx) {
                object.insert(alias.clone(), v.clone());
            }
            idx += 1;
        }
        for key in &plan.group_keys {
            if !plan.plain_columns.iter().any(|(e, _)| e.eq_ignore_ascii_case(key)) {
                if let Some(v) = acc.key.get(idx) {
                    object.insert(key.clone(), v.clone());
                }
                idx += 1;
            }
        }
        for spec in &plan.aggregates {
            object.insert(spec.output.clone(), reduce_one(spec, &acc));
        }
        out.push(Value::Object(object));
    }

    if !plan.having.is_empty() {
        out.retain(|row| having_passes(&plan.having, row));
    }
    if !plan.order_by.is_empty() {
        sort_rows(&mut out, &plan.order_by);
    }
    if let Some(offset) = plan.offset {
        if (out.len() as u64) > offset {
            out = out.split_off(offset as usize);
        } else {
            out.clear();
        }
    }
    if let Some(limit) = plan.limit {
        out.truncate(limit as usize);
    }
    out
}

fn value_of<'r>(row: &'r Value, name: &str) -> Option<Value> {
    row.as_object().and_then(|o| o.get(name)).cloned()
}

fn as_bool(value: Value) -> Option<bool> {
    match value {
        Value::Bool(flag) => Some(flag),
        Value::String(text) => match text.as_str() {
            "t" | "true" | "1" => Some(true),
            "f" | "false" | "0" => Some(false),
            _ => None,
        },
        Value::Number(flag) => Some(flag.as_f64().unwrap_or(0.0) != 0.0),
        _ => None,
    }
}

fn json_num(value: &Value) -> Option<f64> {
    // Providers serialize numeric columns as JSON strings (pg-agent returns
    // everything as text) — coerce numeric strings so count/sum merge works.
    match value {
        Value::Number(n) => n.as_f64(),
        Value::String(text) => text.parse::<f64>().ok(),
        _ => None,
    }
}

fn json_le(a: &Value, b: &Value) -> bool {
    if let (Some(x), Some(y)) = (json_num(a), json_num(b)) {
        return x <= y;
    }
    let sa = match a {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    };
    let sb = match b {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    };
    sa <= sb
}

fn json_ge(a: &Value, b: &Value) -> bool {
    if let (Some(x), Some(y)) = (json_num(a), json_num(b)) {
        return x >= y;
    }
    let sa = match a {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    };
    let sb = match b {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    };
    sa >= sb
}

fn num_or_null(sum: f64) -> Value {
    if sum.fract() == 0.0 && sum.abs() < 9.007_199_254_740_992e15 {
        Value::Number((sum as i64).into())
    } else {
        serde_json::Number::from_f64(sum).map(Value::Number).unwrap_or(Value::Null)
    }
}

fn reduce_one(spec: &AggregateSpec, acc: &Acc) -> Value {
    match spec.kind {
        AggregateKind::Count => match acc.counts.get(&spec.output) {
            Some(count) => Value::Number((*count as i64).into()),
            None => Value::Number(0.into()),
        },
        AggregateKind::Sum => match acc.sums.get(&spec.output) {
            Some(sum) => num_or_null(*sum),
            None => Value::Null,
        },
        AggregateKind::Avg => {
            let count = acc.counts.get(&spec.output).copied().unwrap_or(0.0);
            let sum = acc.sums.get(&spec.output).copied().unwrap_or(0.0);
            if count > 0.0 {
                Value::Number(serde_json::Number::from_f64(sum / count).unwrap_or(serde_json::Number::from(0)))
            } else {
                Value::Null
            }
        }
        AggregateKind::Min => acc.mins.get(&spec.output).cloned().unwrap_or(Value::Null),
        AggregateKind::Max => acc.maxes.get(&spec.output).cloned().unwrap_or(Value::Null),
        AggregateKind::BoolAnd => match acc.bools_and.get(&spec.output) {
            Some(flag) => Value::String(if *flag { "t".into() } else { "f".into() }),
            None => Value::Null,
        },
        AggregateKind::BoolOr => match acc.bools_or.get(&spec.output) {
            Some(flag) => Value::String(if *flag { "t".into() } else { "f".into() }),
            None => Value::Null,
        },
        AggregateKind::CountDistinct => {
            let set = acc.distinct_sets.get(&spec.output);
            match set {
                Some(items) => {
                    let unique: std::collections::HashSet<String> = items
                        .iter()
                        .map(|item| match item {
                            Value::String(text) => text.clone(),
                            other => other.to_string(),
                        })
                        .collect();
                    Value::Number((unique.len() as i64).into())
                }
                None => Value::Number(0.into()),
            }
        }
        AggregateKind::StringAgg => {
            let items = acc.lists.get(&spec.output);
            match items {
                Some(values) => {
                    let joined: Vec<String> = values
                        .iter()
                        .map(|v| v.as_str().map(|s| s.to_string()).unwrap_or_else(|| v.to_string()))
                        .collect();
                    Value::String(joined.join(","))
                }
                None => Value::Null,
            }
        }
        AggregateKind::ArrayAgg => match acc.lists.get(&spec.output) {
            Some(values) => Value::Array(values.clone()),
            None => Value::Null,
        },
        AggregateKind::JsonAgg => match acc.lists.get(&spec.output) {
            Some(values) => {
                // Each provider returned its own JSON array; concatenate.
                let mut flat: Vec<Value> = Vec::new();
                for value in values {
                    match value {
                        Value::Array(items) => flat.extend(items.iter().cloned()),
                        other => flat.push(other.clone()),
                    }
                }
                Value::Array(flat)
            }
            None => Value::Null,
        },
        AggregateKind::Variance { sample } | AggregateKind::StdDev { sample } => {
            let n = acc.counts.get(&spec.output).copied().unwrap_or(0.0);
            let sum = acc.sums.get(&format!("__sum_{}_{}", spec.output, spec.arg)).copied().unwrap_or(0.0);
            let sum_sq = acc.sums.get(&format!("__q_{}_{}", spec.output, spec.arg)).copied().unwrap_or(0.0);
            if n == 0.0 {
                return Value::Null;
            }
            let mean = sum / n;
            let m2 = sum_sq - n * mean * mean;
            // sample vs population denominators
            let denom = if sample { n - 1.0 } else { n };
            if denom <= 0.0 {
                return match spec.kind {
                    AggregateKind::Variance { .. } => Value::Null,
                    _ => Value::Null,
                };
            }
            let variance = (m2 / denom).max(0.0);
            match spec.kind {
                AggregateKind::StdDev { .. } => {
                    Value::Number(serde_json::Number::from_f64(variance.sqrt()).unwrap_or(serde_json::Number::from(0)))
                }
                _ => Value::Number(serde_json::Number::from_f64(variance).unwrap_or(serde_json::Number::from(0))),
            }
        }
    }
}

fn merge_distinct(
    items: &[(String, String)],
    partials: &[Vec<Value>],
    order_by: &[(String, bool)],
    limit: Option<u64>,
    offset: Option<u64>,
) -> Vec<Value> {
    use std::collections::HashSet;
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<Value> = Vec::new();
    for rows in partials {
        for row in rows {
            let key: Vec<Value> = items
                .iter()
                .map(|(expr, alias)| {
                    row.get(alias)
                        .or_else(|| row.get(expr))
                        .cloned()
                        .unwrap_or(Value::Null)
                })
                .collect();
            let key_str = serde_json::to_string(&key).unwrap_or_default();
            if seen.insert(key_str) {
                let mut object = serde_json::Map::new();
                for ((_, alias), value) in items.iter().zip(key) {
                    object.insert(alias.clone(), value);
                }
                out.push(Value::Object(object));
            }
        }
    }
    if !order_by.is_empty() {
        sort_rows(&mut out, order_by);
    }
    if let Some(offset) = offset {
        if (out.len() as u64) > offset {
            out = out.split_off(offset as usize);
        } else {
            out.clear();
        }
    }
    if let Some(limit) = limit {
        out.truncate(limit as usize);
    }
    out
}

/// Naive HAVING evaluator: supports `<agg-alias> <op> <number>` and
/// `<agg-alias> <op> <literal>` comparisons combined with AND/OR, where the
/// alias is the projection output name (e.g. `count(*)` appears as `count(*)`
/// only when unaliased — the gateway canonicalizes unaliased aggregates to
/// their expression text, so HAVING references the same text).
fn having_passes(having: &str, row: &Value) -> bool {
    // Split on top-level AND/OR (left-to-right, AND binds tighter).
    let Some(object) = row.as_object() else { return true };
    // Build the searchable set of outputs.
    let evaluate_side = |side: &str| -> Option<f64> {
        let side = side.trim();
        // Direct output name?
        for (name, value) in object {
            if name.eq_ignore_ascii_case(side) {
                return json_num(value).or_else(|| as_bool(value.clone()).map(|b| b as i32 as f64));
            }
        }
        None
    };
    // Tokenize comparisons: <left> <op> <right>
    let compare = |text: &str| -> bool {
        let ops = [">=", "<=", "!=", "<>", "=", ">", "<"];
        for op in ops {
            if let Some(pos) = text.find(op) {
                let (left, right) = text.split_at(pos);
                let right = &right[op.len()..];
                let l = match evaluate_side(left) {
                    Some(v) => v,
                    None => return false,
                };
                let r_raw = right.trim().trim_matches('\'').trim_matches('"');
                let r = r_raw.parse::<f64>().unwrap_or_else(|_| {
                    // string literal compare: map to numeric if possible
                    0.0
                });
                return match op {
                    ">=" => l >= r,
                    "<=" => l <= r,
                    "!=" | "<>" => l != r,
                    "=" => l == r,
                    ">" => l > r,
                    "<" => l < r,
                    _ => false,
                };
            }
        }
        false
    };
    // Split OR first (lowest precedence), then AND.
    let split_keyword = |text: &str, kw: &str| -> Vec<String> {
        let mut parts = Vec::new();
        let mut depth = 0i32;
        let mut current = String::new();
        let lower = text.to_ascii_lowercase();
        let bytes = text.as_bytes();
        let mut i = 0usize;
        while i < bytes.len() {
            if bytes[i] == b'(' {
                depth += 1;
            }
            if bytes[i] == b')' {
                depth -= 1;
            }
            if depth == 0 && lower[i..].starts_with(kw)
                && (i == 0 || !bytes[i - 1].is_ascii_alphanumeric())
                && (i + kw.len() >= bytes.len() || !bytes[i + kw.len()].is_ascii_alphanumeric())
            {
                parts.push(current.clone());
                current.clear();
                i += kw.len();
                continue;
            }
            current.push(text[i..i + 1].chars().next().unwrap_or('?'));
            i += 1;
        }
        parts.push(current);
        parts
    };
    let or_parts = split_keyword(having, " or ");
    if or_parts.len() > 1 {
        return or_parts.iter().any(|part| having_passes(part.trim(), row));
    }
    let and_parts = split_keyword(having, " and ");
    if and_parts.len() > 1 {
        return and_parts.iter().all(|part| having_passes(part.trim(), row));
    }
    compare(having.trim().trim_start_matches('(').trim_end_matches(')'))
}

fn sort_rows(rows: &mut [Value], order_by: &[(String, bool)]) {
    rows.sort_by(|a, b| {
        for (name, desc) in order_by {
            let av = a.get(name).unwrap_or(&Value::Null);
            let bv = b.get(name).unwrap_or(&Value::Null);
            let cmp = match (json_num(av), json_num(bv)) {
                (Some(x), Some(y)) => x.partial_cmp(&y).unwrap_or(std::cmp::Ordering::Equal),
                _ => {
                    let as_ = av.as_str().or_else(|| av.as_str());
                    let bs = bv.as_str().or_else(|| bv.as_str());
                    match (as_, bs) {
                        (Some(x), Some(y)) => x.cmp(y),
                        _ => std::cmp::Ordering::Equal,
                    }
                }
            };
            let cmp = if *desc { cmp.reverse() } else { cmp };
            if cmp != std::cmp::Ordering::Equal {
                return cmp;
            }
        }
        std::cmp::Ordering::Equal
    });
}
#[cfg(test)]
mod tests {
    use super::*;

    fn rows(json: &str) -> Vec<Vec<Value>> {
        serde_json::from_str(json).expect("rows json")
    }

    #[test]
    fn count_no_group() {
        let plan = plan_aggregate("SELECT count(*) FROM events").unwrap();
        assert_eq!(plan.aggregates.len(), 1);
        assert_eq!(plan.aggregates[0].kind, AggregateKind::Count);
        let partial = plan.partial_sql();
        assert!(partial.contains("count(*)"));
        assert!(!partial.contains("GROUP BY"));
        // Providers encode numerics as strings (pg-agent bigint serialization).
        let partials = rows(r#"[[{"count": "10"}], [{"count": "5"}]]"#);
        let merged = merge_partials(&plan, &partials);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0]["count"], serde_json::json!(15));
    }

    #[test]
    fn count_group_by() {
        let plan = plan_aggregate("SELECT event_kind, count(*) FROM events GROUP BY event_kind").unwrap();
        let partial = plan.partial_sql();
        assert!(partial.contains("GROUP BY event_kind"));
        let partials = rows(r#"[
            [{"event_kind": "1", "count": 3}, {"event_kind": "2", "count": 1}],
            [{"event_kind": "1", "count": 2}]
        ]"#);
        let merged = merge_partials(&plan, &partials);
        assert_eq!(merged.len(), 2);
        let kind1 = merged.iter().find(|r| r["event_kind"] == "1").unwrap();
        assert_eq!(kind1["count"], serde_json::json!(5));
    }

    #[test]
    fn sum_avg_min_max() {
        let plan = plan_aggregate("SELECT sum(v), avg(v), min(v), max(v) FROM t").unwrap();
        let partial = plan.partial_sql();
        assert!(partial.contains("__c_avg_v"));
        assert!(partial.contains("__s_avg_v"));
        let partials = rows(r#"[
            [{"sum": 10, "__c_avg_v": 4, "__s_avg_v": 10, "min": 1, "max": 4}],
            [{"sum": 6, "__c_avg_v": 2, "__s_avg_v": 6, "min": 2, "max": 5}]
        ]"#);
        let merged = merge_partials(&plan, &partials);
        assert_eq!(merged[0]["sum"], serde_json::json!(16));
        assert_eq!(merged[0]["avg"], serde_json::json!(16.0 / 6.0));
        assert_eq!(merged[0]["min"], serde_json::json!(1));
        assert_eq!(merged[0]["max"], serde_json::json!(5));
    }

    #[test]
    fn count_distinct_union() {
        let plan = plan_aggregate("SELECT count(distinct event_pubkey) FROM events").unwrap();
        assert_eq!(plan.aggregates[0].kind, AggregateKind::CountDistinct);
        assert!(plan.partial_sql().contains("array_agg(DISTINCT"));
        let partials = rows(r#"[
            [{"count": ["a", "b"]}],
            [{"count": ["b", "c"]}]
        ]"#);
        let merged = merge_partials(&plan, &partials);
        assert_eq!(merged[0]["count"], serde_json::json!(3));
    }

    #[test]
    fn distinct_select() {
        let plan = plan_aggregate("SELECT DISTINCT event_kind FROM events").unwrap();
        assert!(plan.distinct_only.is_some());
        let partials = rows(r#"[
            [{"event_kind": "1"}, {"event_kind": "2"}],
            [{"event_kind": "1"}, {"event_kind": "3"}]
        ]"#);
        let merged = merge_partials(&plan, &partials);
        assert_eq!(merged.len(), 3);
    }

    #[test]
    fn order_limit() {
        let plan = plan_aggregate(
            "SELECT event_kind, count(*) FROM events GROUP BY event_kind ORDER BY count(*) DESC LIMIT 2",
        )
        .unwrap();
        assert_eq!(plan.order_by, vec![("count".to_string(), true)]);
        let partials = rows(r#"[
            [{"event_kind": "1", "count": 3}],
            [{"event_kind": "2", "count": 8}],
            [{"event_kind": "3", "count": 5}]
        ]"#);
        let merged = merge_partials(&plan, &partials);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0]["event_kind"], serde_json::json!("2"));
        assert_eq!(merged[1]["event_kind"], serde_json::json!("3"));
    }

    #[test]
    fn having_filter() {
        let plan = plan_aggregate(
            "SELECT event_kind, count(*) FROM events GROUP BY event_kind HAVING count(*) > 4",
        )
        .unwrap();
        let partials = rows(r#"[
            [{"event_kind": "1", "count": 3}],
            [{"event_kind": "2", "count": 8}]
        ]"#);
        let merged = merge_partials(&plan, &partials);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0]["event_kind"], serde_json::json!("2"));
    }

    #[test]
    fn rejects_unsupported() {
        assert!(plan_aggregate("SELECT count(*), event_kind FROM events").is_err());
        assert!(plan_aggregate("SELECT substr(event_kind, 1, 2), count(*) FROM events GROUP BY substr(event_kind, 1, 2)").is_err());
        assert!(plan_aggregate("SELECT * FROM events GROUP BY id").is_err());
    }

    #[test]
    fn variance_combine() {
        let plan = plan_aggregate("SELECT variance(v) FROM t").unwrap();
        let partial = plan.partial_sql();
        assert!(partial.contains("__n_variance_v"));
        assert!(partial.contains("__m_variance_v"));
        assert!(partial.contains("__q_variance_v"));
        // data [1,2,3,4] => sample variance (PG `variance`) = 5/3 ≈ 1.667
        let partials = rows(r#"[
            [{"__n_variance_v": 2, "__m_variance_v": 1.5, "__q_variance_v": 5.0}],
            [{"__n_variance_v": 2, "__m_variance_v": 3.5, "__q_variance_v": 25.0}]
        ]"#);
        let merged = merge_partials(&plan, &partials);
        let v = merged[0]["variance"].as_f64().unwrap();
        assert!((v - 5.0 / 3.0).abs() < 1e-9, "variance {v}");
    }
}
