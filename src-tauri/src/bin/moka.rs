//! The `moka` command line: the same tools the interface's assistant uses,
//! addressed from a shell or another program.
//!
//! It is a client and nothing more. Discovery finds a running local server; a
//! project is named with `--project`; a tool call is the same HTTP route the
//! interface calls. The exit code says what happened: 0 done, 1 refused by the
//! server, 2 a bad invocation, 3 the server could not be reached.

use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::time::Duration;

use clap::{Parser, Subcommand};
use moka_canvas::metadata::paths;
use reqwest::{Method, StatusCode};
use serde_json::{json, Value};

const DEFAULT_SERVER: &str = "http://127.0.0.1:3000";

#[derive(Parser)]
#[command(
    name = "moka",
    version,
    about = "Operate a local Moka Canvas project",
    long_about = "Talks to a running Moka Canvas server. Every command is a typed tool call; use --json for machine-readable output."
)]
struct Cli {
    /// Server address. Falls back to MOKA_SERVER, then the metadata directory's
    /// runtime note, then http://127.0.0.1:3000.
    #[arg(long, global = true)]
    server: Option<String>,
    /// Project directory, project id, or .moka package. The server's current
    /// project is used when this is absent.
    #[arg(long, global = true)]
    project: Option<String>,
    /// Print the server's JSON as it answered.
    #[arg(long, global = true)]
    json: bool,
    /// Confirm spend, destroy, and export tools. Without it those tools are
    /// refused by the server.
    #[arg(long, global = true)]
    yes: bool,
    /// Print details and the request id when a call fails.
    #[arg(long, global = true)]
    verbose: bool,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Find the running server and say where it is.
    Doctor,
    /// The tool catalog.
    Tools {
        #[command(subcommand)]
        command: ToolsCommand,
    },
    /// Tasks started by tools.
    Tasks {
        #[command(subcommand)]
        command: TasksCommand,
    },
    /// Conversations kept beside the project.
    Sessions {
        #[command(subcommand)]
        command: SessionsCommand,
    },
    /// Document change sets recorded by command tools.
    Changes {
        #[command(subcommand)]
        command: ChangesCommand,
    },
    /// Effect audit records. These cannot be undone.
    Audit {
        #[command(subcommand)]
        command: AuditCommand,
    },
    /// Project lifecycle. These are external-only tools.
    Projects {
        #[command(subcommand)]
        command: ProjectsCommand,
    },
    /// Serve the external tools over MCP on stdin/stdout.
    Mcp {
        #[command(subcommand)]
        command: McpCommand,
    },
}

#[derive(Subcommand)]
enum ToolsCommand {
    /// List tools, optionally filtered by pack or surface.
    List {
        #[arg(long)]
        pack: Option<String>,
        #[arg(long, default_value = "external")]
        surface: String,
    },
    /// Describe one tool's full contract.
    Describe { name: String },
    /// Call a tool.
    Call {
        name: String,
        /// A JSON object, `@file` holding one, or `-` for stdin.
        #[arg(long)]
        input: Option<String>,
        /// Plan a command without writing the document.
        #[arg(long)]
        dry_run: bool,
        /// Poll a started task for this many seconds before returning.
        #[arg(long, default_value_t = 0)]
        wait: u64,
    },
}

#[derive(Subcommand)]
enum TasksCommand {
    Get { kind: String, id: String },
    Cancel { kind: String, id: String },
}

#[derive(Subcommand)]
enum SessionsCommand {
    List {
        #[arg(long)]
        q: Option<String>,
        #[arg(long, default_value_t = 20)]
        limit: usize,
    },
    Show {
        id: String,
        #[arg(long, default_value_t = 100)]
        limit: usize,
    },
    Rename {
        id: String,
        title: String,
    },
    Delete {
        id: String,
        #[arg(long)]
        yes: bool,
    },
}

#[derive(Subcommand)]
enum ChangesCommand {
    List {
        #[arg(long, default_value_t = 50)]
        limit: usize,
    },
    Undo {
        id: String,
    },
}

#[derive(Subcommand)]
enum AuditCommand {
    List {
        #[arg(long, default_value_t = 50)]
        limit: usize,
    },
}

#[derive(Subcommand)]
enum ProjectsCommand {
    Current,
    Open {
        path: String,
    },
    Create {
        #[arg(long)]
        directory: String,
        #[arg(long)]
        name: String,
        #[arg(long)]
        subdirectory: bool,
    },
    Import {
        archive: String,
        #[arg(long)]
        directory: String,
        #[arg(long)]
        name: Option<String>,
    },
    Recent,
    RemoveRecent {
        id: String,
    },
}

#[derive(Subcommand)]
enum McpCommand {
    Serve {
        #[arg(long)]
        allow_write: bool,
        #[arg(long)]
        allow_spend: bool,
        #[arg(long)]
        allow_destructive: bool,
        #[arg(long)]
        allow_export: bool,
    },
}

#[derive(Debug)]
enum CliError {
    Usage(String),
    Transport(String),
    Refused {
        code: String,
        message: String,
        status: u16,
    },
}

impl CliError {
    fn exit_code(&self) -> i32 {
        match self {
            Self::Usage(_) => 2,
            Self::Transport(_) => 3,
            Self::Refused { .. } => 1,
        }
    }

    fn describe(&self) -> String {
        match self {
            Self::Usage(message) => format!("usage: {message}"),
            Self::Transport(message) => format!("cannot reach the local server: {message}"),
            Self::Refused { code, message, .. } => format!("{code}: {message}"),
        }
    }
}

type Result<T> = std::result::Result<T, CliError>;

struct Client {
    http: reqwest::Client,
    base: String,
    project: Option<String>,
    yes: bool,
    verbose: bool,
}

impl Client {
    async fn connect(cli: &Cli) -> Result<Self> {
        let base = discover(cli.server.clone()).await?;
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|error| CliError::Transport(error.to_string()))?;
        let mut client = Self {
            http,
            base,
            project: None,
            yes: cli.yes,
            verbose: cli.verbose,
        };
        if let Some(named) = &cli.project {
            client.project = Some(client.open_project(named).await?);
        }
        Ok(client)
    }

    async fn open_project(&self, named: &str) -> Result<String> {
        // A path that exists is opened; anything else is taken as an id the
        // server already knows, and a wrong one is refused on the next call.
        let is_path = std::path::Path::new(named).exists() || named.ends_with(".moka");
        if !is_path {
            return Ok(named.to_string());
        }
        let path = std::path::absolute(named).unwrap_or_else(|_| PathBuf::from(named));
        let opened: Value = self
            .send(
                Method::POST,
                "/api/v1/projects/open",
                Some(json!({"path": path.to_string_lossy()})),
            )
            .await?;
        opened
            .pointer("/moka/metadata/id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| CliError::Transport("the server opened a project without an id".into()))
    }

    async fn send(&self, method: Method, path: &str, body: Option<Value>) -> Result<Value> {
        let mut request = self.http.request(method, format!("{}{path}", self.base));
        if let Some(project) = &self.project {
            request = request.header("x-moka-project", project);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request
            .send()
            .await
            .map_err(|error| CliError::Transport(error.to_string()))?;
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|error| CliError::Transport(error.to_string()))?;
        if status == StatusCode::NO_CONTENT {
            return Ok(Value::Null);
        }
        let value: Value = if text.trim().is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&text).map_err(|error| {
                CliError::Transport(format!("the server answered unreadably: {error}"))
            })?
        };
        if !status.is_success() {
            return Err(CliError::Refused {
                code: value
                    .get("code")
                    .and_then(Value::as_str)
                    .unwrap_or("INTERNAL")
                    .to_string(),
                message: value
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("the request was refused")
                    .to_string(),
                status: status.as_u16(),
            });
        }
        Ok(value)
    }

    async fn get(&self, path: &str) -> Result<Value> {
        self.send(Method::GET, path, None).await
    }

    async fn post(&self, path: &str, body: Value) -> Result<Value> {
        self.send(Method::POST, path, Some(body)).await
    }

    async fn patch(&self, path: &str, body: Value) -> Result<Value> {
        self.send(Method::PATCH, path, Some(body)).await
    }

    async fn delete(&self, path: &str) -> Result<Value> {
        self.send(Method::DELETE, path, None).await
    }

    async fn tool(&self, name: &str, input: Value, dry_run: bool, actor: &str) -> Result<Value> {
        self.post(
            &format!("/api/v1/agent/tools/{name}"),
            json!({
                "input": input,
                "dryRun": dry_run,
                "acknowledgeRisk": self.yes,
                "actor": actor,
            }),
        )
        .await
    }
}

/// Where the server is: the flag, the environment, a note a running server
/// left in the metadata directory, or the documented default.
async fn discover(flag: Option<String>) -> Result<String> {
    let mut candidates = Vec::new();
    if let Some(flag) = flag.filter(|flag| !flag.trim().is_empty()) {
        candidates.push(flag);
    }
    if let Ok(env) = std::env::var("MOKA_SERVER") {
        if !env.trim().is_empty() {
            candidates.push(env);
        }
    }
    if let Some(note) = runtime_note() {
        candidates.push(note);
    }
    candidates.push(DEFAULT_SERVER.to_string());
    candidates.dedup();

    let probe = reqwest::Client::builder()
        .timeout(Duration::from_millis(800))
        .build()
        .map_err(|error| CliError::Transport(error.to_string()))?;
    for candidate in &candidates {
        let base = candidate.trim_end_matches('/').to_string();
        if probe
            .get(format!("{base}/api/v1/config"))
            .send()
            .await
            .map(|response| response.status().is_success())
            .unwrap_or(false)
        {
            return Ok(base);
        }
    }
    Err(CliError::Transport(format!(
        "no Moka Canvas server answered at {}",
        candidates.join(", ")
    )))
}

fn runtime_note() -> Option<String> {
    let root = match std::env::var("MOKA_METADATA_DIR") {
        Ok(dir) if !dir.trim().is_empty() => PathBuf::from(dir),
        _ => paths::platform_default().ok()?,
    };
    let raw = std::fs::read_to_string(root.join("runtime.json")).ok()?;
    let note: Value = serde_json::from_str(&raw).ok()?;
    note.get("url").and_then(Value::as_str).map(str::to_string)
}

fn print_value(value: &Value, json: bool) {
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(value).unwrap_or_else(|_| "null".into())
        );
    }
}

fn read_input(input: Option<&str>) -> Result<Value> {
    let Some(input) = input else {
        return Ok(json!({}));
    };
    if input == "-" {
        let mut raw = String::new();
        std::io::stdin()
            .read_line(&mut raw)
            .map_err(|error| CliError::Usage(error.to_string()))?;
        return serde_json::from_str(&raw)
            .map_err(|error| CliError::Usage(format!("stdin is not JSON: {error}")));
    }
    let raw = if let Some(path) = input.strip_prefix('@') {
        std::fs::read_to_string(path)
            .map_err(|error| CliError::Usage(format!("{path}: {error}")))?
    } else {
        input.to_string()
    };
    serde_json::from_str(&raw)
        .map_err(|error| CliError::Usage(format!("--input is not JSON: {error}")))
}

async fn wait_for_task(client: &Client, task: &Value, seconds: u64, json: bool) -> Result<Value> {
    let Some(kind) = task.get("kind").and_then(Value::as_str) else {
        return Ok(task.clone());
    };
    let Some(id) = task.get("id").and_then(Value::as_str) else {
        return Ok(task.clone());
    };
    let deadline = tokio::time::Instant::now() + Duration::from_secs(seconds.max(1));
    let mut delay = 1u64;
    let mut last = task.clone();
    while tokio::time::Instant::now() < deadline {
        let answer = client
            .tool("task.get", json!({"kind": kind, "id": id}), false, "cli")
            .await?;
        last = answer;
        let status = last
            .pointer("/data/status")
            .and_then(Value::as_str)
            .unwrap_or("");
        if json {
            print_value(&last, true);
        } else {
            println!(
                "{} · {}",
                status,
                last.pointer("/data/message")
                    .and_then(Value::as_str)
                    .unwrap_or("")
            );
        }
        if matches!(status, "succeeded" | "failed" | "cancelled") {
            return Ok(last);
        }
        tokio::time::sleep(Duration::from_secs(delay)).await;
        delay = (delay + 1).min(5);
    }
    Ok(last)
}

fn human_tool(answer: &Value) {
    if let Some(summary) = answer.get("summary").and_then(Value::as_str) {
        println!("{summary}");
    }
    if let Some(warnings) = answer.get("warnings").and_then(Value::as_array) {
        for warning in warnings.iter().filter_map(Value::as_str) {
            println!("warning: {warning}");
        }
    }
    if let Some(id) = answer.get("changeSetId").and_then(Value::as_str) {
        println!("change: {id} (moka changes undo {id})");
    }
    if let Some(id) = answer.get("auditId").and_then(Value::as_str) {
        println!("audit: {id} (not undoable)");
    }
    if let Some(task) = answer.get("task").filter(|task| !task.is_null()) {
        println!(
            "task: {} {}",
            task.get("kind").and_then(Value::as_str).unwrap_or(""),
            task.get("id").and_then(Value::as_str).unwrap_or("")
        );
    }
    if let Some(data) = answer.get("data").filter(|data| !data.is_null()) {
        if let Ok(text) = serde_json::to_string_pretty(data) {
            println!("{text}");
        }
    }
}

async fn run(cli: Cli) -> Result<()> {
    let json = cli.json;
    let mut client = Client::connect(&cli).await?;
    match cli.command {
        Command::Doctor => {
            let config = client.get("/api/v1/config").await?;
            let capabilities = client.get("/api/v1/agent/capabilities").await?;
            println!("server: {}", client.base);
            println!(
                "version: {}",
                config
                    .get("version")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
            );
            println!(
                "project: {}",
                client.project.as_deref().unwrap_or("whichever is open")
            );
            println!(
                "catalog: {} ({} tools)",
                capabilities
                    .get("catalogVersion")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown"),
                capabilities
                    .get("toolCount")
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
            );
        }
        Command::Tools { command } => match command {
            ToolsCommand::List { pack, surface } => {
                let mut path = format!("/api/v1/agent/tools?surface={surface}");
                if let Some(pack) = &pack {
                    path.push_str(&format!("&pack={pack}"));
                }
                let catalog = client.get(&path).await?;
                if json {
                    print_value(&catalog, true);
                } else if let Some(tools) = catalog.get("tools").and_then(Value::as_array) {
                    for tool in tools {
                        println!(
                            "{:<24} {:<8} {:<8} {}",
                            tool.get("name").and_then(Value::as_str).unwrap_or(""),
                            tool.get("kind")
                                .or_else(|| tool.get("kindLabel"))
                                .and_then(Value::as_str)
                                .unwrap_or(""),
                            tool.get("risk")
                                .or_else(|| tool.get("riskLabel"))
                                .and_then(Value::as_str)
                                .unwrap_or(""),
                            tool.get("description")
                                .and_then(Value::as_str)
                                .unwrap_or(""),
                        );
                    }
                }
            }
            ToolsCommand::Describe { name } => {
                let catalog = client.get("/api/v1/agent/tools").await?;
                let found = catalog
                    .get("tools")
                    .and_then(Value::as_array)
                    .and_then(|tools| {
                        tools
                            .iter()
                            .find(|tool| tool.get("name").and_then(Value::as_str) == Some(&name))
                    })
                    .ok_or_else(|| CliError::Usage(format!("no tool named {name}")))?;
                print_value(found, true);
            }
            ToolsCommand::Call {
                name,
                input,
                dry_run,
                wait,
            } => {
                let input = read_input(input.as_deref())?;
                let answer = client.tool(&name, input, dry_run, "cli").await?;
                if json {
                    print_value(&answer, true);
                } else {
                    human_tool(&answer);
                }
                if wait > 0 {
                    if let Some(task) = answer.get("task").filter(|task| !task.is_null()) {
                        wait_for_task(&client, task, wait, json).await?;
                    }
                }
            }
        },
        Command::Tasks { command } => match command {
            TasksCommand::Get { kind, id } => {
                let answer = client
                    .tool("task.get", json!({"kind": kind, "id": id}), false, "cli")
                    .await?;
                if json {
                    print_value(&answer, true);
                } else {
                    human_tool(&answer);
                }
            }
            TasksCommand::Cancel { kind, id } => {
                client.yes = true;
                let answer = client
                    .tool("task.cancel", json!({"kind": kind, "id": id}), false, "cli")
                    .await?;
                if json {
                    print_value(&answer, true);
                } else {
                    human_tool(&answer);
                }
            }
        },
        Command::Sessions { command } => match command {
            SessionsCommand::List { q, limit } => {
                let mut path = format!("/api/v1/agent/sessions?limit={limit}");
                if let Some(q) = &q {
                    path.push_str(&format!("&q={}", urlencoding(q)));
                }
                let answer = client.get(&path).await?;
                if json {
                    print_value(&answer, true);
                } else if let Some(sessions) = answer.get("sessions").and_then(Value::as_array) {
                    for session in sessions {
                        println!(
                            "{:<36} {:<40} {} messages",
                            session.get("id").and_then(Value::as_str).unwrap_or(""),
                            session.get("title").and_then(Value::as_str).unwrap_or(""),
                            session
                                .get("messageCount")
                                .and_then(Value::as_u64)
                                .unwrap_or(0),
                        );
                    }
                }
            }
            SessionsCommand::Show { id, limit } => {
                let answer = client
                    .get(&format!("/api/v1/agent/sessions/{id}?limit={limit}"))
                    .await?;
                print_value(&answer, json);
                if !json {
                    if let Some(messages) = answer
                        .pointer("/session/messages")
                        .and_then(Value::as_array)
                    {
                        for message in messages {
                            println!(
                                "[{}] {}",
                                message.get("role").and_then(Value::as_str).unwrap_or(""),
                                message.get("text").and_then(Value::as_str).unwrap_or("")
                            );
                        }
                    }
                }
            }
            SessionsCommand::Rename { id, title } => {
                let answer = client
                    .patch(
                        &format!("/api/v1/agent/sessions/{id}"),
                        json!({"title": title}),
                    )
                    .await?;
                if json {
                    print_value(&answer, true);
                } else {
                    println!("renamed");
                }
            }
            SessionsCommand::Delete { id, yes } => {
                if !yes {
                    return Err(CliError::Usage(
                        "deleting a conversation needs --yes".into(),
                    ));
                }
                client
                    .delete(&format!("/api/v1/agent/sessions/{id}"))
                    .await?;
                println!("deleted {id}");
            }
        },
        Command::Changes { command } => match command {
            ChangesCommand::List { limit } => {
                let answer = client
                    .get(&format!("/api/v1/agent/changes?limit={limit}"))
                    .await?;
                if json {
                    print_value(&answer, true);
                } else if let Some(changes) = answer.get("changes").and_then(Value::as_array) {
                    for change in changes {
                        println!(
                            "{:<36} {:<20} {}",
                            change.get("id").and_then(Value::as_str).unwrap_or(""),
                            change.get("tool").and_then(Value::as_str).unwrap_or(""),
                            change.get("summary").and_then(Value::as_str).unwrap_or(""),
                        );
                    }
                }
            }
            ChangesCommand::Undo { id } => {
                let answer = client
                    .post(&format!("/api/v1/agent/changes/{id}/undo"), json!({}))
                    .await?;
                if json {
                    print_value(&answer, true);
                } else {
                    println!("undone {id}");
                }
            }
        },
        Command::Audit { command } => match command {
            AuditCommand::List { limit } => {
                let answer = client
                    .get(&format!("/api/v1/agent/audit?limit={limit}"))
                    .await?;
                if json {
                    print_value(&answer, true);
                } else if let Some(records) = answer.get("audit").and_then(Value::as_array) {
                    for record in records {
                        println!(
                            "{:<36} {:<20} {}",
                            record.get("id").and_then(Value::as_str).unwrap_or(""),
                            record.get("tool").and_then(Value::as_str).unwrap_or(""),
                            record.get("summary").and_then(Value::as_str).unwrap_or(""),
                        );
                    }
                }
            }
        },
        Command::Projects { command } => match command {
            ProjectsCommand::Current => {
                let answer = client.get("/api/v1/projects/current").await?;
                if json {
                    print_value(&answer, true);
                } else {
                    println!(
                        "{} · {} · revision {}",
                        answer
                            .pointer("/moka/metadata/name")
                            .and_then(Value::as_str)
                            .unwrap_or(""),
                        answer
                            .pointer("/moka/metadata/id")
                            .and_then(Value::as_str)
                            .unwrap_or(""),
                        answer
                            .pointer("/moka/metadata/revision")
                            .and_then(Value::as_i64)
                            .unwrap_or(0),
                    );
                }
            }
            ProjectsCommand::Open { path } => {
                client.yes = true;
                let answer = client
                    .tool("project.open", json!({"path": path}), false, "cli")
                    .await?;
                if json {
                    print_value(&answer, true);
                } else {
                    human_tool(&answer);
                }
            }
            ProjectsCommand::Create {
                directory,
                name,
                subdirectory,
            } => {
                client.yes = true;
                let answer = client
                    .tool(
                        "project.create",
                        json!({"directory": directory, "name": name, "useSubdirectory": subdirectory}),
                        false,
                        "cli",
                    )
                    .await?;
                if json {
                    print_value(&answer, true);
                } else {
                    human_tool(&answer);
                }
            }
            ProjectsCommand::Import {
                archive,
                directory,
                name,
            } => {
                client.yes = true;
                let mut input = json!({"archivePath": archive, "directory": directory});
                if let Some(name) = name {
                    input["name"] = json!(name);
                }
                let answer = client.tool("project.import", input, false, "cli").await?;
                if json {
                    print_value(&answer, true);
                } else {
                    human_tool(&answer);
                }
            }
            ProjectsCommand::Recent => {
                let answer = client
                    .tool("project.list_recent", json!({}), false, "cli")
                    .await?;
                if json {
                    print_value(&answer, true);
                } else {
                    human_tool(&answer);
                }
            }
            ProjectsCommand::RemoveRecent { id } => {
                client.yes = true;
                let answer = client
                    .tool("project.remove_recent", json!({"id": id}), false, "cli")
                    .await?;
                if json {
                    print_value(&answer, true);
                } else {
                    human_tool(&answer);
                }
            }
        },
        Command::Mcp { command } => match command {
            McpCommand::Serve {
                allow_write,
                allow_spend,
                allow_destructive,
                allow_export,
            } => {
                serve_mcp(
                    client,
                    McpPolicy {
                        allow_write,
                        allow_spend,
                        allow_destructive,
                        allow_export,
                    },
                )
                .await?;
            }
        },
    }
    Ok(())
}

fn urlencoding(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            other => format!("%{other:02X}"),
        })
        .collect()
}

struct McpPolicy {
    allow_write: bool,
    allow_spend: bool,
    allow_destructive: bool,
    allow_export: bool,
}

impl McpPolicy {
    fn allows(&self, risk: &str) -> bool {
        match risk {
            "read" => true,
            "write" => self.allow_write,
            "spend" => self.allow_spend,
            "destroy" => self.allow_destructive,
            "export" => self.allow_export,
            _ => false,
        }
    }
}

/// A small MCP stdio server: one JSON-RPC message per line, external tools
/// only, and every risk above read switched on by a flag.
async fn serve_mcp(client: Client, policy: McpPolicy) -> Result<()> {
    let catalog = client
        .get("/api/v1/agent/tools?surface=external&detail=full")
        .await?;
    let tools: Vec<Value> = catalog
        .get("tools")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut by_mcp = std::collections::BTreeMap::new();
    for tool in &tools {
        if let Some(name) = tool.get("name").and_then(Value::as_str) {
            let risk = tool.get("risk").and_then(Value::as_str).unwrap_or("read");
            if !policy.allows(risk) {
                continue;
            }
            by_mcp.insert(name.replace('.', "_"), name.to_string());
        }
    }
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let line = line.map_err(|error| CliError::Transport(error.to_string()))?;
        if line.trim().is_empty() {
            continue;
        }
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let id = message.get("id").cloned();
        let method = message.get("method").and_then(Value::as_str).unwrap_or("");
        if id.is_none() {
            continue;
        }
        let answer = match method {
            "initialize" => Ok(json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {"listChanged": false}},
                "serverInfo": {"name": "moka-canvas", "version": env!("CARGO_PKG_VERSION")},
            })),
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({
                "tools": tools.iter().filter_map(|tool| {
                    let name = tool.get("name").and_then(Value::as_str)?;
                    let risk = tool.get("risk").and_then(Value::as_str).unwrap_or("read");
                    if !policy.allows(risk) {
                        return None;
                    }
                    Some(json!({
                        "name": name.replace('.', "_"),
                        "description": format!(
                            "{} [{}{}]",
                            tool.get("description").and_then(Value::as_str).unwrap_or(""),
                            tool.get("kind").and_then(Value::as_str).unwrap_or("command"),
                            if risk == "read" { String::new() } else { format!(", {risk}") }
                        ),
                        "inputSchema": tool.get("input").cloned().unwrap_or_else(|| json!({"type": "object"})),
                    }))
                }).collect::<Vec<_>>(),
            })),
            "tools/call" => {
                let params = message.get("params").cloned().unwrap_or_default();
                let asked = params.get("name").and_then(Value::as_str).unwrap_or("");
                let input = params
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                match by_mcp.get(asked) {
                    Some(name) => {
                        let client = Client {
                            http: client.http.clone(),
                            base: client.base.clone(),
                            project: client.project.clone(),
                            yes: true,
                            verbose: client.verbose,
                        };
                        match client.tool(name, input, false, "mcp").await {
                            Ok(answer) => Ok(json!({
                                "content": [{"type": "text", "text": serde_json::to_string_pretty(&answer).unwrap_or_default()}],
                                "isError": false,
                            })),
                            Err(error) => Ok(json!({
                                "content": [{"type": "text", "text": error.describe()}],
                                "isError": true,
                            })),
                        }
                    }
                    None => Err((-32602, format!("no tool named {asked}"))),
                }
            }
            other => Err((-32601, format!("method not found: {other}"))),
        };
        let payload = match answer {
            Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
            Err((code, message)) => {
                json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
            }
        };
        writeln!(
            stdout,
            "{}",
            serde_json::to_string(&payload).unwrap_or_default()
        )
        .map_err(|error| CliError::Transport(error.to_string()))?;
        stdout
            .flush()
            .map_err(|error| CliError::Transport(error.to_string()))?;
    }
    Ok(())
}

#[tokio::main]
async fn main() {
    // A pipe that closes early (`moka tools list | head`) is not a failure of
    // the command; Rust ignores SIGPIPE by default, which turns it into a
    // panic on the next write.
    #[cfg(unix)]
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_DFL);
    }
    let cli = Cli::parse();
    let verbose = cli.verbose;
    match run(cli).await {
        Ok(()) => {}
        Err(error) => {
            eprintln!("{}", error.describe());
            if verbose {
                if let CliError::Refused { status, .. } = &error {
                    eprintln!("status: {status}");
                }
            }
            std::process::exit(error.exit_code());
        }
    }
}
