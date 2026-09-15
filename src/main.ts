import { invoke } from "@tauri-apps/api/core";

// ---------- Types ----------
interface ProjectInfo {
  name: string;
  path: string;
  stack: string[];
  branch: string | null;
  hasRemote: boolean;
  remoteUrl: string | null;
  hasUpstream: boolean;
  isDirty: boolean;
  ahead: number | null;
  behind: number | null;
  lastCommit: number | null;
  safeToDelete: boolean;
  error: string | null;
  sizeBytes?: number; // renseigné en arrière-plan
}

interface CommitLog {
  hash: string;
  summary: string;
  author: string;
  timestamp: number;
}

type Filter = "all" | "safe" | "dirty" | "ahead" | "noremote";
type ViewMode = "list" | "detail" | "settings";
type SortBy = "name" | "size" | "commit" | "status";
type Theme = "light" | "dark";

// ---------- Icônes (SVG inline, style Feather) ----------
const ICONS: Record<string, string> = {
  grid: `<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>`,
  check: `<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>`,
  edit: `<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>`,
  up: `<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>`,
  cloudoff: `<line x1="1" y1="1" x2="23" y2="23"/><path d="M16 16h-4M22.61 16.95A5 5 0 0 0 18 10h-1.26a8 8 0 0 0-7.05-6M5 5a8 8 0 0 0 4 15h9"/>`,
  gear: `<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>`,
  folder: `<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>`,
  disk: `<line x1="22" y1="12" x2="2" y2="12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" y1="16" x2="6.01" y2="16"/><line x1="10" y1="16" x2="10.01" y2="16"/>`,
  search: `<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>`,
  refresh: `<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>`,
  chevron: `<polyline points="9 18 15 12 9 6"/>`,
  branch: `<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>`,
  back: `<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>`,
  open: `<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>`,
  pull: `<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>`,
  trash: `<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>`,
  shieldcheck: `<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/>`,
  alert: `<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>`,
  sun: `<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>`,
  moon: `<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>`,
  code: `<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>`,
  folderplus: `<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/>`,
};

function icon(name: string): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${
    ICONS[name] ?? ""
  }</svg>`;
}

const NAV: { key: string; label: string; icon: string }[] = [
  { key: "all", label: "Vue d'ensemble", icon: "grid" },
  { key: "safe", label: "Supprimables", icon: "check" },
  { key: "dirty", label: "Modifs locales", icon: "edit" },
  { key: "ahead", label: "Non poussés", icon: "up" },
  { key: "noremote", label: "Sans remote", icon: "cloudoff" },
  { key: "settings", label: "Dossiers scannés", icon: "gear" },
];

// ---------- État ----------
const ROOTS_KEY = "dpm.roots";
let roots: string[] = [];
let projects: ProjectInfo[] = [];
let filter: Filter = "all";
let viewMode: ViewMode = "list";
let selectedPath: string | null = null;
let search = "";
let scanned = false;
let loading = false;
let scanToken = 0;
let sortBy: SortBy = "name";
let theme: Theme = "light";
const readmeCache = new Map<string, string | null>();
const commitsCache = new Map<string, CommitLog[]>();
const selection = new Set<string>();

// ---------- Helpers ----------
function $<T extends HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Élément introuvable: ${selector}`);
  return el;
}

function esc(value: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return value.replace(/[&<>"']/g, (c) => map[c] ?? c);
}

function cssEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  const units = ["Ko", "Mo", "Go", "To"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatRelative(unixSeconds: number): string {
  const days = Math.floor((Date.now() - unixSeconds * 1000) / 86_400_000);
  if (days <= 0) return "aujourd'hui";
  if (days === 1) return "hier";
  if (days < 30) return `il y a ${days} j`;
  const months = Math.floor(days / 30);
  if (months < 12) return `il y a ${months} mois`;
  const years = Math.floor(days / 365);
  return `il y a ${years} an${years > 1 ? "s" : ""}`;
}

function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}

function toast(kind: "ok" | "err" | "info", title: string, body = ""): void {
  const container = $("#toasts");
  const node = document.createElement("div");
  node.className = `toast ${kind}`;
  node.innerHTML = `<div class="toast-title">${esc(title)}</div>${
    body ? `<div class="toast-body">${esc(body)}</div>` : ""
  }`;
  container.appendChild(node);
  setTimeout(() => node.remove(), kind === "err" ? 8000 : 4000);
}

// ---------- Pont vers le backend ----------
// En dehors de Tauri (aperçu navigateur), les commandes Rust n'existent pas :
// on bascule sur un jeu de données de démo. Dans la vraie app, `IN_TAURI` est
// vrai et ce fallback n'est jamais utilisé.
const IN_TAURI = "__TAURI_INTERNALS__" in window;

const now = Math.floor(Date.now() / 1000);
const DEMO_PROJECTS: ProjectInfo[] = [
  { name: "veille-tech-pkm", path: "C:\\Users\\Corentin\\Desktop\\Dev\\veille-tech-pkm", stack: ["Node", "TypeScript"], branch: "master", hasRemote: true, remoteUrl: "https://github.com/CorentinG21/veille-tech-pkm.git", hasUpstream: true, isDirty: false, ahead: 0, behind: 0, lastCommit: now - 7200, safeToDelete: true, error: null, sizeBytes: 48 * 1024 * 1024 },
  { name: "dev-project-manager", path: "C:\\Users\\Corentin\\Desktop\\Dev\\dev-project-manager", stack: ["Rust", "Node", "TypeScript"], branch: "main", hasRemote: true, remoteUrl: "https://github.com/CorentinG21/dev-project-manager.git", hasUpstream: true, isDirty: true, ahead: 2, behind: 0, lastCommit: now - 3600, safeToDelete: false, error: null, sizeBytes: 220 * 1024 * 1024 },
  { name: "portfolio-astro", path: "C:\\Users\\Corentin\\Desktop\\Dev\\portfolio-astro", stack: ["Node", "TypeScript"], branch: "main", hasRemote: true, remoteUrl: "git@github.com:CorentinG21/portfolio-astro.git", hasUpstream: true, isDirty: false, ahead: 3, behind: 0, lastCommit: now - 86400 * 5, safeToDelete: false, error: null, sizeBytes: 90 * 1024 * 1024 },
  { name: "scripts-perso", path: "C:\\Users\\Corentin\\Documents\\scripts-perso", stack: ["Python"], branch: "master", hasRemote: false, remoteUrl: null, hasUpstream: false, isDirty: false, ahead: null, behind: null, lastCommit: now - 86400 * 40, safeToDelete: false, error: null, sizeBytes: 3 * 1024 * 1024 },
  { name: "api-fastapi-lab", path: "C:\\Users\\Corentin\\Desktop\\Dev\\api-fastapi-lab", stack: ["Python"], branch: "main", hasRemote: true, remoteUrl: "https://github.com/CorentinG21/api-fastapi-lab.git", hasUpstream: true, isDirty: false, ahead: 0, behind: 2, lastCommit: now - 86400 * 12, safeToDelete: true, error: null, sizeBytes: 15 * 1024 * 1024 },
  { name: "game-jam-2025", path: "C:\\Users\\Corentin\\Desktop\\Dev\\game-jam-2025", stack: ["Node"], branch: "dev", hasRemote: true, remoteUrl: "https://github.com/CorentinG21/game-jam-2025.git", hasUpstream: true, isDirty: true, ahead: 0, behind: 0, lastCommit: now - 86400 * 200, safeToDelete: false, error: null, sizeBytes: 512 * 1024 * 1024 },
];

const DEMO_README = `# {name}

Projet de démonstration affiché dans l'aperçu navigateur.

## Installation
\`\`\`
npm install
npm run dev
\`\`\`

## Fonctionnalités
- Point un
- Point deux

Dans la **vraie app Tauri**, c'est le vrai README du projet qui s'affiche ici.`;

function demoCall<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  if (cmd === "default_roots") {
    return Promise.resolve(["C:\\Users\\Corentin\\Desktop\\Dev (démo)"] as unknown as T);
  }
  if (cmd === "scan_projects") {
    return new Promise((res) =>
      setTimeout(() => res(DEMO_PROJECTS.map((p) => ({ ...p })) as unknown as T), 500),
    );
  }
  if (cmd === "project_size") {
    const p = DEMO_PROJECTS.find((d) => d.path === args.path);
    return Promise.resolve((p?.sizeBytes ?? 0) as unknown as T);
  }
  if (cmd === "pull_project") {
    return Promise.resolve("(démo) Already up to date." as unknown as T);
  }
  if (cmd === "read_readme") {
    const p = DEMO_PROJECTS.find((d) => d.path === args.path);
    return Promise.resolve(
      (p ? DEMO_README.replace("{name}", p.name) : null) as unknown as T,
    );
  }
  if (cmd === "pick_folder") {
    return Promise.resolve("C:\\Users\\Corentin\\Desktop\\Nouveau-dossier (démo)" as unknown as T);
  }
  if (cmd === "recent_commits") {
    return Promise.resolve([
      { hash: "a1b2c3d", summary: "Ajout de la vue dashboard", author: "Corentin", timestamp: now - 3600 },
      { hash: "e4f5a6b", summary: "Correction du scan récursif", author: "Corentin", timestamp: now - 86400 },
      { hash: "9c8d7e6", summary: "Mise à jour du README", author: "Corentin", timestamp: now - 86400 * 3 },
    ] as unknown as T);
  }
  if (cmd === "fetch_project" || cmd === "push_project") {
    const src = DEMO_PROJECTS.find((d) => d.path === args.path);
    if (!src) return Promise.resolve(undefined as unknown as T);
    const fresh: ProjectInfo = { ...src };
    if (cmd === "push_project") {
      fresh.hasRemote = true;
      fresh.hasUpstream = true;
      fresh.ahead = 0;
      fresh.safeToDelete = !fresh.isDirty;
    }
    return Promise.resolve(fresh as unknown as T);
  }
  return Promise.resolve(undefined as unknown as T);
}

function call<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  return IN_TAURI ? invoke<T>(cmd, args) : demoCall<T>(cmd, args);
}

// ---------- Dossiers racines ----------
function loadRootsFromStorage(): string[] | null {
  try {
    const raw = localStorage.getItem(ROOTS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function saveRoots(): void {
  try {
    localStorage.setItem(ROOTS_KEY, JSON.stringify(roots));
  } catch {
    /* non bloquant */
  }
}

function renderRoots(): void {
  const list = document.getElementById("roots-list");
  if (!list) return;
  list.innerHTML = roots
    .map(
      (r) =>
        `<div class="chip"><span title="${esc(r)}">${esc(
          r,
        )}</span><button data-action="remove-root" data-root="${esc(
          r,
        )}" title="Retirer">×</button></div>`,
    )
    .join("");
}

// ---------- Filtres ----------
function matchesFilter(p: ProjectInfo): boolean {
  switch (filter) {
    case "safe":
      return p.safeToDelete;
    case "dirty":
      return p.isDirty;
    case "ahead":
      return (p.ahead ?? 0) > 0;
    case "noremote":
      return !p.hasRemote;
    default:
      return true;
  }
}

function matchesSearch(p: ProjectInfo): boolean {
  if (!search) return true;
  const q = search.toLowerCase();
  return p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q);
}

function filtered(): ProjectInfo[] {
  return sortProjects(projects.filter((p) => matchesFilter(p) && matchesSearch(p)));
}

function sortProjects(list: ProjectInfo[]): ProjectInfo[] {
  const arr = [...list];
  switch (sortBy) {
    case "size":
      arr.sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
      break;
    case "commit":
      arr.sort((a, b) => (b.lastCommit ?? 0) - (a.lastCommit ?? 0));
      break;
    case "status": {
      const rank = (p: ProjectInfo) =>
        p.error
          ? 0
          : !p.hasRemote
            ? 1
            : p.isDirty || (p.ahead ?? 0) > 0 || !p.hasUpstream
              ? 2
              : p.safeToDelete
                ? 4
                : 3;
      arr.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
      break;
    }
    default:
      arr.sort((a, b) => a.name.localeCompare(b.name, "fr", { sensitivity: "base" }));
  }
  return arr;
}

function techChips(p: ProjectInfo, max = 3): string {
  if (!p.stack || p.stack.length === 0) return "";
  return p.stack
    .slice(0, max)
    .map((t) => `<span class="tech">${esc(t)}</span>`)
    .join("");
}

function projectByPath(path: string): ProjectInfo | undefined {
  return projects.find((p) => p.path === path);
}

function countFor(key: string): number {
  switch (key) {
    case "safe":
      return projects.filter((p) => p.safeToDelete).length;
    case "dirty":
      return projects.filter((p) => p.isDirty).length;
    case "ahead":
      return projects.filter((p) => (p.ahead ?? 0) > 0).length;
    case "noremote":
      return projects.filter((p) => !p.hasRemote).length;
    default:
      return projects.length;
  }
}

// ---------- Badges & libellés ----------
// Un badge de statut avec une infobulle explicative au survol (attribut title).
function badge(cls: string, text: string, tip: string): string {
  return `<span class="badge ${cls}" title="${esc(tip)}">${text}</span>`;
}

function statusBadges(p: ProjectInfo, compact = false): string {
  if (p.error) {
    return badge(
      "red",
      "Erreur Git",
      "Impossible de lire l'état Git de ce dépôt (corrompu ou inaccessible).",
    );
  }
  const b: string[] = [];
  if (!p.hasRemote) {
    b.push(
      badge(
        "red",
        "Sans remote",
        "Aucun dépôt distant configuré : le projet n'existe que sur ce PC, il n'est sauvegardé nulle part.",
      ),
    );
  } else if (!p.hasUpstream) {
    b.push(
      badge(
        "amber",
        "Jamais poussée",
        "Un remote existe, mais la branche courante n'y a jamais été envoyée (aucun git push).",
      ),
    );
  }
  if (p.isDirty) {
    b.push(
      badge(
        "amber",
        "Modifs locales",
        "Des fichiers modifiés ou nouveaux ne sont pas encore commités.",
      ),
    );
  }
  if ((p.ahead ?? 0) > 0) {
    b.push(
      badge(
        "amber",
        `${p.ahead} non poussé${p.ahead! > 1 ? "s" : ""}`,
        "Des commits faits sur ce PC ne sont pas encore envoyés sur le remote (git push).",
      ),
    );
  }
  if ((p.behind ?? 0) > 0 && !compact) {
    b.push(
      badge(
        "neutral",
        `${p.behind} en retard`,
        "Le remote a des commits que tu n'as pas encore récupérés (git pull).",
      ),
    );
  }
  if (p.safeToDelete) {
    b.push(
      badge(
        "green",
        "Sauvegardé",
        "Tout est commité et poussé sur le remote : suppression sans perte.",
      ),
    );
  }
  if (b.length === 0) {
    b.push(
      badge("green", "Propre", "Aucune modification en attente : le dossier de travail est propre."),
    );
  }
  return b.join("");
}

function unsafeReasons(p: ProjectInfo): string[] {
  if (p.error) return [`Erreur Git : ${p.error}`];
  const r: string[] = [];
  if (!p.hasRemote) r.push("aucun remote configuré");
  if (p.hasRemote && !p.hasUpstream) r.push("la branche courante n'a jamais été poussée");
  if (p.isDirty) r.push("des modifications ne sont pas commitées");
  if ((p.ahead ?? 0) > 0) r.push(`${p.ahead} commit(s) local(aux) non poussé(s)`);
  return r;
}

function currentTitle(): string {
  switch (filter) {
    case "safe":
      return "Projets supprimables";
    case "dirty":
      return "Modifs locales";
    case "ahead":
      return "Commits non poussés";
    case "noremote":
      return "Sans remote";
    default:
      return "Vue d'ensemble";
  }
}

function currentSubtitle(): string {
  switch (filter) {
    case "safe":
      return "Entièrement sauvegardés sur leur remote — sûrs à supprimer.";
    case "dirty":
      return "Des changements ne sont pas encore commités.";
    case "ahead":
      return "Du travail local pas encore poussé sur le remote.";
    case "noremote":
      return "⚠️ Ces projets ne sont sauvegardés nulle part.";
    default:
      return "Tous les projets Git détectés dans tes dossiers.";
  }
}

// ---------- Rendu : sidebar ----------
function renderNav(): void {
  const nav = $("#nav");
  const activeKey = viewMode === "settings" ? "settings" : filter;
  nav.innerHTML = NAV.map((item) => {
    const count =
      scanned && item.key !== "settings"
        ? `<span class="nav-count">${countFor(item.key)}</span>`
        : "";
    return `<button class="nav-item ${
      item.key === activeKey ? "is-active" : ""
    }" data-key="${item.key}">${icon(item.icon)}<span>${item.label}</span>${count}</button>`;
  }).join("");
}

function renderSideCard(): void {
  const card = $("#side-card");
  if (!scanned || projects.length === 0) {
    card.hidden = true;
    return;
  }
  const safe = projects.filter((p) => p.safeToDelete);
  const recover = safe.reduce((a, p) => a + (p.sizeBytes ?? 0), 0);
  card.hidden = false;
  card.innerHTML = `
    <div class="sc-label">Espace récupérable</div>
    <div class="sc-value" id="sc-value">${formatBytes(recover)}</div>
    <div class="sc-hint">${safe.length} projet${safe.length > 1 ? "s" : ""} supprimable${
      safe.length > 1 ? "s" : ""
    } en sécurité</div>`;
}

// ---------- Rendu : contenu ----------
function pageHead(title: string, subtitle: string): string {
  return `<div class="page-head"><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div>`;
}

function statsHtml(): string {
  const total = projects.length;
  const safe = projects.filter((p) => p.safeToDelete).length;
  const dirty = projects.filter((p) => p.isDirty).length;
  const sum = projects.reduce((a, p) => a + (p.sizeBytes ?? 0), 0);
  const card = (cls: string, ic: string, value: string, label: string, id = "") =>
    `<div class="stat"><div class="stat-icon ${cls}">${icon(
      ic,
    )}</div><div><div class="stat-value"${id ? ` id="${id}"` : ""}>${value}</div><div class="stat-label">${label}</div></div></div>`;
  return `<div class="stats">
    ${card("violet", "folder", String(total), "Projets trouvés")}
    ${card("green", "check", String(safe), "Supprimables")}
    ${card("amber", "edit", String(dirty), "Avec modifs locales")}
    ${card("blue", "disk", formatBytes(sum), "Espace total", "stat-size-value")}
  </div>`;
}

function rowHtml(p: ProjectInfo): string {
  const initial = p.name.charAt(0) || "?";
  const branch = p.branch
    ? `<span class="row-branch">${icon("branch")}${esc(p.branch)}</span>`
    : "";
  const size = p.sizeBytes !== undefined ? formatBytes(p.sizeBytes) : "…";
  const commit = p.lastCommit ? formatRelative(p.lastCommit) : "—";
  const selected = selection.has(p.path);
  return `
    <div class="row ${selected ? "is-selected" : ""}" data-path="${esc(p.path)}">
      <input type="checkbox" class="row-check" data-check="${esc(p.path)}"${
        selected ? " checked" : ""
      } title="Sélectionner ce projet" />
      <div class="row-avatar">${esc(initial)}</div>
      <div class="row-main">
        <div class="row-name">${esc(p.name)} ${branch}<span class="row-tech">${techChips(
          p,
          2,
        )}</span></div>
        <div class="row-path" title="${esc(p.path)}">${esc(p.path)}</div>
      </div>
      <div class="row-badges">${statusBadges(p, true)}</div>
      <div class="row-meta">
        <div class="row-size">${size}</div>
        <div>${esc(commit)}</div>
      </div>
      <div class="row-end">
        <button class="row-del" data-action="delete" data-path="${esc(
          p.path,
        )}" title="Supprimer (envoi à la corbeille)">${icon("trash")}</button>
        <span class="row-chevron">${icon("chevron")}</span>
      </div>
    </div>`;
}

function renderList(): void {
  const view = $("#view");
  if (projects.length === 0) {
    view.innerHTML = `
      ${pageHead("Vue d'ensemble", "Tous les projets Git détectés dans tes dossiers.")}
      <div class="state">
        <div class="state-icon">${icon("folder")}</div>
        <h2>Aucun projet Git trouvé</h2>
        <p>Aucun dépôt dans les dossiers scannés. Vérifie la liste dans « Dossiers scannés ».</p>
      </div>`;
    return;
  }
  const visible = filtered();
  const rows = visible.length
    ? visible.map(rowHtml).join("")
    : `<div class="state" style="padding:52px 20px"><p>Aucun projet ne correspond à ce filtre.</p></div>`;
  const chart =
    filter === "all"
      ? `<div class="panel chart-panel"><div class="panel-head"><h2>Répartition de l'espace disque</h2></div><div id="overview-chart">${chartBody()}</div></div>`
      : "";
  view.innerHTML = `
    ${pageHead(currentTitle(), currentSubtitle())}
    ${statsHtml()}
    ${chart}
    <div id="bulk-bar" class="bulk-bar" hidden></div>
    <div class="panel">
      <div class="panel-head">
        <h2>${visible.length} projet${visible.length > 1 ? "s" : ""}</h2>
        <div class="panel-head-right">
          <button class="btn btn-sm btn-ghost" data-action="select-all">Tout sélectionner</button>
          <select id="sort-select" class="sort-select">
            <option value="name"${sortBy === "name" ? " selected" : ""}>Trier : Nom</option>
            <option value="size"${sortBy === "size" ? " selected" : ""}>Trier : Taille</option>
            <option value="commit"${sortBy === "commit" ? " selected" : ""}>Trier : Dernier commit</option>
            <option value="status"${sortBy === "status" ? " selected" : ""}>Trier : Statut</option>
          </select>
        </div>
      </div>
      <div class="list">${rows}</div>
    </div>`;
  updateBulkBar();
}

function renderDetail(p: ProjectInfo): void {
  const view = $("#view");
  const initial = p.name.charAt(0) || "?";
  const safeBox = p.safeToDelete
    ? `<div class="safe-box ok">${icon(
        "shieldcheck",
      )}<div><strong>Suppression sûre</strong>Ce projet est intégralement sauvegardé sur son remote — tu peux le supprimer sans rien perdre.</div></div>`
    : `<div class="safe-box no">${icon(
        "alert",
      )}<div><strong>Pas entièrement sauvegardé</strong>${esc(
        unsafeReasons(p).join(" · ") || "état inconnu",
      )}. La suppression reste possible, mais ces éléments locaux seront perdus (récupérables dans la corbeille).</div></div>`;

  const cells: { k: string; v: string; mono?: boolean }[] = [
    { k: "Branche", v: p.branch ?? "—" },
    { k: "État du dossier", v: p.isDirty ? "Modifs non commitées" : "Propre" },
    { k: "Remote", v: p.hasRemote ? "Configuré" : "Aucun" },
    { k: "URL du remote", v: p.remoteUrl ?? "—", mono: true },
    { k: "Suivi distant", v: p.hasUpstream ? "Oui" : "Non" },
    { k: "Commits en avance", v: p.ahead === null ? "—" : String(p.ahead) },
    { k: "Commits en retard", v: p.behind === null ? "—" : String(p.behind) },
    {
      k: "Dernier commit",
      v: p.lastCommit ? `${formatDate(p.lastCommit)} (${formatRelative(p.lastCommit)})` : "—",
    },
  ];
  const cellsHtml = cells
    .map(
      (c) =>
        `<div class="info-cell"><div class="k">${esc(c.k)}</div><div class="v ${
          c.mono ? "mono" : ""
        }">${esc(c.v)}</div></div>`,
    )
    .join("");
  const sizeVal = p.sizeBytes !== undefined ? formatBytes(p.sizeBytes) : "calcul…";
  const sizeCell = `<div class="info-cell"><div class="k">Taille sur disque</div><div class="v mono" id="detail-size">${esc(
    sizeVal,
  )}</div></div>`;

  view.innerHTML = `
    <div class="detail-top">
      <button class="back-btn" data-action="back" title="Retour">${icon("back")}</button>
    </div>
    <div class="detail-hero">
      <div class="row-avatar">${esc(initial)}</div>
      <div class="detail-hero-info">
        <h1>${esc(p.name)}</h1>
        <div class="path">${esc(p.path)}</div>
        ${p.stack.length ? `<div class="tech-row">${techChips(p, 6)}</div>` : ""}
      </div>
      <div class="row-badges">${statusBadges(p)}</div>
    </div>
    ${safeBox}
    <div class="info-grid">${cellsHtml}${sizeCell}</div>
    <div class="readme-block">
      <div class="k">Aperçu du README</div>
      <div id="readme-section" class="readme-empty">Chargement…</div>
    </div>
    <div class="commits-block">
      <div class="k">Derniers commits</div>
      <div id="commits-section" class="commits-empty">Chargement…</div>
    </div>
    <div class="detail-actions">
      <button class="btn" data-action="editor" data-path="${esc(p.path)}">${icon(
        "code",
      )} VS Code</button>
      <button class="btn" data-action="open" data-path="${esc(p.path)}">${icon(
        "open",
      )} Ouvrir le dossier</button>
      ${
        githubWebUrl(p.remoteUrl)
          ? `<button class="btn" data-action="remote" data-path="${esc(p.path)}">${icon(
              "branch",
            )} GitHub</button>`
          : ""
      }
      ${
        p.hasRemote
          ? `<button class="btn" data-action="fetch" data-path="${esc(p.path)}">${icon(
              "refresh",
            )} Fetch</button>`
          : ""
      }
      ${
        p.hasRemote
          ? `<button class="btn" data-action="push" data-path="${esc(p.path)}">${icon(
              "up",
            )} Push</button>`
          : ""
      }
      <button class="btn" data-action="pull" data-path="${esc(p.path)}" ${
        p.hasUpstream ? "" : "disabled"
      }>${icon("pull")} Pull</button>
      <button class="btn btn-danger" data-action="delete" data-path="${esc(
        p.path,
      )}" title="Envoyer à la corbeille (local uniquement)">${icon("trash")} Supprimer</button>
    </div>`;
}

function renderSettings(): void {
  const view = $("#view");
  view.innerHTML = `
    ${pageHead(
      "Dossiers scannés",
      "Les dossiers racines explorés lors d'un scan. Les sous-dossiers lourds (node_modules, target…) et cachés sont ignorés automatiquement.",
    )}
    <div class="panel" style="padding:20px">
      <div class="chips" id="roots-list"></div>
      <form id="add-root-form" class="add-root">
        <input id="add-root-input" type="text" placeholder="Coller un chemin, ex. C:\\Users\\...\\Desktop\\Dev" autocomplete="off" />
        <button type="button" class="btn" data-action="browse">${icon(
          "folderplus",
        )} Parcourir…</button>
        <button type="submit" class="btn btn-primary">Ajouter</button>
      </form>
    </div>`;
  renderRoots();
  $<HTMLFormElement>("#add-root-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>("#add-root-input");
    const value = input.value.trim();
    if (value && !roots.includes(value)) {
      roots.push(value);
      saveRoots();
      renderRoots();
    }
    input.value = "";
  });
}

function renderWelcome(): void {
  $("#view").innerHTML = `
    ${pageHead(
      "Bienvenue 👋",
      "Retrouve tous tes projets Git, vérifie qu'ils sont bien sauvegardés, et fais le ménage en toute sécurité.",
    )}
    <div class="state">
      <div class="state-icon">${icon("grid")}</div>
      <h2>Aucun scan pour l'instant</h2>
      <p>Lance un scan pour lister tes projets. Les dossiers explorés sont configurables dans « Dossiers scannés ».</p>
      <button class="btn btn-primary" data-action="scan">${icon(
        "search",
      )}<span>Scanner mes projets</span></button>
    </div>`;
}

function renderLoading(): void {
  $("#view").innerHTML = `<div class="state"><div class="spinner"></div><h2>Scan en cours…</h2><p>Analyse des dépôts Git dans tes dossiers.</p></div>`;
}

function render(): void {
  renderNav();
  renderSideCard();
  if (viewMode === "settings") {
    renderSettings();
    return;
  }
  if (loading) {
    renderLoading();
    return;
  }
  if (!scanned) {
    renderWelcome();
    return;
  }
  if (viewMode === "detail") {
    const p = selectedPath ? projectByPath(selectedPath) : undefined;
    if (p) {
      renderDetail(p);
      return;
    }
    viewMode = "list";
  }
  renderList();
}

// ---------- Tailles (arrière-plan) ----------
function updateSizesDom(): void {
  const sum = projects.reduce((a, p) => a + (p.sizeBytes ?? 0), 0);
  const recover = projects
    .filter((p) => p.safeToDelete)
    .reduce((a, p) => a + (p.sizeBytes ?? 0), 0);
  const statEl = document.getElementById("stat-size-value");
  if (statEl) statEl.textContent = formatBytes(sum);
  const scEl = document.getElementById("sc-value");
  if (scEl) scEl.textContent = formatBytes(recover);
  const chartEl = document.getElementById("overview-chart");
  if (chartEl) chartEl.innerHTML = chartBody();
  for (const p of projects) {
    if (p.sizeBytes === undefined) continue;
    const cell = document.querySelector(
      `.row[data-path="${cssEscape(p.path)}"] .row-size`,
    );
    if (cell) cell.textContent = formatBytes(p.sizeBytes);
  }
  if (selectedPath) {
    const detailSize = document.getElementById("detail-size");
    const p = projectByPath(selectedPath);
    if (detailSize && p && p.sizeBytes !== undefined) {
      detailSize.textContent = formatBytes(p.sizeBytes);
    }
  }
}

async function fetchSizes(token: number): Promise<void> {
  for (const p of projects) {
    if (token !== scanToken) return;
    try {
      p.sizeBytes = await call<number>("project_size", { path: p.path });
    } catch {
      p.sizeBytes = 0;
    }
    if (token !== scanToken) return;
    updateSizesDom();
  }
}

// ---------- Scan ----------
function setScanBusy(busy: boolean): void {
  const btn = document.getElementById("scan-btn") as HTMLButtonElement | null;
  const label = document.querySelector(".btn-label");
  const refresh = document.getElementById("refresh-btn");
  if (btn) {
    btn.classList.toggle("is-loading", busy);
    btn.disabled = busy;
  }
  if (label) {
    label.textContent = busy
      ? "Scan en cours…"
      : scanned
        ? "Rescanner"
        : "Scanner mes projets";
  }
  if (refresh) refresh.classList.toggle("is-loading", busy);
}

async function scan(): Promise<void> {
  if (roots.length === 0) {
    toast("info", "Aucun dossier", "Ajoute un dossier dans « Dossiers scannés ».");
    viewMode = "settings";
    render();
    return;
  }
  loading = true;
  if (viewMode === "detail") viewMode = "list";
  setScanBusy(true);
  render();
  const token = ++scanToken;
  try {
    projects = await call<ProjectInfo[]>("scan_projects", { roots });
    scanned = true;
    loading = false;
    setScanBusy(false);
    render();
    fetchSizes(token);
  } catch (e) {
    loading = false;
    setScanBusy(false);
    render();
    toast("err", "Scan impossible", String(e));
  }
}

// ---------- Actions ----------
async function doOpen(p: ProjectInfo): Promise<void> {
  try {
    await call("open_folder", { path: p.path });
  } catch (e) {
    toast("err", "Ouverture impossible", String(e));
  }
}

async function doOpenEditor(p: ProjectInfo): Promise<void> {
  try {
    await call("open_in_editor", { path: p.path });
    toast("ok", `${p.name} ouvert dans VS Code`);
  } catch (e) {
    toast("err", "VS Code", String(e));
  }
}

async function browseFolder(): Promise<void> {
  try {
    const picked = await call<string | null>("pick_folder");
    if (picked && !roots.includes(picked)) {
      roots.push(picked);
      saveRoots();
      renderRoots();
    }
  } catch (e) {
    toast("err", "Sélecteur de dossier", String(e));
  }
}

async function doPull(p: ProjectInfo): Promise<void> {
  toast("info", `Pull de ${p.name}…`);
  try {
    const out = await call<string>("pull_project", { path: p.path });
    toast("ok", `${p.name} à jour`, out);
  } catch (e) {
    toast("err", `Échec du pull — ${p.name}`, String(e));
  }
}

// Remplace un projet par sa version réactualisée (renvoyée par fetch/push),
// en conservant la taille déjà calculée.
function mergeProject(fresh: ProjectInfo): void {
  const idx = projects.findIndex((p) => p.path === fresh.path);
  if (idx >= 0) {
    fresh.sizeBytes = projects[idx].sizeBytes;
    projects[idx] = fresh;
  }
}

async function doFetch(p: ProjectInfo): Promise<void> {
  toast("info", `Fetch de ${p.name}…`);
  try {
    const fresh = await call<ProjectInfo>("fetch_project", { path: p.path });
    mergeProject(fresh);
    render();
    toast("ok", `${p.name} : refs distantes à jour`);
  } catch (e) {
    toast("err", `Échec du fetch — ${p.name}`, String(e));
  }
}

async function doPush(p: ProjectInfo): Promise<void> {
  toast("info", `Push de ${p.name}…`);
  try {
    const fresh = await call<ProjectInfo>("push_project", { path: p.path });
    mergeProject(fresh);
    render();
    toast("ok", `${p.name} poussé sur le remote`);
  } catch (e) {
    toast("err", `Échec du push — ${p.name}`, String(e));
  }
}

// Déduit une URL web navigable depuis l'URL du remote (gère SSH et HTTPS).
function githubWebUrl(remoteUrl: string | null): string | null {
  if (!remoteUrl) return null;
  let u = remoteUrl.trim();
  const ssh = u.match(/^git@([^:]+):(.+)$/);
  if (ssh) u = `https://${ssh[1]}/${ssh[2]}`;
  u = u.replace(/\.git$/, "");
  return u.startsWith("http://") || u.startsWith("https://") ? u : null;
}

async function doOpenRemote(p: ProjectInfo): Promise<void> {
  const url = githubWebUrl(p.remoteUrl);
  if (!url) {
    toast("err", "Remote", "Impossible de déduire une URL web depuis le remote.");
    return;
  }
  try {
    await call("open_url", { url });
  } catch (e) {
    toast("err", "Ouverture du remote", String(e));
  }
}

// ---------- Derniers commits (fiche détail) ----------
async function loadCommits(path: string): Promise<void> {
  if (commitsCache.has(path)) {
    if (selectedPath === path) applyCommits(commitsCache.get(path) ?? []);
    return;
  }
  try {
    const commits = await call<CommitLog[]>("recent_commits", { path });
    commitsCache.set(path, commits);
    if (selectedPath === path) applyCommits(commits);
  } catch {
    if (selectedPath === path) applyCommits([]);
  }
}

function applyCommits(commits: CommitLog[]): void {
  const el = document.getElementById("commits-section");
  if (!el) return;
  if (!commits.length) {
    el.className = "commits-empty";
    el.textContent = "Aucun commit.";
    return;
  }
  el.className = "commits";
  el.innerHTML = commits
    .map(
      (c) =>
        `<div class="commit"><code class="commit-hash">${esc(
          c.hash,
        )}</code><div class="commit-main"><div class="commit-summary">${esc(
          c.summary,
        )}</div><div class="commit-meta">${esc(c.author)} · ${esc(
          formatRelative(c.timestamp),
        )}</div></div></div>`,
    )
    .join("");
}

// ---------- Graphique donut (espace disque) ----------
function chartBody(): string {
  const total = projects.reduce((a, p) => a + (p.sizeBytes ?? 0), 0);
  if (total === 0) return `<div class="chart-empty">Calcul de l'espace en cours…</div>`;
  const palette = ["#7b61ff", "#2563eb", "#16a34a", "#d97706", "#db2777", "#0d9488"];
  const sorted = [...projects]
    .filter((p) => (p.sizeBytes ?? 0) > 0)
    .sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
  const top = sorted.slice(0, 6);
  const topBytes = top.reduce((a, p) => a + (p.sizeBytes ?? 0), 0);
  const segments = top.map((p, i) => ({
    label: p.name,
    bytes: p.sizeBytes ?? 0,
    color: palette[i],
  }));
  const rest = total - topBytes;
  if (rest > 0) segments.push({ label: "Autres", bytes: rest, color: "#94a3b8" });

  let cumulative = 0;
  const circles = segments
    .map((s) => {
      const pct = (s.bytes / total) * 100;
      const circle = `<circle cx="21" cy="21" r="15.915" fill="none" stroke="${
        s.color
      }" stroke-width="5" stroke-dasharray="${pct.toFixed(3)} ${(100 - pct).toFixed(
        3,
      )}" stroke-dashoffset="${(25 - cumulative).toFixed(3)}"/>`;
      cumulative += pct;
      return circle;
    })
    .join("");
  const legend = segments
    .map(
      (s) =>
        `<div class="leg"><span class="leg-dot" style="background:${
          s.color
        }"></span><span class="leg-name">${esc(s.label)}</span><span class="leg-val">${formatBytes(
          s.bytes,
        )}</span></div>`,
    )
    .join("");
  return `<div class="chart"><svg viewBox="0 0 42 42" class="donut">${circles}<text x="21" y="21" class="donut-total">${formatBytes(
    total,
  )}</text></svg><div class="legend">${legend}</div></div>`;
}

// ---------- Sélection multiple ----------
function toggleSelection(path: string): void {
  if (selection.has(path)) selection.delete(path);
  else selection.add(path);
  syncRow(path);
  updateBulkBar();
}

function syncRow(path: string): void {
  const row = document.querySelector<HTMLElement>(`.row[data-path="${cssEscape(path)}"]`);
  if (!row) return;
  const checked = selection.has(path);
  row.classList.toggle("is-selected", checked);
  const cb = row.querySelector<HTMLInputElement>("input[data-check]");
  if (cb) cb.checked = checked;
}

function updateBulkBar(): void {
  const bar = document.getElementById("bulk-bar");
  if (!bar) return;
  const n = selection.size;
  if (n === 0) {
    bar.hidden = true;
    bar.innerHTML = "";
    return;
  }
  bar.hidden = false;
  bar.innerHTML = `
    <span class="bulk-count">${n} projet${n > 1 ? "s" : ""} sélectionné${n > 1 ? "s" : ""}</span>
    <div class="bulk-actions">
      <button class="btn btn-sm" data-action="bulk-pull">${icon("pull")} Pull</button>
      <button class="btn btn-sm btn-danger" data-action="bulk-delete">${icon(
        "trash",
      )} Supprimer (${n})</button>
      <button class="btn btn-sm btn-ghost" data-action="bulk-clear">Désélectionner</button>
    </div>`;
}

function selectAllVisible(): void {
  for (const p of filtered()) selection.add(p.path);
  render();
}

function clearSelection(): void {
  selection.clear();
  render();
}

function bulkPull(): void {
  const targets = [...selection]
    .map((p) => projectByPath(p))
    .filter((p): p is ProjectInfo => !!p && p.hasUpstream);
  if (!targets.length) {
    toast("info", "Pull", "Aucun projet sélectionné n'a de branche distante à mettre à jour.");
    return;
  }
  toast("info", `Pull de ${targets.length} projet(s)…`);
  void (async () => {
    let ok = 0;
    let fail = 0;
    for (const t of targets) {
      try {
        await call("pull_project", { path: t.path });
        ok++;
      } catch {
        fail++;
      }
    }
    toast(fail ? "err" : "ok", `Pull terminé : ${ok} OK${fail ? `, ${fail} échec(s)` : ""}`);
  })();
}

function bulkDelete(): void {
  const targets = [...selection]
    .map((p) => projectByPath(p))
    .filter((p): p is ProjectInfo => !!p);
  if (!targets.length) return;
  const unsafe = targets.filter((t) => !t.safeToDelete).length;
  const modal = $("#modal");
  const warning = unsafe
    ? `<div class="modal-warning">⚠️ ${unsafe} projet(s) sur ${targets.length} ne sont pas entièrement sauvegardés : leurs éléments locaux seront perdus (récupérables dans la corbeille).</div>`
    : "";
  $("#modal-body").innerHTML =
    `<strong>${targets.length}</strong> projet(s) seront déplacés vers la corbeille (local uniquement, GitHub n'est pas touché).` +
    warning;
  const confirmBtn = $<HTMLButtonElement>("#modal-confirm");
  const cancelBtn = $<HTMLButtonElement>("#modal-cancel");
  modal.hidden = false;
  const close = () => {
    modal.hidden = true;
    confirmBtn.onclick = null;
    cancelBtn.onclick = null;
  };
  cancelBtn.onclick = close;
  confirmBtn.onclick = async () => {
    close();
    let ok = 0;
    let fail = 0;
    for (const t of targets) {
      try {
        await call("delete_project", { path: t.path });
        projects = projects.filter((x) => x.path !== t.path);
        selection.delete(t.path);
        ok++;
      } catch {
        fail++;
      }
    }
    render();
    toast(fail ? "err" : "ok", `${ok} projet(s) envoyé(s) à la corbeille${fail ? `, ${fail} échec(s)` : ""}`);
  };
}

function askDelete(p: ProjectInfo): void {
  const modal = $("#modal");
  const reasons = p.safeToDelete ? [] : unsafeReasons(p);
  const warning = reasons.length
    ? `<div class="modal-warning">⚠️ Ce projet n'est <strong>pas entièrement sauvegardé</strong> : ${esc(
        reasons.join(" · "),
      )}. Ces éléments n'existent que sur ce PC et seront perdus (mais récupérables dans la corbeille).</div>`
    : "";
  $("#modal-body").innerHTML =
    `Le projet <strong>${esc(
      p.name,
    )}</strong> sera déplacé vers la corbeille de Windows (local uniquement, GitHub n'est pas touché).` +
    warning;
  const confirmBtn = $<HTMLButtonElement>("#modal-confirm");
  const cancelBtn = $<HTMLButtonElement>("#modal-cancel");
  modal.hidden = false;
  const close = () => {
    modal.hidden = true;
    confirmBtn.onclick = null;
    cancelBtn.onclick = null;
  };
  cancelBtn.onclick = close;
  confirmBtn.onclick = () => {
    close();
    performDelete(p);
  };
}

// Supprime réellement, avec retour visuel immédiat : animation de la ligne
// dans la liste, sinon retour à la liste depuis la fiche détail.
async function performDelete(p: ProjectInfo): Promise<void> {
  try {
    await call("delete_project", { path: p.path });
  } catch (e) {
    toast("err", `Suppression impossible — ${p.name}`, String(e));
    return;
  }
  toast("ok", `${p.name} envoyé à la corbeille`);

  const row =
    viewMode === "list"
      ? document.querySelector<HTMLElement>(`.row[data-path="${cssEscape(p.path)}"]`)
      : null;

  if (row) {
    row.classList.add("row--removing");
    window.setTimeout(() => {
      projects = projects.filter((x) => x.path !== p.path);
      render();
    }, 260);
  } else {
    projects = projects.filter((x) => x.path !== p.path);
    if (viewMode === "detail") viewMode = "list";
    render();
  }
}

function openDetail(path: string): void {
  selectedPath = path;
  viewMode = "detail";
  render();
  loadReadme(path);
  loadCommits(path);
}

async function loadReadme(path: string): Promise<void> {
  if (readmeCache.has(path)) {
    if (selectedPath === path) applyReadme(readmeCache.get(path) ?? null);
    return;
  }
  try {
    const md = await call<string | null>("read_readme", { path });
    readmeCache.set(path, md);
    if (selectedPath === path) applyReadme(md);
  } catch {
    if (selectedPath === path) applyReadme(null);
  }
}

function applyReadme(md: string | null): void {
  const section = document.getElementById("readme-section");
  if (!section) return;
  if (md && md.trim()) {
    section.className = "readme";
    section.innerHTML = renderReadme(md);
  } else {
    section.className = "readme-empty";
    section.textContent = "Pas de README dans ce projet.";
  }
}

// Rendu markdown minimal et sûr (on échappe d'abord, puis on stylise).
function renderReadme(md: string): string {
  return esc(md)
    .replace(/^#{1,6}\s*(.*)$/gm, "<strong>$1</strong>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function onAction(btn: HTMLElement): void {
  const action = btn.dataset.action;
  if (action === "back") {
    viewMode = "list";
    render();
    return;
  }
  if (action === "scan") {
    scan();
    return;
  }
  if (action === "browse") {
    browseFolder();
    return;
  }
  if (action === "select-all") {
    selectAllVisible();
    return;
  }
  if (action === "bulk-clear") {
    clearSelection();
    return;
  }
  if (action === "bulk-pull") {
    bulkPull();
    return;
  }
  if (action === "bulk-delete") {
    bulkDelete();
    return;
  }
  if (action === "remove-root") {
    const root = btn.dataset.root;
    if (root) {
      roots = roots.filter((r) => r !== root);
      saveRoots();
      renderRoots();
    }
    return;
  }
  const path = btn.dataset.path;
  if (!path) return;
  const p = projectByPath(path);
  if (!p) return;
  if (action === "open") doOpen(p);
  else if (action === "editor") doOpenEditor(p);
  else if (action === "pull") doPull(p);
  else if (action === "fetch") doFetch(p);
  else if (action === "push") doPush(p);
  else if (action === "remote") doOpenRemote(p);
  else if (action === "delete") askDelete(p);
}

// ---------- Thème ----------
function applyTheme(t: Theme): void {
  theme = t;
  document.documentElement.dataset.theme = t;
  const btn = document.getElementById("theme-btn");
  if (btn) btn.innerHTML = icon(t === "dark" ? "sun" : "moon");
  try {
    localStorage.setItem("dpm.theme", t);
  } catch {
    /* non bloquant */
  }
}

function initTheme(): void {
  let saved: Theme = "light";
  try {
    const s = localStorage.getItem("dpm.theme");
    if (s === "dark" || s === "light") saved = s;
  } catch {
    /* non bloquant */
  }
  applyTheme(saved);
}

// ---------- Init ----------
async function init(): Promise<void> {
  $("#search-box").innerHTML = `${icon(
    "search",
  )}<input id="search" type="search" placeholder="Rechercher un projet…" autocomplete="off" />`;
  $("#refresh-btn").innerHTML = icon("refresh");
  initTheme();
  $("#theme-btn").addEventListener("click", () =>
    applyTheme(theme === "dark" ? "light" : "dark"),
  );

  const stored = loadRootsFromStorage();
  if (stored && stored.length > 0) {
    roots = stored;
  } else {
    try {
      roots = await call<string[]>("default_roots");
    } catch {
      roots = [];
    }
    saveRoots();
  }

  $("#scan-btn").addEventListener("click", scan);
  $("#refresh-btn").addEventListener("click", scan);

  $("#search").addEventListener("input", (e) => {
    search = (e.target as HTMLInputElement).value;
    if (viewMode === "list") render();
  });

  $("#nav").addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>(".nav-item");
    if (!btn || !btn.dataset.key) return;
    const key = btn.dataset.key;
    if (key === "settings") {
      viewMode = "settings";
    } else {
      viewMode = "list";
      filter = key as Filter;
    }
    render();
  });

  $("#view").addEventListener("click", (e) => {
    const el = e.target as HTMLElement;
    const check = el.closest<HTMLInputElement>("input[data-check]");
    if (check?.dataset.check) {
      toggleSelection(check.dataset.check);
      return;
    }
    const actionBtn = el.closest<HTMLElement>("[data-action]");
    if (actionBtn) {
      onAction(actionBtn);
      return;
    }
    const row = el.closest<HTMLElement>(".row");
    if (row?.dataset.path) openDetail(row.dataset.path);
  });

  $("#view").addEventListener("change", (e) => {
    const el = e.target as HTMLElement;
    if (el.id === "sort-select") {
      sortBy = (el as HTMLSelectElement).value as SortBy;
      render();
    }
  });

  // Détection automatique au démarrage si des dossiers sont déjà connus.
  if (roots.length > 0) {
    scan();
  } else {
    render();
  }
}

init();
