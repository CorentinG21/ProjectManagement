// dev-project-manager — backend Tauri
//
// Scanne des dossiers racines pour retrouver les projets Git, calcule leur
// état (modifs locales, commits non poussés, remote), puis expose des actions
// (ouvrir, pull, supprimer vers la corbeille). Le cœur métier est la logique
// "safe_to_delete" : un projet n'est supprimable que s'il est intégralement
// sauvegardé sur son remote.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use git2::{BranchType, Repository, StatusOptions};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Dossiers dans lesquels on ne descend jamais pendant le scan : soit ils sont
/// énormes (node_modules…) et ruineraient les perfs, soit ils ne contiennent
/// pas de projets pertinents. Les dossiers cachés (commençant par ".") sont
/// exclus séparément.
const IGNORE_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    "vendor",
    "__pycache__",
    "obj",
    "bin",
    "coverage",
];

/// Profondeur maximale de récursion, garde-fou contre les arborescences
/// pathologiques (liens, dossiers réseau…).
const MAX_DEPTH: usize = 12;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectInfo {
    /// Nom du dossier du projet.
    name: String,
    /// Chemin absolu.
    path: String,
    /// Technologies détectées (Node, Rust, Python…) d'après les fichiers marqueurs.
    stack: Vec<String>,
    /// Branche courante (None si HEAD détachée ou dépôt vide).
    branch: Option<String>,
    /// Au moins un remote est configuré.
    has_remote: bool,
    /// URL du remote (origin en priorité).
    remote_url: Option<String>,
    /// La branche courante suit une branche distante (donc a déjà été poussée).
    has_upstream: bool,
    /// Des modifications non commitées sont présentes (working tree sale).
    is_dirty: bool,
    /// Commits locaux en avance sur le remote (non poussés).
    ahead: Option<usize>,
    /// Commits du remote en retard localement (nécessite un fetch récent).
    behind: Option<usize>,
    /// Date du dernier commit (timestamp Unix en secondes).
    last_commit: Option<i64>,
    /// Nombre de fichiers suivis modifiés/supprimés/renommés non commités.
    modified_files: usize,
    /// Nombre de fichiers non suivis (nouveaux, jamais ajoutés à Git).
    untracked_files: usize,
    /// Nombre d'entrées dans le stash Git.
    stash_count: usize,
    /// Niveau de risque global : "safe" | "attention" | "risk" | "critical".
    risk_level: &'static str,
    /// Vrai uniquement si le projet est intégralement sauvegardé sur le remote
    /// (équivalent à `risk_level == "safe"`, gardé pour compatibilité).
    safe_to_delete: bool,
    /// Message d'erreur si l'inspection Git a échoué.
    error: Option<String>,
}

impl ProjectInfo {
    fn new(dir: &Path) -> Self {
        let name = dir
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| dir.to_string_lossy().to_string());
        ProjectInfo {
            name,
            path: dir.to_string_lossy().to_string(),
            stack: detect_stack(dir),
            branch: None,
            has_remote: false,
            remote_url: None,
            has_upstream: false,
            is_dirty: false,
            ahead: None,
            behind: None,
            last_commit: None,
            modified_files: 0,
            untracked_files: 0,
            stash_count: 0,
            risk_level: "critical",
            safe_to_delete: false,
            error: None,
        }
    }
}

/// Devine les technologies d'un projet d'après ses fichiers marqueurs.
fn detect_stack(dir: &Path) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let has = |f: &str| dir.join(f).exists();
    let mut push = |s: &str| {
        if !out.iter().any(|x| x == s) {
            out.push(s.to_string());
        }
    };

    if has("package.json") {
        push("Node");
    }
    if has("tsconfig.json") {
        push("TypeScript");
    }
    if has("Cargo.toml") {
        push("Rust");
    }
    if has("go.mod") {
        push("Go");
    }
    if has("requirements.txt") || has("pyproject.toml") || has("Pipfile") {
        push("Python");
    }
    if has("pom.xml") || has("build.gradle") || has("build.gradle.kts") {
        push("Java");
    }
    if has("composer.json") {
        push("PHP");
    }
    if has("Gemfile") {
        push("Ruby");
    }
    if has("pubspec.yaml") {
        push("Flutter");
    }
    // .NET : présence d'un .sln ou .csproj à la racine.
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            if let Some(ext) = entry.path().extension() {
                if ext == "sln" || ext == "csproj" {
                    push(".NET");
                    break;
                }
            }
        }
    }
    out
}

/// Ouvre un dépôt Git et remplit toutes ses métadonnées. Ne panique jamais :
/// en cas d'échec, `error` est renseigné et le projet est marqué non supprimable.
fn inspect_repo(dir: &Path) -> ProjectInfo {
    let mut info = ProjectInfo::new(dir);

    let mut repo = match Repository::open(dir) {
        Ok(r) => r,
        Err(e) => {
            info.error = Some(e.message().to_string());
            return info;
        }
    };

    // Remotes + URL (origin prioritaire, sinon le premier trouvé).
    if let Ok(remotes) = repo.remotes() {
        info.has_remote = !remotes.is_empty();
        if let Ok(origin) = repo.find_remote("origin") {
            info.remote_url = origin.url().map(String::from);
        } else if let Some(first) = remotes.iter().flatten().next() {
            if let Ok(r) = repo.find_remote(first) {
                info.remote_url = r.url().map(String::from);
            }
        }
    }

    // Working tree sale ? On inclut les fichiers non suivis mais pas les ignorés.
    // On distingue au passage fichiers modifiés (suivis) et non suivis (nouveaux),
    // pour pouvoir détailler ce qui serait perdu avant une suppression.
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .include_ignored(false)
        .recurse_untracked_dirs(true);
    if let Ok(statuses) = repo.statuses(Some(&mut opts)) {
        info.is_dirty = !statuses.is_empty();
        for entry in statuses.iter() {
            let status = entry.status();
            if status.is_wt_new() || status.is_index_new() {
                info.untracked_files += 1;
            } else {
                info.modified_files += 1;
            }
        }
    }

    // Stash : du travail mis de côté qui ne serait jamais poussé sur le remote.
    let mut stash_count = 0usize;
    let _ = repo.stash_foreach(|_idx, _msg, _oid| {
        stash_count += 1;
        true
    });
    info.stash_count = stash_count;

    // Branche, dernier commit, et suivi de la branche distante.
    if let Ok(head) = repo.head() {
        if let Some(shorthand) = head.shorthand() {
            info.branch = Some(shorthand.to_string());
        }
        if let Ok(commit) = head.peel_to_commit() {
            info.last_commit = Some(commit.time().seconds());
        }
        if head.is_branch() {
            if let Some(shorthand) = head.shorthand() {
                if let Ok(local) = repo.find_branch(shorthand, BranchType::Local) {
                    if let Ok(upstream) = local.upstream() {
                        info.has_upstream = true;
                        if let (Some(local_oid), Some(up_oid)) =
                            (head.target(), upstream.get().target())
                        {
                            if let Ok((ahead, behind)) = repo.graph_ahead_behind(local_oid, up_oid)
                            {
                                info.ahead = Some(ahead);
                                info.behind = Some(behind);
                            }
                        }
                    }
                }
            }
        }
    }

    info.risk_level = compute_risk_level(&info);
    info.safe_to_delete = info.risk_level == "safe";

    info
}

/// Calcule le niveau de risque d'une suppression, du plus grave au plus sûr :
/// - critical : rien n'existe ailleurs que sur ce PC (pas de remote), ou état illisible.
/// - risk     : des commits seraient perdus (jamais poussés, ou branche jamais poussée).
/// - attention: tout est poussé, mais du travail local non commité existe encore
///              (modifs, fichiers non suivis, stash).
/// - safe     : strictement rien ne serait perdu.
fn compute_risk_level(info: &ProjectInfo) -> &'static str {
    if info.error.is_some() || !info.has_remote {
        return "critical";
    }
    if !info.has_upstream || info.ahead.unwrap_or(0) > 0 {
        return "risk";
    }
    if info.is_dirty || info.stash_count > 0 {
        return "attention";
    }
    "safe"
}

/// Enlève les racines déjà couvertes par une autre racine de la liste (ex:
/// `D:\Dev` et `D:\` donneraient sinon les mêmes projets deux fois, et on
/// scannerait `D:\Dev` en double). Garde les chemins les plus courts d'abord.
///
/// La comparaison se fait sur le chemin canonique (résout `..`, la casse du
/// lecteur, les liens symboliques…) mais on conserve le chemin d'origine pour
/// le scan/l'affichage : `canonicalize` préfixe les chemins Windows avec
/// `\\?\`, qu'on ne veut pas voir apparaître dans l'UI.
fn dedupe_roots(roots: Vec<String>) -> Vec<PathBuf> {
    let mut paths: Vec<(PathBuf, PathBuf)> = roots
        .into_iter()
        .map(PathBuf::from)
        .map(|p| {
            let canon = std::fs::canonicalize(&p).unwrap_or_else(|_| p.clone());
            (p, canon)
        })
        .collect();
    paths.sort_by_key(|(_, canon)| canon.components().count());

    let mut kept: Vec<(PathBuf, PathBuf)> = Vec::new();
    for (original, canon) in paths {
        if !kept.iter().any(|(_, k)| canon.starts_with(k)) {
            kept.push((original, canon));
        }
    }
    kept.into_iter().map(|(original, _)| original).collect()
}

/// Parcours récursif d'un dossier. S'arrête dès qu'un dépôt Git est trouvé
/// (on ne descend jamais dans un projet), et ignore les dossiers lourds/cachés.
/// Au premier niveau sous chaque racine, les sous-dossiers sont explorés en
/// parallèle (un thread par sous-dossier) pour accélérer les scans sur de
/// gros disques. Chaque projet trouvé est envoyé immédiatement au frontend
/// via un évènement, en plus d'être accumulé dans `results`.
fn scan_dir(dir: &Path, depth: usize, app: &AppHandle, results: &Arc<Mutex<Vec<ProjectInfo>>>) {
    if depth > MAX_DEPTH {
        return;
    }

    // Un dossier contenant ".git" (dossier ou fichier pour les worktrees) est
    // un projet : on l'inspecte et on ne descend pas plus loin.
    if dir.join(".git").exists() {
        let info = inspect_repo(dir);
        let _ = app.emit("project-found", &info);
        results.lock().unwrap().push(info);
        return;
    }

    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    let subdirs: Vec<PathBuf> = entries
        .flatten()
        .filter_map(|entry| {
            let file_type = entry.file_type().ok()?;
            // On ignore les liens symboliques (risque de boucle) et les fichiers.
            if file_type.is_symlink() || !file_type.is_dir() {
                return None;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy().to_string();
            // Comparaison insensible à la casse : sous Windows "Build"/"Bin"
            // doivent être ignorés au même titre que "build"/"bin".
            if name.starts_with('.')
                || IGNORE_DIRS.iter().any(|d| d.eq_ignore_ascii_case(&name))
            {
                return None;
            }
            Some(entry.path())
        })
        .collect();

    if depth == 0 {
        std::thread::scope(|scope| {
            for sub in &subdirs {
                scope.spawn(move || scan_dir(sub, depth + 1, app, results));
            }
        });
    } else {
        for sub in &subdirs {
            scan_dir(sub, depth + 1, app, results);
        }
    }
}

/// Scanne une liste de dossiers racines et renvoie les projets trouvés,
/// triés par nom (insensible à la casse). Les racines redondantes sont
/// éliminées avant le scan, et chaque racine restante est scannée dans son
/// propre thread pour paralléliser le travail disque.
#[tauri::command]
fn scan_projects(app: AppHandle, roots: Vec<String>) -> Vec<ProjectInfo> {
    let roots = dedupe_roots(roots);
    let results: Arc<Mutex<Vec<ProjectInfo>>> = Arc::new(Mutex::new(Vec::new()));

    std::thread::scope(|scope| {
        for root in &roots {
            if !root.is_dir() {
                continue;
            }
            let results = Arc::clone(&results);
            let app = app.clone();
            scope.spawn(move || scan_dir(root, 0, &app, &results));
        }
    });

    let mut out = Arc::try_unwrap(results)
        .map(|m| m.into_inner().unwrap())
        .unwrap_or_default();
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

/// Renvoie des dossiers racines par défaut plausibles (ceux qui existent).
#[tauri::command]
fn default_roots() -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(home) = std::env::var("USERPROFILE") {
        let base = PathBuf::from(&home);
        for sub in [
            "Desktop",
            "Documents",
            "source\\repos",
            "dev",
            "Projects",
            "git",
        ] {
            let candidate = base.join(sub);
            if candidate.is_dir() {
                out.push(candidate.to_string_lossy().to_string());
            }
        }
    }
    out
}

/// Calcule récursivement la taille d'un dossier (somme des fichiers, liens
/// symboliques ignorés pour éviter les boucles).
fn dir_size(dir: &Path) -> u64 {
    let mut total = 0;
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return 0,
    };
    for entry in entries.flatten() {
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            total += dir_size(&entry.path());
        } else if let Ok(meta) = entry.metadata() {
            total += meta.len();
        }
    }
    total
}

/// Calcule la taille sur disque d'un projet (récursif, inclut node_modules).
/// Volontairement séparé du scan pour ne pas le ralentir : appelé à la demande.
#[tauri::command]
fn project_size(path: String) -> u64 {
    dir_size(&PathBuf::from(path))
}

/// Dossiers d'artefacts régénérables : jamais de code source ni de données
/// Git, uniquement des sorties de build/dépendances qu'on peut reconstruire
/// (`npm install`, `cargo build`…). Liste volontairement plus large que
/// `IGNORE_DIRS` (inclut aussi les dossiers cachés comme `.venv`/`.next`).
const CLEANABLE_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    "vendor",
    "__pycache__",
    "obj",
    "bin",
    "coverage",
    ".venv",
    "venv",
    ".next",
    ".nuxt",
    ".cache",
];

/// Profondeur maximale pour le scan de nettoyage : un projet a rarement plus
/// de 8 niveaux avant un dossier d'artefacts.
const CLEAN_SCAN_DEPTH: usize = 8;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CleanableEntry {
    /// Nom du dossier d'artefacts (ex. "node_modules").
    name: String,
    /// Chemin absolu.
    path: String,
    /// Taille sur disque.
    size_bytes: u64,
}

/// Cherche dans un projet les dossiers d'artefacts régénérables
/// (`node_modules`, `target`, `dist`…) et calcule leur taille. Ne touche
/// jamais à `.git` ni au code source : ne recurse que dans les dossiers
/// normaux, s'arrête dès qu'un dossier d'artefacts est trouvé.
fn scan_cleanable_dir(dir: &Path, depth: usize, out: &mut Vec<CleanableEntry>) {
    if depth > CLEAN_SCAN_DEPTH {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if file_type.is_symlink() || !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.eq_ignore_ascii_case(".git") {
            continue; // jamais touché, jamais recursé
        }
        if CLEANABLE_DIRS.iter().any(|d| d.eq_ignore_ascii_case(&name)) {
            let path = entry.path();
            out.push(CleanableEntry {
                name,
                size_bytes: dir_size(&path),
                path: path.to_string_lossy().to_string(),
            });
            continue; // pas de recursion dans un dossier d'artefacts
        }
        if name.starts_with('.') {
            continue; // autres dossiers cachés (.vscode, .idea…) : on n'y touche pas
        }
        scan_cleanable_dir(&entry.path(), depth + 1, out);
    }
}

/// Analyse un projet pour trouver l'espace récupérable sans toucher au code
/// source ni à l'historique Git.
#[tauri::command]
fn scan_cleanable(path: String) -> Vec<CleanableEntry> {
    let mut out = Vec::new();
    scan_cleanable_dir(&PathBuf::from(path), 0, &mut out);
    out.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
    out
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CleanOutcome {
    path: String,
    ok: bool,
    error: Option<String>,
}

/// Envoie une liste de dossiers d'artefacts à la corbeille (réversible).
/// Chaque chemin est traité indépendamment : un échec n'interrompt pas les
/// autres.
#[tauri::command]
fn clean_paths(paths: Vec<String>) -> Vec<CleanOutcome> {
    paths
        .into_iter()
        .map(|path| match trash::delete(&path) {
            Ok(()) => CleanOutcome {
                path,
                ok: true,
                error: None,
            },
            Err(e) => CleanOutcome {
                path,
                ok: false,
                error: Some(e.to_string()),
            },
        })
        .collect()
}

/// Envoie un projet à la corbeille (réversible, pas de suppression définitive).
#[tauri::command]
fn delete_project(path: String) -> Result<(), String> {
    trash::delete(&path).map_err(|e| e.to_string())
}

/// Exécute une commande `git -C <path> <args>` sans flash de console (Windows),
/// et renvoie stdout (ou stderr) en cas de succès, l'erreur sinon.
fn run_git(path: &str, args: &[&str]) -> Result<String, String> {
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C").arg(path).args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let output = cmd.output().map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if output.status.success() {
        Ok(if stdout.is_empty() { stderr } else { stdout })
    } else {
        Err(if stderr.is_empty() { stdout } else { stderr })
    }
}

/// Met à jour un projet via `git pull --ff-only` (jamais de merge surprise).
#[tauri::command]
fn pull_project(path: String) -> Result<String, String> {
    run_git(&path, &["pull", "--ff-only"])
}

/// Récupère les refs distantes sans fusionner (`git fetch --prune`), puis
/// renvoie l'état Git réactualisé du projet (avance/retard à jour).
#[tauri::command]
fn fetch_project(path: String) -> Result<ProjectInfo, String> {
    run_git(&path, &["fetch", "--prune"])?;
    Ok(inspect_repo(&PathBuf::from(&path)))
}

/// Pousse la branche courante (`git push -u origin HEAD` : crée le suivi
/// distant si besoin), puis renvoie l'état Git réactualisé.
#[tauri::command]
fn push_project(path: String) -> Result<ProjectInfo, String> {
    run_git(&path, &["push", "-u", "origin", "HEAD"])?;
    Ok(inspect_repo(&PathBuf::from(&path)))
}

/// Ouvre le dossier du projet dans l'explorateur de fichiers.
#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        // explorer.exe renvoie souvent un code non nul même en cas de succès :
        // on se contente de le lancer sans vérifier le statut.
        std::process::Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err("Plateforme non supportée".into())
    }
}

/// Ouvre le projet dans VS Code (`code <path>`).
#[tauri::command]
fn open_in_editor(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        // `code` est un `.cmd` sous Windows : on passe par `cmd /C`.
        let mut cmd = std::process::Command::new("cmd");
        cmd.args(["/C", "code", &path]);
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
        let output = cmd.output().map_err(|e| e.to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
            Err(if err.is_empty() {
                "VS Code introuvable (la commande `code` n'est pas dans le PATH).".into()
            } else {
                err
            })
        }
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err("Plateforme non supportée".into())
    }
}

/// Lit le README du projet (les premiers milliers de caractères), s'il existe.
#[tauri::command]
fn read_readme(path: String) -> Option<String> {
    let dir = PathBuf::from(path);
    let candidates = [
        "README.md",
        "readme.md",
        "Readme.md",
        "README.markdown",
        "README.txt",
        "README",
    ];
    for name in candidates {
        let file = dir.join(name);
        if file.is_file() {
            if let Ok(content) = std::fs::read_to_string(&file) {
                return Some(content.chars().take(6000).collect());
            }
        }
    }
    None
}

/// Ouvre un sélecteur de dossier natif et renvoie le chemin choisi.
#[tauri::command]
fn pick_folder() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("Choisir un dossier à scanner")
        .pick_folder()
        .map(|p| p.to_string_lossy().to_string())
}

/// Ouvre une URL http(s) dans le navigateur par défaut.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("URL non autorisée".into());
    }
    #[cfg(windows)]
    {
        let mut cmd = std::process::Command::new("cmd");
        cmd.args(["/C", "start", "", &url]);
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
        cmd.spawn().map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err("Plateforme non supportée".into())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CommitLog {
    hash: String,
    summary: String,
    author: String,
    timestamp: i64,
}

/// Renvoie les 5 derniers commits de la branche courante.
#[tauri::command]
fn recent_commits(path: String) -> Vec<CommitLog> {
    let mut out = Vec::new();
    let repo = match Repository::open(&path) {
        Ok(r) => r,
        Err(_) => return out,
    };
    let mut walk = match repo.revwalk() {
        Ok(w) => w,
        Err(_) => return out,
    };
    if walk.push_head().is_err() {
        return out;
    }
    for oid in walk.take(5).flatten() {
        if let Ok(commit) = repo.find_commit(oid) {
            out.push(CommitLog {
                hash: oid.to_string().chars().take(7).collect(),
                summary: commit.summary().unwrap_or("").to_string(),
                author: commit.author().name().unwrap_or("").to_string(),
                timestamp: commit.time().seconds(),
            });
        }
    }
    out
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            scan_projects,
            default_roots,
            project_size,
            delete_project,
            pull_project,
            open_folder,
            open_in_editor,
            read_readme,
            pick_folder,
            fetch_project,
            push_project,
            open_url,
            recent_commits,
            scan_cleanable,
            clean_paths
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
