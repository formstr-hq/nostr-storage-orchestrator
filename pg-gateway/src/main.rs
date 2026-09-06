fn main() {
    if let Err(error) = pg_gateway::run() {
        eprintln!("pg-gateway failed: {error}");
        std::process::exit(1);
    }
}