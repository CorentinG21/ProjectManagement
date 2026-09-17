// dev-project-manager - backend Tauri
//
// Scanne des dossiers racines pour retrouver les projets Git, calcule leur
// état (modifs locales, commits non poussés, remote), puis expose des actions
// (ouvrir, pull, supprimer vers la corbeille). Le cœur métier est la logique
// "safe_to_delete" : un projet n'est supprimable que s'il est intégralement
// sauvegardé sur son remote.

use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};

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
    /// Vrai si le dernier `fetch`/`push` tenté a échoué : le remote configuré
    /// ne répond plus (dépôt supprimé, accès révoqué...). Dans ce cas,
    /// `ahead`/`behind`/`has_upstream` ne reflètent que le dernier état connu
    /// en cache localement, pas la réalité actuelle — on ne peut plus
    /// garantir que le projet est sauvegardé, donc `risk_level` est forcé à
    /// "critical" tant que ça n'est pas résolu. Reflète seulement le dernier
    /// essai : un simple rescan (qui ne touche jamais au réseau) ne le
    /// détecte pas, il faut un nouveau fetch/push pour re-vérifier.
    remote_unreachable: bool,
    /// Message d'erreur Git du dernier fetch/push qui a échoué (None si
    /// `remote_unreachable` est faux ou si aucun fetch/push n'a encore été
    /// tenté depuis le dernier scan).
    remote_error: Option<String>,
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
            remote_unreachable: false,
            remote_error: None,
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
    if has("Dockerfile") || has("docker-compose.yml") || has("compose.yml") {
        push("Docker");
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
///   (modifs, fichiers non suivis, stash).
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

/// Parcours récursif d'un dossier à la recherche de dépôts Git : s'arrête dès
/// qu'il en trouve un (on ne descend jamais dans un projet) et ignore les
/// dossiers lourds/cachés. Chaque dépôt trouvé est envoyé immédiatement dans
/// `tx` - il part à l'inspection tout de suite, sans attendre que le reste du
/// disque ait fini d'être exploré (voir `scan_projects`). Au premier niveau
/// sous chaque racine, les sous-dossiers sont explorés en parallèle (un
/// thread par sous-dossier) pour accélérer la découverte sur de gros disques.
fn find_repo_dirs(dir: &Path, depth: usize, tx: &mpsc::Sender<PathBuf>) {
    if depth > MAX_DEPTH {
        return;
    }

    // Un dossier contenant ".git" (dossier ou fichier pour les worktrees) est
    // un projet : on le transmet et on ne descend pas plus loin.
    if dir.join(".git").exists() {
        let _ = tx.send(dir.to_path_buf());
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
            if name.starts_with('.') || IGNORE_DIRS.iter().any(|d| d.eq_ignore_ascii_case(&name)) {
                return None;
            }
            Some(entry.path())
        })
        .collect();

    if depth == 0 {
        std::thread::scope(|scope| {
            for sub in &subdirs {
                let tx = tx.clone();
                scope.spawn(move || find_repo_dirs(sub, depth + 1, &tx));
            }
        });
    } else {
        for sub in &subdirs {
            find_repo_dirs(sub, depth + 1, tx);
        }
    }
}

/// Scanne une liste de dossiers racines et renvoie les projets trouvés,
/// triés par nom (insensible à la casse). Les racines redondantes sont
/// éliminées avant le scan.
///
/// Découverte et inspection tournent en continu, pas en deux passes
/// séquentielles : des threads "producteurs" parcourent les racines et
/// déposent chaque dépôt trouvé dans un canal dès qu'ils tombent dessus,
/// pendant qu'un pool de threads "consommateurs" (borné au nombre de cœurs)
/// les inspecte au fil de l'eau - un gros dépôt (long `git status`) ne fait
/// donc pas attendre les autres, et les résultats commencent à s'afficher
/// côté frontend dès le premier trouvé plutôt qu'après tout le scan.
#[tauri::command]
fn scan_projects(app: AppHandle, roots: Vec<String>) -> Vec<ProjectInfo> {
    let roots = dedupe_roots(roots);
    let (tx, rx) = mpsc::channel::<PathBuf>();
    let rx = Arc::new(Mutex::new(rx));
    let results: Arc<Mutex<Vec<ProjectInfo>>> = Arc::new(Mutex::new(Vec::new()));
    let worker_count = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);

    std::thread::scope(|scope| {
        // Consommateurs : inspectent chaque dépôt dès qu'il arrive dans le
        // canal. Ils s'arrêtent quand le canal est fermé (plus aucun
        // producteur actif) et vide.
        for _ in 0..worker_count {
            let rx = Arc::clone(&rx);
            let results = Arc::clone(&results);
            let app = app.clone();
            scope.spawn(move || loop {
                let received = rx.lock().unwrap().recv();
                let Ok(dir) = received else {
                    break;
                };
                let info = inspect_repo(&dir);
                let _ = app.emit("project-found", &info);
                results.lock().unwrap().push(info);
            });
        }

        // Producteurs : parcourent les racines en parallèle.
        for root in &roots {
            if !root.is_dir() {
                continue;
            }
            let tx = tx.clone();
            scope.spawn(move || find_repo_dirs(root, 0, &tx));
        }
        // Sans ce drop, ce `tx` (celui de scan_projects) resterait vivant
        // jusqu'à la fin du scope, et le canal ne se fermerait donc jamais :
        // les consommateurs resteraient bloqués sur `recv()` indéfiniment.
        drop(tx);
    });

    let mut out = Arc::try_unwrap(results)
        .map(|m| m.into_inner().unwrap())
        .unwrap_or_default();
    out.sort_by_key(|a| a.name.to_lowercase());
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
    out.sort_by_key(|b| std::cmp::Reverse(b.size_bytes));
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

// ---------- Gros fichiers & secrets potentiels ----------

const LARGE_FILE_THRESHOLD: u64 = 20 * 1024 * 1024; // 20 Mo
const SCAN_FILES_DEPTH: usize = 10;
const MAX_LARGE_FILES: usize = 20;
const MAX_SECRET_FINDINGS: usize = 30;
/// Ne scanne le contenu que des fichiers texte raisonnablement petits (évite
/// les binaires et les très gros fichiers, coûteux à lire pour rien).
const MAX_TEXT_SCAN_SIZE: u64 = 300_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LargeFile {
    path: String,
    size_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SecretFinding {
    /// Emplacement (et ligne, pour un match dans le contenu). Ne contient
    /// JAMAIS la valeur trouvée : uniquement de quoi la localiser.
    location: String,
    reason: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FilesInsight {
    large_files: Vec<LargeFile>,
    secrets: Vec<SecretFinding>,
}

const SENSITIVE_FILENAMES: &[&str] = &[
    ".env",
    ".env.local",
    ".env.production",
    ".env.development",
    "id_rsa",
    "id_ed25519",
    "id_ecdsa",
    "credentials.json",
];
const SENSITIVE_EXTENSIONS: &[&str] = &["pem", "pfx", "p12", "key"];
const TEXT_SCAN_EXTENSIONS: &[&str] = &[
    "env",
    "json",
    "yml",
    "yaml",
    "js",
    "ts",
    "py",
    "rb",
    "php",
    "java",
    "txt",
    "ini",
    "cfg",
    "toml",
    "xml",
    "properties",
];
/// (motif à chercher en minuscules, libellé humain). On ne garde jamais la
/// valeur trouvée, seulement le fait qu'un motif sensible existe à cet endroit.
const SECRET_PATTERNS: &[(&str, &str)] = &[
    ("aws_secret_access_key", "Clé secrète AWS potentielle"),
    ("aws_access_key_id", "Clé d'accès AWS potentielle"),
    ("private_key", "Clé privée potentielle"),
    ("secret_key", "Clé secrète potentielle"),
    ("secretkey", "Clé secrète potentielle"),
    ("api_key", "Clé API potentielle"),
    ("apikey", "Clé API potentielle"),
    ("password=", "Mot de passe en clair potentiel"),
    ("passwd=", "Mot de passe en clair potentiel"),
    ("token=", "Jeton d'authentification potentiel"),
];

fn check_secret_filename(name: &str, path: &Path, out: &mut Vec<SecretFinding>) {
    let lower = name.to_lowercase();
    if SENSITIVE_FILENAMES
        .iter()
        .any(|f| lower == *f || lower.starts_with(&format!("{f}.")))
    {
        out.push(SecretFinding {
            location: path.to_string_lossy().to_string(),
            reason: "Nom de fichier sensible (identifiants/clé possible)".into(),
        });
        return;
    }
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        if SENSITIVE_EXTENSIONS
            .iter()
            .any(|e| e.eq_ignore_ascii_case(ext))
        {
            out.push(SecretFinding {
                location: path.to_string_lossy().to_string(),
                reason: "Extension de fichier sensible (certificat/clé possible)".into(),
            });
        }
    }
}

fn check_secret_content(name: &str, path: &Path, out: &mut Vec<SecretFinding>) {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let is_env_like = name.to_lowercase().starts_with(".env");
    if !is_env_like && !TEXT_SCAN_EXTENSIONS.iter().any(|e| *e == ext) {
        return;
    }
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return, // binaire ou illisible : on ignore silencieusement
    };
    for (line_no, line) in content.lines().enumerate() {
        let lower = line.to_lowercase();
        if let Some((_, reason)) = SECRET_PATTERNS.iter().find(|(p, _)| lower.contains(p)) {
            out.push(SecretFinding {
                location: format!("{} (ligne {})", path.to_string_lossy(), line_no + 1),
                reason: reason.to_string(),
            });
        }
        if out.len() >= MAX_SECRET_FINDINGS {
            return;
        }
    }
}

/// Parcourt un projet une seule fois pour repérer à la fois les gros
/// fichiers et les secrets potentiels. Ignore `.git` et les dossiers
/// d'artefacts (`node_modules`…), qui n'ont pas d'intérêt ici.
fn scan_project_files(
    dir: &Path,
    depth: usize,
    large_out: &mut Vec<LargeFile>,
    secret_out: &mut Vec<SecretFinding>,
) {
    if depth > SCAN_FILES_DEPTH
        || (large_out.len() >= MAX_LARGE_FILES && secret_out.len() >= MAX_SECRET_FINDINGS)
    {
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
        if file_type.is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if file_type.is_dir() {
            if name.eq_ignore_ascii_case(".git") {
                continue;
            }
            if CLEANABLE_DIRS.iter().any(|d| d.eq_ignore_ascii_case(&name)) {
                continue; // dépendances/artefacts régénérables : pas d'intérêt
            }
            if name.starts_with('.') {
                continue;
            }
            scan_project_files(&entry.path(), depth + 1, large_out, secret_out);
            continue;
        }

        let path = entry.path();
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);

        if size >= LARGE_FILE_THRESHOLD && large_out.len() < MAX_LARGE_FILES {
            large_out.push(LargeFile {
                path: path.to_string_lossy().to_string(),
                size_bytes: size,
            });
        }

        if secret_out.len() < MAX_SECRET_FINDINGS {
            check_secret_filename(&name, &path, secret_out);
            if size > 0 && size < MAX_TEXT_SCAN_SIZE {
                check_secret_content(&name, &path, secret_out);
            }
        }
    }
}

/// Analyse un projet pour repérer les gros fichiers (mauvais pour un dépôt
/// Git) et des indices de secrets présents en clair. Ne renvoie jamais la
/// valeur d'un secret trouvé, seulement son emplacement.
#[tauri::command]
fn scan_files_insight(path: String) -> FilesInsight {
    let mut large_files = Vec::new();
    let mut secrets = Vec::new();
    scan_project_files(&PathBuf::from(path), 0, &mut large_files, &mut secrets);
    large_files.sort_by_key(|b| std::cmp::Reverse(b.size_bytes));
    FilesInsight {
        large_files,
        secrets,
    }
}

// ---------- Outils installés ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolCheck {
    name: String,
    installed: bool,
    version: Option<String>,
}

fn check_tool(display_name: &str, cmd_name: &str, args: &[&str]) -> ToolCheck {
    // Sous Windows, on passe par `cmd /C` plutôt que d'exécuter `cmd_name`
    // directement : certains outils (VS Code notamment) ne sont sur le PATH
    // que via un script `.cmd`, que `Command::new` seul ne sait pas résoudre
    // (contrairement à un vrai shell). `git`/`node`/`cargo`/`python`/`docker`
    // sont de vrais `.exe` et fonctionneraient sans, mais passer par `cmd`
    // pour tous uniformise le comportement sans coût perceptible (vérification
    // ponctuelle, pas un chemin chaud).
    #[cfg(windows)]
    let mut cmd = {
        let mut c = std::process::Command::new("cmd");
        c.arg("/C").arg(cmd_name).args(args);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = std::process::Command::new(cmd_name);
        c.args(args);
        c
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    match cmd.output() {
        Ok(output) if output.status.success() => {
            let raw = String::from_utf8_lossy(&output.stdout);
            let first_line = raw.lines().next().unwrap_or("").trim().to_string();
            ToolCheck {
                name: display_name.to_string(),
                installed: true,
                version: if first_line.is_empty() {
                    None
                } else {
                    Some(first_line)
                },
            }
        }
        _ => ToolCheck {
            name: display_name.to_string(),
            installed: false,
            version: None,
        },
    }
}

/// Vérifie la présence des outils de développement courants sur ce PC.
#[tauri::command]
fn check_tools() -> Vec<ToolCheck> {
    vec![
        check_tool("Git", "git", &["--version"]),
        check_tool("Node.js", "node", &["--version"]),
        check_tool("Rust (cargo)", "cargo", &["--version"]),
        check_tool("Python", "python", &["--version"]),
        check_tool("Docker", "docker", &["--version"]),
        check_tool("VS Code", "code", &["--version"]),
    ]
}

// ---------- Branches & statistiques du dépôt ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BranchInfo {
    name: String,
    is_current: bool,
    has_upstream: bool,
    ahead: Option<usize>,
    behind: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RepoInsights {
    branches: Vec<BranchInfo>,
    total_commits: usize,
}

/// Liste les branches locales (avec leur avance/retard sur leur remote) et
/// compte le nombre total de commits de la branche courante.
#[tauri::command]
fn repo_insights(path: String) -> Result<RepoInsights, String> {
    let repo = Repository::open(&path).map_err(|e| e.message().to_string())?;
    let current_branch = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().map(|s| s.to_string()));

    let mut branches = Vec::new();
    if let Ok(iter) = repo.branches(Some(BranchType::Local)) {
        for (branch, _) in iter.flatten() {
            let name = match branch.name() {
                Ok(Some(n)) => n.to_string(),
                _ => continue,
            };
            let is_current = current_branch.as_deref() == Some(name.as_str());
            let mut has_upstream = false;
            let mut ahead = None;
            let mut behind = None;
            if let Ok(upstream) = branch.upstream() {
                has_upstream = true;
                if let (Some(local_oid), Some(up_oid)) =
                    (branch.get().target(), upstream.get().target())
                {
                    if let Ok((a, b)) = repo.graph_ahead_behind(local_oid, up_oid) {
                        ahead = Some(a);
                        behind = Some(b);
                    }
                }
            }
            branches.push(BranchInfo {
                name,
                is_current,
                has_upstream,
                ahead,
                behind,
            });
        }
    }
    // La branche courante en premier, puis ordre alphabétique.
    branches.sort_by(|a, b| b.is_current.cmp(&a.is_current).then(a.name.cmp(&b.name)));

    let mut total_commits = 0usize;
    if let Ok(mut walk) = repo.revwalk() {
        if walk.push_head().is_ok() {
            total_commits = walk.flatten().count();
        }
    }

    Ok(RepoInsights {
        branches,
        total_commits,
    })
}

// ---------- Détail des fichiers modifiés ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileStatusEntry {
    path: String,
    /// "new" | "modified" | "deleted" | "renamed" | "typechange" | "conflicted"
    status: &'static str,
}

const MAX_FILE_STATUS_ENTRIES: usize = 300;

/// Liste détaillée des fichiers modifiés/nouveaux/supprimés (équivalent
/// `git status`), pour montrer précisément ce qui n'est pas commité.
#[tauri::command]
fn file_status(path: String) -> Vec<FileStatusEntry> {
    let mut out = Vec::new();
    let repo = match Repository::open(&path) {
        Ok(r) => r,
        Err(_) => return out,
    };
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .include_ignored(false)
        .recurse_untracked_dirs(true);
    let statuses = match repo.statuses(Some(&mut opts)) {
        Ok(s) => s,
        Err(_) => return out,
    };
    for entry in statuses.iter() {
        if out.len() >= MAX_FILE_STATUS_ENTRIES {
            break;
        }
        let file_path = match entry.path() {
            Some(p) => p.to_string(),
            None => continue,
        };
        let status = entry.status();
        let label = if status.is_conflicted() {
            "conflicted"
        } else if status.is_wt_new() || status.is_index_new() {
            "new"
        } else if status.is_wt_deleted() || status.is_index_deleted() {
            "deleted"
        } else if status.is_wt_renamed() || status.is_index_renamed() {
            "renamed"
        } else if status.is_wt_typechange() || status.is_index_typechange() {
            "typechange"
        } else {
            "modified"
        };
        out.push(FileStatusEntry {
            path: file_path,
            status: label,
        });
    }
    out
}

/// Sécurise un projet avant suppression : ajoute et commite tout ce qui est
/// en attente, puis pousse sur le remote. Un "rien à commiter" n'est pas une
/// erreur (on passe directement au push) ; un échec du push (ex. pas de
/// remote) est en revanche remonté tel quel.
#[tauri::command]
fn secure_project(path: String) -> Result<ProjectInfo, String> {
    run_git(&path, &["add", "-A"]).map_err(|e| format!("git add a échoué : {e}"))?;

    // On vérifie s'il y a quelque chose à commiter via `--porcelain` (sortie
    // stable, indépendante de la langue) plutôt qu'en devinant si le message
    // d'erreur de `git commit` correspond à "rien à valider" : ce message
    // varie selon la langue configurée pour Git, et une locale non prévue
    // ferait échouer la sécurisation à tort alors qu'il n'y avait juste rien
    // à commiter.
    let status = run_git(&path, &["status", "--porcelain"])
        .map_err(|e| format!("git status a échoué : {e}"))?;
    if !status.trim().is_empty() {
        run_git(
            &path,
            &[
                "commit",
                "-m",
                "Sécurisé automatiquement avant suppression (Dev Project Manager)",
            ],
        )
        .map_err(|e| format!("git commit a échoué : {e}"))?;
    }

    run_git(&path, &["push", "-u", "origin", "HEAD"])
        .map_err(|e| format!("git push a échoué : {e}"))?;
    Ok(inspect_repo(&PathBuf::from(&path)))
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

/// Marque une info de projet fraîchement inspectée comme non vérifiable :
/// le fetch/push qui vient d'échouer signifie que le remote configuré ne
/// répond plus (dépôt supprimé, accès révoqué, panne réseau...). Les
/// `ahead`/`behind`/`has_upstream` actuels ne reflètent que le dernier état
/// connu en cache localement, pas la réalité — on ne peut donc plus
/// garantir que le projet est sauvegardé, quel que soit ce que dit le cache.
fn mark_remote_unreachable(info: &mut ProjectInfo, error: String) {
    info.remote_unreachable = true;
    info.remote_error = Some(error);
    info.risk_level = "critical";
    info.safe_to_delete = false;
}

/// Récupère les refs distantes sans fusionner (`git fetch --prune`), puis
/// renvoie l'état Git réactualisé du projet (avance/retard à jour). Ne
/// renvoie plus d'erreur côté Tauri si le fetch échoue : l'échec est
/// intégré dans le `ProjectInfo` renvoyé (`remoteUnreachable`/`remoteError`)
/// pour que l'appelant puisse à la fois l'afficher et mettre à jour l'état
/// persistant du projet (badge, niveau de risque) en une seule fois.
#[tauri::command]
fn fetch_project(path: String) -> ProjectInfo {
    let fetch_err = run_git(&path, &["fetch", "--prune"]).err();
    let mut info = inspect_repo(&PathBuf::from(&path));
    if let Some(err) = fetch_err {
        mark_remote_unreachable(&mut info, err);
    }
    info
}

/// Pousse la branche courante (`git push -u origin HEAD` : crée le suivi
/// distant si besoin), puis renvoie l'état Git réactualisé. Même logique que
/// `fetch_project` : un échec (remote introuvable...) est intégré dans le
/// `ProjectInfo` renvoyé plutôt que de faire échouer l'appel Tauri.
#[tauri::command]
fn push_project(path: String) -> ProjectInfo {
    let push_err = run_git(&path, &["push", "-u", "origin", "HEAD"]).err();
    let mut info = inspect_repo(&PathBuf::from(&path));
    if let Some(err) = push_err {
        mark_remote_unreachable(&mut info, err);
    }
    info
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

const VSCODE_NOT_FOUND: &str = "VS Code introuvable (la commande `code` n'est pas dans le PATH).";

/// Résout le chemin complet du script `code.cmd` sur le PATH. `where` est un
/// exécutable natif appelé avec un argument fixe ("code") : aucun risque
/// d'injection à cette étape, quel que soit le contenu de `path` plus tard.
#[cfg(windows)]
fn find_code_cmd() -> Option<String> {
    use std::os::windows::process::CommandExt;
    let mut cmd = std::process::Command::new("where");
    cmd.arg("code");
    cmd.creation_flags(0x0800_0000);
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|l| l.to_lowercase().ends_with(".cmd"))
        .map(str::to_string)
}

/// Ouvre le projet dans VS Code (`code <path>`).
#[tauri::command]
fn open_in_editor(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // `code` est un script `.cmd` sous Windows : `Command::new("code")`
        // seul ne le trouve pas (pas de résolution PATHEXT), et passer par
        // `cmd /C code <path>` réintroduirait un interpréteur de commandes
        // qui réinterprète `&`/`|` comme des séparateurs et `%VAR%` comme des
        // variables d'environnement, y compris pour un chemin de projet local
        // qui contiendrait ces caractères. On résout donc le chemin complet
        // de `code.cmd` puis on l'exécute directement par ce chemin : Windows
        // sait lancer un `.cmd` désigné par son chemin complet sans passer
        // par un interpréteur, donc `path` n'est jamais réinterprété.
        let code_cmd_path = find_code_cmd().ok_or(VSCODE_NOT_FOUND)?;
        let mut cmd = std::process::Command::new(&code_cmd_path);
        cmd.arg(&path);
        cmd.creation_flags(0x0800_0000);
        let output = cmd.output().map_err(|e| e.to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
            Err(if err.is_empty() {
                VSCODE_NOT_FOUND.into()
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
        // `url` vient du remote Git du projet (donc potentiellement d'un dépôt
        // tiers non fiable) : on évite `cmd /C start` qui réinterprète des
        // métacaractères comme `&` ou `|` comme des séparateurs de commande
        // même à l'intérieur d'une URL a priori inoffensive (ex.
        // "...?a=1&b=2"), ouvrant la porte à de l'injection de commande.
        // `explorer.exe` délègue à l'application par défaut pour ce schéma
        // sans repasser par un interpréteur de commandes.
        std::process::Command::new("explorer")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
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
        .plugin(tauri_plugin_notification::init())
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
            clean_paths,
            scan_files_insight,
            check_tools,
            repo_insights,
            file_status,
            secure_project
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
