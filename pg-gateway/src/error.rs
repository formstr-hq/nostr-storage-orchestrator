use thiserror::Error as ThisError;

#[derive(Debug, ThisError)]
pub enum GatewayError {
    #[error("unsupported SQL: {0}")]
    UnsupportedSql(String),

    #[error("unknown table: {0}")]
    UnknownTable(String),

    #[error("writes require a primary-key equality predicate: {0}")]
    WriteRequiresPk(String),

    #[error("central store error: {0}")]
    Central(String),

    #[error("provider error: {0}")]
    Provider(String),

    #[error("no healthy providers available")]
    NoProviders,
}

impl GatewayError {
    pub fn central(message: impl Into<String>) -> Self {
        Self::Central(message.into())
    }

    pub fn provider(message: impl Into<String>) -> Self {
        Self::Provider(message.into())
    }

    /// Human-friendly PG-style error text for the wire.
    pub fn to_wire_message(&self) -> String {
        match self {
            Self::UnsupportedSql(message) => {
                format!("unsupported SQL statement: {message}")
            }
            Self::UnknownTable(name) => format!("relation \"{name}\" does not exist"),
            Self::WriteRequiresPk(message) => message.clone(),
            Self::Central(message) => format!("gateway internal error: {message}"),
            Self::Provider(message) => format!("gateway storage error: {message}"),
            Self::NoProviders => "no healthy mesh-PG providers are available".to_string(),
        }
    }
}

pub type Result<T> = std::result::Result<T, GatewayError>;