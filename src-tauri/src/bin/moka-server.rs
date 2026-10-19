use std::{net::IpAddr, path::PathBuf};

use anyhow::Result;
use clap::Parser;
use moka_canvas::config::{load_config_file, validate_startup, RuntimeMode};
use moka_canvas::metadata::crypto;
use moka_canvas::server::{listen_address, LocalServer};

#[derive(Parser)]
#[command(name = "moka-server", about = "Serve Moka Canvas over localhost")]
struct Args {
    /// YAML configuration file. Relative paths inside it resolve against the
    /// current working directory. Without this flag, `config/moka.yaml` is read
    /// if it is there and every value stays at its default if it is not; a path
    /// named here has to exist.
    #[arg(long)]
    config: Option<PathBuf>,
    /// Overrides server.staticDir from the configuration file.
    #[arg(long)]
    static_dir: Option<PathBuf>,
    /// Overrides metadata.dir from the configuration file. Model
    /// configurations, credentials and preferences live here; a worktree names
    /// a directory of its own so two servers can run side by side.
    /// MOKA_METADATA_DIR in the environment still wins.
    #[arg(long)]
    metadata_dir: Option<PathBuf>,
    /// Names the address part of server.bind; the port comes from the
    /// configuration file unless `--port` says otherwise. Written as the IP
    /// alone (`0.0.0.0`, `127.0.0.1`, `::1`), because an address that has to be
    /// looked up is not one this server binds.
    #[arg(long)]
    host: Option<IpAddr>,
    /// Overrides the port in server.bind from the configuration file.
    #[arg(long)]
    port: Option<u16>,
    /// Prints a fresh MOKA_METADATA_KEY value on stdout and exits without
    /// starting the server.
    #[arg(long)]
    generate_key: bool,
    /// Records every call that reaches a provider — the address, the headers, the
    /// prompt and the whole answer — for diagnosing an answer that arrived and
    /// was the wrong thing. Recordings always go to the `records` subdirectory
    /// of the platform application data directory, and credentials in them are
    /// always masked.
    ///
    /// This writes prompts to the disk. See docs/security.md.
    #[arg(long)]
    llm_debug: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    moka_canvas::telemetry::init();
    let args = Args::parse();
    if args.generate_key {
        // The value alone goes to stdout so that it can be captured
        // (`MOKA_METADATA_KEY=$(moka-server --generate-key)`); what to do with
        // it goes to stderr so a pipeline never swallows the instructions.
        let key = crypto::generate_encoded();
        eprintln!(
            "Export this before starting the server, and keep it with the backups \
of the metadata directory:\n\n  export MOKA_METADATA_KEY='{key}'\n\nWithout it \
the server stores a master key in <metadata.dir>/master.key instead, which \
anything able to read that directory can read."
        );
        println!("{key}");
        return Ok(());
    }
    // Settled before anything reads the configuration, so that the three sources
    // are read in one order: what was typed here beats what the environment says,
    // and what the environment says beats what the file says.
    if args.llm_debug {
        moka_canvas::generate::debug::from_cli();
    }
    // A file named on the command line has to be there; the one this program
    // picked for itself may be missing, and then every value stays at its
    // default. The difference is said out loud rather than left to be noticed in
    // an answer that looks like a configuration nobody wrote.
    let typed_config = args.config.is_some();
    let config_path = args
        .config
        .unwrap_or_else(|| PathBuf::from(moka_canvas::config::DEFAULT_CONFIG_PATH));
    let mut config = load_config_file(&config_path, typed_config)?;
    if !typed_config && !config_path.exists() {
        tracing::info!(
            "no configuration file at {}; every value is at its default",
            config_path.display()
        );
    }
    if let Some(static_dir) = args.static_dir {
        config.server.static_dir = static_dir;
    }
    if let Some(metadata_dir) = args.metadata_dir {
        config.metadata.dir = Some(metadata_dir);
    }
    // Folded before anything reads the address, and folded into the same
    // string the configuration file filled, so that the two names each beat
    // that file for their own part and nothing else changes when neither is
    // typed.
    if args.host.is_some() || args.port.is_some() {
        config.server.bind = listen_address(&config.server.bind, args.host, args.port)?.to_string();
    }
    let metadata_root = validate_startup(&config, RuntimeMode::Web, None)?;

    let server = LocalServer::start(config, RuntimeMode::Web, &metadata_root).await?;
    println!("Moka Canvas is available at {}", server.display_url());
    tokio::signal::ctrl_c().await?;
    server.shutdown();
    Ok(())
}
