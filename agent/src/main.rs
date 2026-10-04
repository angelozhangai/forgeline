fn main() {
    std::process::exit(forgeline_agent::cli::main(
        std::env::args().skip(1).collect(),
    ));
}
