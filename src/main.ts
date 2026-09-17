import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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
  modifiedFiles: number;
  untrackedFiles: number;
  stashCount: number;
  riskLevel: "safe" | "attention" | "risk" | "critical";
  safeToDelete: boolean;
  error: string | null;
  // Vrai si le dernier fetch/push tenté a échoué (remote supprimé, accès
  // révoqué...) : ahead/behind/hasUpstream ne reflètent alors que le dernier
  // état connu en cache, pas la réalité actuelle. Ne reflète que le dernier
  // essai — un simple rescan (sans réseau) le remet à faux.
  remoteUnreachable: boolean;
  remoteError: string | null;
  sizeBytes?: number; // renseigné en arrière-plan
}

interface CommitLog {
  hash: string;
  summary: string;
  author: string;
  timestamp: number;
}

interface CleanableEntry {
  name: string;
  path: string;
  sizeBytes: number;
}

interface CleanOutcome {
  path: string;
  ok: boolean;
  error: string | null;
}

interface ProjectMeta {
  favorite: boolean;
  tags: string[];
  note: string;
}

interface LargeFile {
  path: string;
  sizeBytes: number;
}

interface SecretFinding {
  location: string;
  reason: string;
}

interface FilesInsight {
  largeFiles: LargeFile[];
  secrets: SecretFinding[];
}

interface ToolCheck {
  name: string;
  installed: boolean;
  version: string | null;
}

interface BranchInfo {
  name: string;
  isCurrent: boolean;
  hasUpstream: boolean;
  ahead: number | null;
  behind: number | null;
}

interface RepoInsights {
  branches: BranchInfo[];
  totalCommits: number;
}

interface FileStatusEntry {
  path: string;
  status: "new" | "modified" | "deleted" | "renamed" | "typechange" | "conflicted";
}

interface ArchiveEntry {
  name: string;
  path: string;
  remoteUrl: string | null;
  sizeBytes: number;
  archivedAt: number;
}

interface IdeaItem {
  id: string;
  text: string;
  createdAt: number;
}

type Filter =
  | "all"
  | "safe"
  | "dirty"
  | "ahead"
  | "noremote"
  | "favorites"
  | "inactive"
  | "duplicates";
type ViewMode = "list" | "detail" | "settings" | "archives" | "ideas";
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
  star: `<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>`,
  clock: `<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>`,
  broom: `<path d="M4 20l4-4"/><path d="M13.5 6.5 21 14l-3 3-7.5-7.5"/><path d="M3 21l3-8 5 5z"/><path d="M13.5 6.5 17 3l4 4-3.5 3.5"/>`,
  tag: `<path d="M20.59 13.41 13.42 20.6a2 2 0 0 1-2.83 0L2.5 12.5V2.5h10L20.59 10.6a2 2 0 0 1 0 2.82Z"/><circle cx="7" cy="7" r="1"/>`,
  copy: `<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>`,
  archive: `<polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/>`,
  bulb: `<path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.6c.6.5 1 1.2 1 2.4h6c0-1.2.4-1.9 1-2.4A7 7 0 0 0 12 2z"/>`,
  lock: `<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>`,
  cpu: `<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/>`,
  command: `<path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"/>`,
  fileText: `<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/>`,
  bell: `<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>`,
};

function icon(name: string): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${
    ICONS[name] ?? ""
  }</svg>`;
}

const NAV: { key: string; label: string; icon: string }[] = [
  { key: "all", label: "Vue d'ensemble", icon: "grid" },
  { key: "favorites", label: "Favoris", icon: "star" },
  { key: "safe", label: "Supprimables", icon: "check" },
  { key: "dirty", label: "Modifs locales", icon: "edit" },
  { key: "ahead", label: "Non poussés", icon: "up" },
  { key: "noremote", label: "Sans remote", icon: "cloudoff" },
  { key: "inactive", label: "Inactifs", icon: "clock" },
  { key: "duplicates", label: "Doublons", icon: "copy" },
  { key: "archives", label: "Archives", icon: "archive" },
  { key: "ideas", label: "Idées", icon: "bulb" },
  { key: "settings", label: "Dossiers scannés", icon: "gear" },
];

// Seuil d'inactivité : au-delà, un projet est considéré "oublié".
const INACTIVE_DAYS = 90;

function isInactive(p: ProjectInfo): boolean {
  if (p.lastCommit === null) return true;
  const days = (Date.now() / 1000 - p.lastCommit) / 86_400;
  return days > INACTIVE_DAYS;
}

// ---------- Doublons (même remote cloné à plusieurs endroits) ----------
// Normalise une URL de remote pour comparer SSH/HTTPS/casse/.git final de
// façon fiable (réutilise la même logique que githubWebUrl, en plus permissif).
function normalizeRemote(url: string | null): string | null {
  if (!url) return null;
  let u = url.trim().toLowerCase();
  const ssh = u.match(/^git@([^:]+):(.+)$/);
  if (ssh) u = `${ssh[1]}/${ssh[2]}`;
  u = u.replace(/^https?:\/\//, "").replace(/\.git$/, "");
  return u;
}

// Regroupe les projets par remote normalisé ; ne garde que les groupes de 2+.
// Mémoïsé sur l'identité du tableau `projects` : cette fonction est appelée
// une fois par ligne à chaque rendu (via duplicatesOf/statusBadges), donc la
// recalculer à chaque fois transformerait le rendu de la liste en O(n²).
// `projects` n'est réassigné (nouvelle référence) que lors d'un scan ou d'une
// suppression/filtre - les seuls moments où l'appartenance aux groupes peut
// changer - donc comparer par référence suffit à invalider le cache.
let dupGroupsCacheKey: ProjectInfo[] | null = null;
let dupGroupsCache: Map<string, ProjectInfo[]> | null = null;
function duplicateGroups(): Map<string, ProjectInfo[]> {
  if (dupGroupsCacheKey === projects && dupGroupsCache) return dupGroupsCache;
  const groups = new Map<string, ProjectInfo[]>();
  for (const p of projects) {
    const key = normalizeRemote(p.remoteUrl);
    if (!key) continue;
    const arr = groups.get(key) ?? [];
    arr.push(p);
    groups.set(key, arr);
  }
  for (const [key, arr] of groups) {
    if (arr.length < 2) groups.delete(key);
  }
  dupGroupsCacheKey = projects;
  dupGroupsCache = groups;
  return groups;
}

function duplicatesOf(p: ProjectInfo): ProjectInfo[] {
  const key = normalizeRemote(p.remoteUrl);
  if (!key) return [];
  const group = duplicateGroups().get(key);
  return group ? group.filter((x) => x.path !== p.path) : [];
}

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
const cleanableCache = new Map<string, CleanableEntry[]>();
const insightCache = new Map<string, FilesInsight>();
const branchesCache = new Map<string, RepoInsights>();
const fileStatusCache = new Map<string, FileStatusEntry[]>();
const selection = new Set<string>();
let toolsCache: ToolCheck[] | null = null;

// ---------- Archives (projets supprimés délibérément, mémoire locale) ----------
const ARCHIVES_KEY = "dpm.archives";
let archives: ArchiveEntry[] = [];

function loadArchives(): void {
  try {
    const raw = localStorage.getItem(ARCHIVES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    archives = Array.isArray(parsed) ? parsed : [];
  } catch {
    archives = [];
  }
}

function saveArchives(): void {
  try {
    localStorage.setItem(ARCHIVES_KEY, JSON.stringify(archives));
  } catch {
    /* non bloquant */
  }
}

// ---------- Idées de projets (backlog personnel, sur la vue d'ensemble) ----------
const IDEAS_KEY = "dpm.ideas";
let ideas: IdeaItem[] = [];

function loadIdeas(): void {
  try {
    const raw = localStorage.getItem(IDEAS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    ideas = Array.isArray(parsed) ? parsed : [];
  } catch {
    ideas = [];
  }
}

function saveIdeas(): void {
  try {
    localStorage.setItem(IDEAS_KEY, JSON.stringify(ideas));
  } catch {
    /* non bloquant */
  }
}

function addIdea(text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  ideas.unshift({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text: trimmed, createdAt: Date.now() });
  saveIdeas();
}

function removeIdea(id: string): void {
  ideas = ideas.filter((i) => i.id !== id);
  saveIdeas();
}

// ---------- Métadonnées locales (favoris, tags, notes) ----------
// Purement côté UI : ne dépend pas du backend, persistée par chemin de projet.
const META_KEY = "dpm.meta";
let metaStore: Record<string, ProjectMeta> = {};

function loadMeta(): void {
  try {
    const raw = localStorage.getItem(META_KEY);
    metaStore = raw ? JSON.parse(raw) : {};
  } catch {
    metaStore = {};
  }
}

function saveMeta(): void {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(metaStore));
  } catch {
    /* non bloquant */
  }
}

function getMeta(path: string): ProjectMeta {
  return metaStore[path] ?? { favorite: false, tags: [], note: "" };
}

function updateMeta(path: string, patch: Partial<ProjectMeta>): void {
  metaStore[path] = { ...getMeta(path), ...patch };
  saveMeta();
}
let renderScheduled = false;

// Pendant un scan, des dizaines de projets peuvent arriver en quelques
// millisecondes (évènements "project-found") : on regroupe les rendus au
// lieu de redessiner toute la liste à chaque évènement.
function scheduleRender(): void {
  if (renderScheduled) return;
  renderScheduled = true;
  setTimeout(() => {
    renderScheduled = false;
    render();
  }, 150);
}

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

// Retour visuel générique pour toute action déclenchée par un bouton :
// désactive le bouton et fait tourner son icône pendant l'appel, restaure
// son état d'origine ensuite (succès ou échec). Utilisé pour toutes les
// actions asynchrones (pull, push, fetch, suppression, nettoyage...) afin
// qu'on voie toujours qu'une action est en cours, pas seulement le toast.
async function withBusyButton<T>(btn: HTMLElement, fn: () => Promise<T>): Promise<T> {
  const original = btn.innerHTML;
  const asButton = "disabled" in btn ? (btn as HTMLButtonElement) : null;
  if (asButton) asButton.disabled = true;
  btn.classList.add("is-busy");
  btn.innerHTML = icon("refresh");
  try {
    return await fn();
  } finally {
    if (asButton) asButton.disabled = false;
    btn.classList.remove("is-busy");
    btn.innerHTML = original;
  }
}

// ---------- Pont vers le backend ----------
// En dehors de Tauri (aperçu navigateur), les commandes Rust n'existent pas :
// on bascule sur un jeu de données de démo. Dans la vraie app, `IN_TAURI` est
// vrai et ce fallback n'est jamais utilisé.
const IN_TAURI = "__TAURI_INTERNALS__" in window;

const now = Math.floor(Date.now() / 1000);
const DEMO_PROJECTS: ProjectInfo[] = [
  { name: "veille-tech-pkm", path: "C:\\Users\\Corentin\\Desktop\\Dev\\veille-tech-pkm", stack: ["Node", "TypeScript"], branch: "master", hasRemote: true, remoteUrl: "https://github.com/CorentinG21/veille-tech-pkm.git", hasUpstream: true, isDirty: false, ahead: 0, behind: 0, lastCommit: now - 7200, modifiedFiles: 0, untrackedFiles: 0, stashCount: 0, riskLevel: "safe", safeToDelete: true, error: null, remoteUnreachable: false, remoteError: null, sizeBytes: 48 * 1024 * 1024 },
  { name: "dev-project-manager", path: "C:\\Users\\Corentin\\Desktop\\Dev\\dev-project-manager", stack: ["Rust", "Node", "TypeScript"], branch: "main", hasRemote: true, remoteUrl: "https://github.com/CorentinG21/dev-project-manager.git", hasUpstream: true, isDirty: true, ahead: 2, behind: 0, lastCommit: now - 3600, modifiedFiles: 3, untrackedFiles: 1, stashCount: 1, riskLevel: "risk", safeToDelete: false, error: null, remoteUnreachable: false, remoteError: null, sizeBytes: 1150 * 1024 * 1024 },
  { name: "portfolio-astro", path: "C:\\Users\\Corentin\\Desktop\\Dev\\portfolio-astro", stack: ["Node", "TypeScript"], branch: "main", hasRemote: true, remoteUrl: "git@github.com:CorentinG21/portfolio-astro.git", hasUpstream: true, isDirty: false, ahead: 3, behind: 0, lastCommit: now - 86400 * 5, modifiedFiles: 0, untrackedFiles: 0, stashCount: 0, riskLevel: "risk", safeToDelete: false, error: null, remoteUnreachable: false, remoteError: null, sizeBytes: 90 * 1024 * 1024 },
  { name: "scripts-perso", path: "C:\\Users\\Corentin\\Documents\\scripts-perso", stack: ["Python"], branch: "master", hasRemote: false, remoteUrl: null, hasUpstream: false, isDirty: false, ahead: null, behind: null, lastCommit: now - 86400 * 400, modifiedFiles: 0, untrackedFiles: 0, stashCount: 0, riskLevel: "critical", safeToDelete: false, error: null, remoteUnreachable: false, remoteError: null, sizeBytes: 3 * 1024 * 1024 },
  { name: "api-fastapi-lab", path: "C:\\Users\\Corentin\\Desktop\\Dev\\api-fastapi-lab", stack: ["Python"], branch: "main", hasRemote: true, remoteUrl: "https://github.com/CorentinG21/api-fastapi-lab.git", hasUpstream: true, isDirty: false, ahead: 0, behind: 2, lastCommit: now - 86400 * 120, modifiedFiles: 0, untrackedFiles: 0, stashCount: 0, riskLevel: "safe", safeToDelete: true, error: null, remoteUnreachable: false, remoteError: null, sizeBytes: 15 * 1024 * 1024 },
  { name: "game-jam-2025", path: "C:\\Users\\Corentin\\Desktop\\Dev\\game-jam-2025", stack: ["Node"], branch: "dev", hasRemote: true, remoteUrl: "https://github.com/CorentinG21/game-jam-2025.git", hasUpstream: true, isDirty: true, ahead: 0, behind: 0, lastCommit: now - 86400 * 200, modifiedFiles: 2, untrackedFiles: 4, stashCount: 0, riskLevel: "attention", safeToDelete: false, error: null, remoteUnreachable: false, remoteError: null, sizeBytes: 512 * 1024 * 1024 },
];

// Contenu simulé pour l'analyse de nettoyage (aperçu navigateur uniquement).
const DEMO_CLEANABLE: Record<string, CleanableEntry[]> = {
  "C:\\Users\\Corentin\\Desktop\\Dev\\dev-project-manager": [
    { name: "node_modules", path: "C:\\...\\dev-project-manager\\node_modules", sizeBytes: 180 * 1024 * 1024 },
    { name: "target", path: "C:\\...\\dev-project-manager\\src-tauri\\target", sizeBytes: 900 * 1024 * 1024 },
  ],
  "C:\\Users\\Corentin\\Desktop\\Dev\\game-jam-2025": [
    { name: "node_modules", path: "C:\\...\\game-jam-2025\\node_modules", sizeBytes: 310 * 1024 * 1024 },
    { name: "dist", path: "C:\\...\\game-jam-2025\\dist", sizeBytes: 40 * 1024 * 1024 },
  ],
  "C:\\Users\\Corentin\\Desktop\\Dev\\portfolio-astro": [
    { name: "node_modules", path: "C:\\...\\portfolio-astro\\node_modules", sizeBytes: 75 * 1024 * 1024 },
  ],
};

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
  if (cmd === "scan_cleanable") {
    const entries = DEMO_CLEANABLE[args.path as string] ?? [];
    return new Promise((res) => setTimeout(() => res(entries as unknown as T), 400));
  }
  if (cmd === "clean_paths") {
    const paths = args.paths as string[];
    const outcomes: CleanOutcome[] = paths.map((path) => ({ path, ok: true, error: null }));
    return Promise.resolve(outcomes as unknown as T);
  }
  if (cmd === "fetch_project" || cmd === "push_project" || cmd === "secure_project") {
    const src = DEMO_PROJECTS.find((d) => d.path === args.path);
    if (!src) return Promise.resolve(undefined as unknown as T);
    const fresh: ProjectInfo = { ...src };
    if (cmd === "push_project" || cmd === "secure_project") {
      fresh.hasRemote = true;
      fresh.hasUpstream = true;
      fresh.ahead = 0;
      if (cmd === "secure_project") {
        fresh.isDirty = false;
        fresh.modifiedFiles = 0;
        fresh.untrackedFiles = 0;
      }
      fresh.riskLevel = fresh.isDirty || fresh.stashCount > 0 ? "attention" : "safe";
      fresh.safeToDelete = fresh.riskLevel === "safe";
    }
    return Promise.resolve(fresh as unknown as T);
  }
  if (cmd === "scan_files_insight") {
    const p = args.path as string;
    const insight: FilesInsight =
      p === "C:\\Users\\Corentin\\Desktop\\Dev\\dev-project-manager"
        ? {
            largeFiles: [{ path: `${p}\\assets\\demo-video.mp4`, sizeBytes: 42 * 1024 * 1024 }],
            secrets: [{ location: `${p}\\.env (ligne 3)`, reason: "Clé API potentielle" }],
          }
        : { largeFiles: [], secrets: [] };
    return new Promise((res) => setTimeout(() => res(insight as unknown as T), 400));
  }
  if (cmd === "repo_insights") {
    const src = DEMO_PROJECTS.find((d) => d.path === args.path);
    const insights: RepoInsights = {
      branches: [
        {
          name: src?.branch ?? "main",
          isCurrent: true,
          hasUpstream: src?.hasUpstream ?? false,
          ahead: src?.ahead ?? 0,
          behind: src?.behind ?? 0,
        },
        { name: "feature/demo", isCurrent: false, hasUpstream: false, ahead: null, behind: null },
      ],
      totalCommits: 42,
    };
    return new Promise((res) => setTimeout(() => res(insights as unknown as T), 400));
  }
  if (cmd === "file_status") {
    const src = DEMO_PROJECTS.find((d) => d.path === args.path);
    if (!src || (!src.isDirty && src.untrackedFiles === 0)) {
      return Promise.resolve([] as unknown as T);
    }
    const entries: FileStatusEntry[] = [
      { path: "src/main.ts", status: "modified" },
      { path: "src/new-feature.ts", status: "new" },
    ];
    return Promise.resolve(entries as unknown as T);
  }
  if (cmd === "check_tools") {
    const tools: ToolCheck[] = [
      { name: "Git", installed: true, version: "git version 2.51.0" },
      { name: "Node.js", installed: true, version: "v24.11.1" },
      { name: "Rust (cargo)", installed: true, version: "cargo 1.96.0" },
      { name: "Python", installed: true, version: "Python 3.13.1" },
      { name: "Docker", installed: false, version: null },
      { name: "VS Code", installed: true, version: "1.97.0" },
    ];
    return new Promise((res) => setTimeout(() => res(tools as unknown as T), 400));
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
    case "favorites":
      return getMeta(p.path).favorite;
    case "inactive":
      return isInactive(p);
    case "duplicates":
      return duplicatesOf(p).length > 0;
    default:
      return true;
  }
}

// Recherche : par défaut sur nom/chemin/branche/stack/tags/note. Préfixes
// dédiés pour cibler un seul champ : tag:, stack:, note:.
function matchesSearch(p: ProjectInfo): boolean {
  if (!search) return true;
  const q = search.trim().toLowerCase();
  const meta = getMeta(p.path);

  const prefixed = q.match(/^(tag|stack|note):(.*)$/);
  if (prefixed) {
    const [, field, value] = prefixed;
    const needle = value.trim();
    if (!needle) return true;
    if (field === "tag") return meta.tags.some((t) => t.toLowerCase().includes(needle));
    if (field === "stack") return p.stack.some((s) => s.toLowerCase().includes(needle));
    if (field === "note") return meta.note.toLowerCase().includes(needle);
  }

  return (
    p.name.toLowerCase().includes(q) ||
    p.path.toLowerCase().includes(q) ||
    (p.branch ?? "").toLowerCase().includes(q) ||
    p.stack.some((s) => s.toLowerCase().includes(q)) ||
    meta.tags.some((t) => t.toLowerCase().includes(q)) ||
    meta.note.toLowerCase().includes(q) ||
    (p.remoteUrl ?? "").toLowerCase().includes(q)
  );
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
    case "favorites":
      return projects.filter((p) => getMeta(p.path).favorite).length;
    case "inactive":
      return projects.filter(isInactive).length;
    case "duplicates":
      return projects.filter((p) => duplicatesOf(p).length > 0).length;
    case "archives":
      return archives.length;
    case "ideas":
      return ideas.length;
    default:
      return projects.length;
  }
}

// ---------- Badges & libellés ----------
// Un badge de statut avec une infobulle explicative au survol (attribut
// title). Fond neutre unique : seule la pastille (`dotCls`) porte le sens
// (risque, statut...), pour éviter d'empiler plusieurs signaux redondants.
function badge(dotCls: string, text: string, tip: string): string {
  return `<span class="badge" title="${esc(tip)}"><span class="badge-dot ${dotCls}"></span>${text}</span>`;
}

// Niveau de risque global (4 paliers) : le premier repère visuel avant même
// de lire le détail des badges.
const RISK_META: Record<
  ProjectInfo["riskLevel"],
  { label: string; dotCls: string; tip: string }
> = {
  safe: {
    label: "Sûr",
    dotCls: "green",
    tip: "Tout est commité et poussé sur le remote : rien ne serait perdu.",
  },
  attention: {
    label: "Attention",
    dotCls: "amber",
    tip: "Tout est poussé, mais du travail local (modifs, stash) n'est pas encore commité.",
  },
  risk: {
    label: "Risque",
    dotCls: "orange",
    tip: "Des commits ne sont pas encore poussés sur le remote : ils seraient perdus.",
  },
  critical: {
    label: "Critique",
    dotCls: "red",
    tip: "Ce projet n'est sauvegardé nulle part ailleurs que sur ce PC.",
  },
};

function riskBadge(p: ProjectInfo): string {
  const meta = RISK_META[p.riskLevel] ?? RISK_META.critical;
  return `<span class="badge risk-pill" title="${esc(meta.tip)}"><span class="badge-dot ${meta.dotCls}"></span>${meta.label}</span>`;
}

function statusBadges(p: ProjectInfo, compact = false): string {
  if (p.error) {
    return badge(
      "red",
      "Erreur Git",
      "Impossible de lire l'état Git de ce dépôt (corrompu ou inaccessible).",
    );
  }
  const b: string[] = [riskBadge(p)];
  if (isInactive(p)) {
    b.push(
      badge(
        "neutral",
        "Inactif",
        `Aucun commit depuis plus de ${INACTIVE_DAYS} jours.`,
      ),
    );
  }
  const dups = duplicatesOf(p);
  if (dups.length > 0) {
    b.push(
      badge(
        "neutral",
        `Cloné ×${dups.length + 1}`,
        `Le même remote existe aussi dans : ${dups.map((d) => d.path).join(" · ")}`,
      ),
    );
  }
  if (p.remoteUnreachable) {
    b.push(
      badge(
        "red",
        "Remote injoignable",
        p.remoteError
          ? `Le dernier fetch/push a échoué : ${p.remoteError}`
          : "Le remote configuré ne répond plus (dépôt supprimé, accès révoqué...).",
      ),
    );
  }
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
  return b.join("");
}

// Détail itemisé de ce qui serait perdu - c'est ce qui s'affiche dans la
// fiche projet et dans la modale de confirmation avant suppression.
function unsafeReasons(p: ProjectInfo): string[] {
  if (p.error) return [`Erreur Git : ${p.error}`];
  const r: string[] = [];
  if (p.remoteUnreachable) {
    r.push(
      `remote injoignable au dernier essai (${p.remoteError ?? "dépôt supprimé ou accès révoqué"})`,
    );
  }
  if (!p.hasRemote) r.push("aucun remote configuré");
  if (p.hasRemote && !p.hasUpstream) r.push("la branche courante n'a jamais été poussée");
  if ((p.ahead ?? 0) > 0) r.push(`${p.ahead} commit(s) local(aux) non poussé(s)`);
  if (p.modifiedFiles > 0) {
    r.push(`${p.modifiedFiles} fichier(s) modifié(s) non commité(s)`);
  }
  if (p.untrackedFiles > 0) {
    r.push(`${p.untrackedFiles} fichier(s) non suivi(s)`);
  }
  if (p.stashCount > 0) {
    r.push(`${p.stashCount} entrée(s) de stash`);
  }
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
    case "favorites":
      return "Favoris";
    case "inactive":
      return "Projets inactifs";
    case "duplicates":
      return "Doublons";
    default:
      return "Vue d'ensemble";
  }
}

function currentSubtitle(): string {
  switch (filter) {
    case "safe":
      return "Entièrement sauvegardés sur leur remote - sûrs à supprimer.";
    case "dirty":
      return "Des changements ne sont pas encore commités.";
    case "ahead":
      return "Du travail local pas encore poussé sur le remote.";
    case "noremote":
      return "⚠️ Ces projets ne sont sauvegardés nulle part.";
    case "favorites":
      return "Les projets que tu as marqués d'une étoile.";
    case "inactive":
      return `Aucun commit depuis plus de ${INACTIVE_DAYS} jours - candidats au grand ménage.`;
    case "duplicates":
      return "Le même remote existe dans plusieurs dossiers sur ce PC.";
    default:
      return "Tous les projets Git détectés dans tes dossiers.";
  }
}

// ---------- Rendu : sidebar ----------
function renderNav(): void {
  const nav = $("#nav");
  const activeKey =
    viewMode === "settings" || viewMode === "archives" || viewMode === "ideas" ? viewMode : filter;
  nav.innerHTML = NAV.map((item) => {
    const showCount =
      item.key === "archives" || item.key === "ideas" ? true : item.key !== "settings" && scanned;
    const count = showCount ? `<span class="nav-count">${countFor(item.key)}</span>` : "";
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

// Les 4 tuiles brutes, réutilisées à la fois dans la rangée simple (autres
// filtres) et dans la grille 2×2 de la vue d'ensemble.
function statCards(): string {
  const total = projects.length;
  const safe = projects.filter((p) => p.safeToDelete).length;
  const dirty = projects.filter((p) => p.isDirty).length;
  const sum = projects.reduce((a, p) => a + (p.sizeBytes ?? 0), 0);
  const card = (cls: string, ic: string, value: string, label: string, id = "") =>
    `<div class="stat"><div class="stat-icon ${cls}">${icon(
      ic,
    )}</div><div class="stat-text"><div class="stat-value"${id ? ` id="${id}"` : ""}>${value}</div><div class="stat-label">${label}</div></div></div>`;
  return `${card("violet", "folder", String(total), "Projets trouvés")}${card(
    "green",
    "check",
    String(safe),
    "Supprimables",
  )}${card("amber", "edit", String(dirty), "Avec modifs locales")}${card(
    "blue",
    "disk",
    formatBytes(sum),
    "Espace total",
    "stat-size-value",
  )}`;
}

function statsHtml(): string {
  return `<div class="stats">${statCards()}</div>`;
}

// ---------- Idées de projets (backlog perso, sous la grille de stats) ----------
function ideaRowHtml(i: IdeaItem): string {
  return `<div class="idea-row">
    <span class="idea-text">${esc(i.text)}</span>
    <button class="idea-remove" data-action="remove-idea" data-idea-id="${esc(
      i.id,
    )}" title="Retirer cette idée">×</button>
  </div>`;
}

function ideasListInnerHtml(): string {
  return ideas.length
    ? ideas.map(ideaRowHtml).join("")
    : `<p class="ideas-empty">Aucune idée pour l'instant - note ce qui te passe par la tête.</p>`;
}

// Rendu ciblé de la liste seule (sans redessiner toute la vue), après
// ajout/retrait d'une idée - même logique que `renderRoots()`. On rafraîchit
// aussi la nav pour que le compteur suive.
function renderIdeasList(): void {
  const el = document.getElementById("ideas-list");
  if (el) el.innerHTML = ideasListInnerHtml();
  renderNav();
}

function rowHtml(p: ProjectInfo): string {
  const initial = p.name.charAt(0) || "?";
  const branch = p.branch
    ? `<span class="row-branch">${icon("branch")}${esc(p.branch)}</span>`
    : "";
  const size = p.sizeBytes !== undefined ? formatBytes(p.sizeBytes) : "…";
  const commit = p.lastCommit ? formatRelative(p.lastCommit) : "-";
  const selected = selection.has(p.path);
  const fav = getMeta(p.path).favorite;
  return `
    <div class="row ${selected ? "is-selected" : ""}" data-path="${esc(p.path)}">
      <input type="checkbox" class="row-check" data-check="${esc(p.path)}"${
        selected ? " checked" : ""
      } title="Sélectionner ce projet" />
      <button class="fav-btn ${fav ? "is-fav" : ""}" data-fav="${esc(
        p.path,
      )}" title="${fav ? "Retirer des favoris" : "Ajouter aux favoris"}">${icon("star")}</button>
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

function scanBannerHtml(): string {
  if (!loading) return "";
  return `<div class="scan-banner"><span class="spinner spinner-sm"></span>Scan en cours… ${projects.length} projet${
    projects.length > 1 ? "s" : ""
  } trouvé${projects.length > 1 ? "s" : ""} pour l'instant</div>`;
}

function renderList(): void {
  const view = $("#view");
  if (projects.length === 0) {
    view.innerHTML = loading
      ? `
        ${pageHead(currentTitle(), currentSubtitle())}
        <div class="state">
          <div class="spinner"></div>
          <h2>Scan en cours…</h2>
          <p>Les projets apparaissent ici au fur et à mesure qu'ils sont trouvés.</p>
        </div>`
      : `
      ${pageHead(currentTitle(), currentSubtitle())}
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
  // Vue d'ensemble : grille 2×2 des stats à côté du graphique de répartition.
  // Les autres filtres gardent la rangée simple de 4 tuiles, sans graphique.
  const overviewBlock =
    filter === "all"
      ? `<div class="overview-grid">
          <div class="stat-grid">${statCards()}</div>
          <div class="panel chart-panel"><div class="panel-head"><h2>Répartition de l'espace disque</h2></div><div id="overview-chart">${chartBody()}</div></div>
        </div>`
      : statsHtml();
  view.innerHTML = `
    ${pageHead(currentTitle(), currentSubtitle())}
    ${scanBannerHtml()}
    ${overviewBlock}
    <div id="bulk-bar" class="bulk-bar" hidden></div>
    <div class="panel">
      <div class="panel-head">
        <h2>${visible.length} projet${visible.length > 1 ? "s" : ""}</h2>
        <div class="panel-head-right">
          <button class="btn btn-sm btn-ghost" data-action="sync-all" title="Fetch sur tous les projets avec remote">${icon(
            "refresh",
          )} Tout synchroniser</button>
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
  const meta = getMeta(p.path);
  const reasons = unsafeReasons(p);
  const safeBox = p.safeToDelete
    ? `<div class="safe-box ok">${icon(
        "shieldcheck",
      )}<div><strong>Suppression sûre</strong>Ce projet est intégralement sauvegardé sur son remote - tu peux le supprimer sans rien perdre.</div></div>`
    : `<div class="safe-box no">${icon("alert")}<div><strong>Pas entièrement sauvegardé</strong>
        <ul class="reason-list">${reasons.map((r) => `<li>${esc(r)}</li>`).join("") || "<li>État inconnu</li>"}</ul>
        <p class="reason-note">La suppression reste possible, mais ces éléments locaux seront perdus (récupérables dans la corbeille).</p>
        ${
          p.hasRemote
            ? `<button class="btn btn-sm secure-btn" data-action="secure" data-path="${esc(
                p.path,
              )}">${icon("lock")} Sécuriser (commit + push)</button>`
            : ""
        }
      </div></div>`;

  const dups = duplicatesOf(p);
  const dupBox = dups.length
    ? `<div class="safe-box no dup-box">${icon("copy")}<div><strong>Cloné à plusieurs endroits</strong>
        Le même remote existe aussi dans :
        <ul class="reason-list">${dups.map((d) => `<li><code>${esc(d.path)}</code></li>`).join("")}</ul>
      </div></div>`
    : "";

  const tagsHtml = meta.tags
    .map(
      (t) =>
        `<span class="tag-chip">${esc(t)}<button data-action="remove-tag" data-path="${esc(
          p.path,
        )}" data-tag="${esc(t)}" title="Retirer ce tag">×</button></span>`,
    )
    .join("");

  const cells: { k: string; v: string; mono?: boolean }[] = [
    { k: "Branche", v: p.branch ?? "-" },
    { k: "État du dossier", v: p.isDirty ? "Modifs non commitées" : "Propre" },
    { k: "Remote", v: p.hasRemote ? "Configuré" : "Aucun" },
    { k: "URL du remote", v: p.remoteUrl ?? "-", mono: true },
    { k: "Suivi distant", v: p.hasUpstream ? "Oui" : "Non" },
    { k: "Commits en avance", v: p.ahead === null ? "-" : String(p.ahead) },
    { k: "Commits en retard", v: p.behind === null ? "-" : String(p.behind) },
    {
      k: "Dernier commit",
      v: p.lastCommit ? `${formatDate(p.lastCommit)} (${formatRelative(p.lastCommit)})` : "-",
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
      <button class="fav-btn fav-btn-lg ${meta.favorite ? "is-fav" : ""}" data-fav="${esc(
        p.path,
      )}" title="${meta.favorite ? "Retirer des favoris" : "Ajouter aux favoris"}">${icon(
        "star",
      )}</button>
      <div class="row-avatar">${esc(initial)}</div>
      <div class="detail-hero-info">
        <h1>${esc(p.name)}</h1>
        <div class="path">${esc(p.path)}</div>
        ${p.stack.length ? `<div class="tech-row">${techChips(p, 6)}</div>` : ""}
      </div>
      <div class="row-badges">${statusBadges(p)}</div>
    </div>
    ${safeBox}
    ${dupBox}
    <div class="info-grid">${cellsHtml}${sizeCell}</div>

    <div class="meta-block">
      <div class="k">${icon("tag")} Tags</div>
      <div class="tags-row">
        ${tagsHtml}
        <form class="tag-add" data-path="${esc(p.path)}">
          <input type="text" class="tag-input" placeholder="Ajouter un tag…" maxlength="24" />
        </form>
      </div>
    </div>
    <div class="meta-block">
      <div class="k">Note personnelle</div>
      <textarea class="note-input" data-path="${esc(
        p.path,
      )}" placeholder="Ex. « Projet abandonné, ne pas supprimer »…" rows="2">${esc(
        meta.note,
      )}</textarea>
    </div>

    <div class="readme-block">
      <div class="k">Aperçu du README</div>
      <div id="readme-section" class="readme-empty">Chargement…</div>
    </div>
    <div class="commits-block">
      <div class="k">Derniers commits</div>
      <div id="commits-section" class="commits-empty">Chargement…</div>
    </div>

    <div class="clean-block">
      <div class="k">${icon("broom")} Nettoyage</div>
      <div id="clean-section">
        <button class="btn btn-sm" data-action="scan-clean" data-path="${esc(
          p.path,
        )}">Analyser l'espace récupérable</button>
      </div>
    </div>

    <div class="deep-block">
      <div class="k">🧪 Analyse approfondie</div>
      <div id="deep-section">
        <p class="clean-hint">Santé du dépôt, branches, fichiers modifiés, gros fichiers et secrets potentiels.</p>
        <button class="btn btn-sm" data-action="deep-analysis" data-path="${esc(
          p.path,
        )}">Lancer l'analyse</button>
      </div>
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
      ${
        p.hasRemote
          ? `<button class="btn" data-action="archive" data-path="${esc(
              p.path,
            )}" title="Supprimer en gardant un souvenir (lien GitHub, taille, date)">${icon(
              "archive",
            )} Archiver</button>`
          : ""
      }
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

  view.insertAdjacentHTML(
    "beforeend",
    `<div class="panel" style="padding:20px; margin-top:16px">
      <div class="panel-head-inline"><h2>${icon("cpu")} Environnement</h2></div>
      <p class="clean-hint">Outils de développement détectés sur ce PC.</p>
      <div id="tools-section">
        <button class="btn btn-sm" data-action="check-tools">Vérifier les outils installés</button>
      </div>
    </div>`,
  );
  if (toolsCache) renderToolsSection();
}

function renderToolsSection(): void {
  const section = document.getElementById("tools-section");
  if (!section || !toolsCache) return;
  section.innerHTML = `<div class="tools-grid">${toolsCache
    .map(
      (t) =>
        `<div class="tool-row ${t.installed ? "ok" : "missing"}">
          <span class="tool-dot"></span>
          <span class="tool-name">${esc(t.name)}</span>
          <span class="tool-version">${esc(t.version ?? (t.installed ? "" : "absent"))}</span>
        </div>`,
    )
    .join("")}</div>`;
}

// ---------- Archives ----------
function renderArchives(): void {
  const view = $("#view");
  if (archives.length === 0) {
    view.innerHTML = `
      ${pageHead("Archives", "Historique des projets supprimés délibérément depuis l'app.")}
      <div class="state">
        <div class="state-icon">${icon("archive")}</div>
        <h2>Aucune archive</h2>
        <p>Quand tu archives un projet (au lieu de le supprimer simplement), il apparaît ici avec un lien vers son remote.</p>
      </div>`;
    return;
  }
  const sorted = [...archives].sort((a, b) => b.archivedAt - a.archivedAt);
  const rows = sorted
    .map((a) => {
      const url = githubWebUrl(a.remoteUrl);
      return `<div class="archive-row">
        <div class="archive-avatar">${icon("archive")}</div>
        <div class="archive-main">
          <div class="archive-name">${esc(a.name)}</div>
          <div class="archive-path" title="${esc(a.path)}">${esc(a.path)}</div>
        </div>
        <div class="archive-meta">
          <div>${formatBytes(a.sizeBytes)} libérés</div>
          <div>${esc(formatRelative(Math.floor(a.archivedAt / 1000)))}</div>
        </div>
        <div class="archive-actions">
          ${
            url
              ? `<button class="btn btn-sm" data-action="archive-open" data-url="${esc(
                  url,
                )}">${icon("branch")} GitHub</button>`
              : ""
          }
          <button class="btn btn-sm btn-ghost" data-action="archive-remove" data-archive-path="${esc(
            a.path,
          )}" title="Retirer de la liste">${icon("trash")}</button>
        </div>
      </div>`;
    })
    .join("");
  view.innerHTML = `
    ${pageHead("Archives", "Historique des projets supprimés délibérément depuis l'app.")}
    <div class="panel"><div class="archive-list">${rows}</div></div>`;
}

function renderIdeas(): void {
  const view = $("#view");
  view.innerHTML = `
    ${pageHead(
      "Idées de projets",
      "Un backlog perso - les idées de projets que tu veux explorer un jour.",
    )}
    <div class="panel" style="padding:20px">
      <form id="add-idea-form" class="add-idea">
        <input id="add-idea-input" type="text" placeholder="Une idée à noter…" autocomplete="off" />
        <button type="submit" class="btn btn-primary">Ajouter</button>
      </form>
      <div class="ideas-list" id="ideas-list">${ideasListInnerHtml()}</div>
    </div>`;
  $<HTMLFormElement>("#add-idea-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>("#add-idea-input");
    addIdea(input.value);
    input.value = "";
    renderIdeasList();
    input.focus();
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

function render(): void {
  renderNav();
  renderSideCard();
  if (viewMode === "settings") {
    renderSettings();
    return;
  }
  if (viewMode === "archives") {
    renderArchives();
    return;
  }
  if (viewMode === "ideas") {
    renderIdeas();
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
  const refresh = document.getElementById("refresh-btn") as HTMLButtonElement | null;
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
  if (refresh) {
    refresh.classList.toggle("is-loading", busy);
    refresh.disabled = busy;
  }
}

// `manual` distingue un clic utilisateur (déclenche une notification résumé
// en fin de scan) du scan automatique au démarrage (silencieux, pour ne pas
// spammer l'utilisateur à chaque lancement de l'app).
async function scan(manual = false): Promise<void> {
  // Défense en profondeur en plus de la désactivation des boutons : empêche
  // deux scans concurrents (ex. déclenchés via la palette de commandes) de
  // tourner en même temps côté backend et de mélanger leurs résultats.
  if (loading) return;
  if (roots.length === 0) {
    toast("info", "Aucun dossier", "Ajoute un dossier dans « Dossiers scannés ».");
    viewMode = "settings";
    render();
    return;
  }
  // On vide la liste et on bascule sur la vue liste tout de suite : les
  // projets apparaissent au fil du scan (évènements "project-found"), et la
  // nav/recherche restent utilisables pendant que ça tourne en arrière-plan.
  projects = [];
  scanned = true;
  loading = true;
  viewMode = "list";
  setScanBusy(true);
  render();
  const token = ++scanToken;
  try {
    const found = await call<ProjectInfo[]>("scan_projects", { roots });
    if (token !== scanToken) return;
    projects = found;
    loading = false;
    setScanBusy(false);
    render();
    fetchSizes(token);
    if (manual) notifyScanSummary();
  } catch (e) {
    if (token !== scanToken) return;
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
    toast("err", `Échec du pull - ${p.name}`, String(e));
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
    // fetch_project ne rejette plus jamais : un échec (remote supprimé,
    // accès révoqué...) est intégré dans le ProjectInfo renvoyé
    // (remoteUnreachable/remoteError) plutôt que de lever une exception, pour
    // que le badge/risque du projet reflète ce qu'on vient d'apprendre.
    const fresh = await call<ProjectInfo>("fetch_project", { path: p.path });
    mergeProject(fresh);
    // Un fetch met à jour les refs distantes de TOUTES les branches locales :
    // l'avance/retard mis en cache pour les branches autres que la courante
    // (affiché dans l'analyse approfondie) serait donc périmé.
    branchesCache.delete(p.path);
    render();
    if (selectedPath === p.path) restoreDetailSections(p.path);
    if (fresh.remoteUnreachable) {
      toast("err", `Remote injoignable - ${p.name}`, fresh.remoteError ?? undefined);
    } else {
      toast("ok", `${p.name} : refs distantes à jour`);
    }
  } catch (e) {
    toast("err", `Échec du fetch - ${p.name}`, String(e));
  }
}

async function doPush(p: ProjectInfo): Promise<void> {
  toast("info", `Push de ${p.name}…`);
  try {
    const fresh = await call<ProjectInfo>("push_project", { path: p.path });
    mergeProject(fresh);
    // Un push change l'avance de la branche courante par rapport à son
    // upstream : le cache de branches (analyse approfondie) serait périmé.
    branchesCache.delete(p.path);
    render();
    if (selectedPath === p.path) restoreDetailSections(p.path);
    if (fresh.remoteUnreachable) {
      toast("err", `Remote injoignable - ${p.name}`, fresh.remoteError ?? undefined);
    } else {
      toast("ok", `${p.name} poussé sur le remote`);
    }
  } catch (e) {
    toast("err", `Échec du push - ${p.name}`, String(e));
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

// ---------- Favoris, tags, notes ----------
function toggleFavorite(path: string): void {
  updateMeta(path, { favorite: !getMeta(path).favorite });
  render();
}

function addTag(path: string, rawTag: string): void {
  const tag = rawTag.trim();
  if (!tag) return;
  const meta = getMeta(path);
  if (meta.tags.some((t) => t.toLowerCase() === tag.toLowerCase())) return;
  updateMeta(path, { tags: [...meta.tags, tag] });
  render();
}

function removeTag(path: string, tag: string): void {
  const meta = getMeta(path);
  updateMeta(path, { tags: meta.tags.filter((t) => t !== tag) });
  render();
}

function saveNote(path: string, note: string): void {
  updateMeta(path, { note });
}

// ---------- Nettoyage (node_modules, target, dist…) ----------
async function doScanClean(path: string): Promise<void> {
  const section = document.getElementById("clean-section");
  if (section) {
    section.innerHTML = `<div class="clean-loading"><span class="spinner spinner-sm"></span>Analyse en cours…</div>`;
  }
  try {
    const entries = await call<CleanableEntry[]>("scan_cleanable", { path });
    cleanableCache.set(path, entries);
    if (selectedPath === path) renderCleanSection(path);
  } catch (e) {
    if (section) {
      section.innerHTML = `<p class="clean-empty">Analyse impossible : ${esc(String(e))}</p>`;
    }
  }
}

function renderCleanSection(path: string): void {
  const section = document.getElementById("clean-section");
  if (!section) return;
  const entries = cleanableCache.get(path) ?? [];
  if (entries.length === 0) {
    section.innerHTML = `<p class="clean-empty">Rien à nettoyer - aucun dossier régénérable (node_modules, target, dist…) détecté.</p>`;
    return;
  }
  const rows = entries
    .map(
      (e) =>
        `<div class="clean-row">
          <input type="checkbox" checked data-clean="${esc(e.path)}" />
          <span class="clean-name">${esc(e.name)}</span>
          <span class="clean-path" title="${esc(e.path)}">${esc(e.path)}</span>
          <span class="clean-size">${formatBytes(e.sizeBytes)}</span>
        </div>`,
    )
    .join("");
  const total = entries.reduce((a, e) => a + e.sizeBytes, 0);
  section.innerHTML = `
    <p class="clean-hint">Dossiers régénérables (jamais le code source ni l'historique Git) :</p>
    <div class="clean-list">${rows}</div>
    <div class="clean-footer">
      <span>Sélection : <strong id="clean-total">${formatBytes(total)}</strong></span>
      <button class="btn btn-sm btn-danger" data-action="clean-selected" data-path="${esc(
        path,
      )}">${icon("broom")} Nettoyer</button>
    </div>`;
}

function updateCleanTotal(path: string): void {
  const totalEl = document.getElementById("clean-total");
  if (!totalEl) return;
  const entries = cleanableCache.get(path) ?? [];
  const checked = new Set(
    Array.from(
      document.querySelectorAll<HTMLInputElement>("#clean-section input[data-clean]:checked"),
    ).map((el) => el.dataset.clean),
  );
  const total = entries
    .filter((e) => checked.has(e.path))
    .reduce((a, e) => a + e.sizeBytes, 0);
  totalEl.textContent = formatBytes(total);
}

async function doCleanSelected(path: string): Promise<void> {
  const checked = Array.from(
    document.querySelectorAll<HTMLInputElement>("#clean-section input[data-clean]:checked"),
  ).map((el) => el.dataset.clean as string);
  if (checked.length === 0) {
    toast("info", "Nettoyage", "Aucun dossier sélectionné.");
    return;
  }
  const entries = cleanableCache.get(path) ?? [];
  try {
    const outcomes = await call<CleanOutcome[]>("clean_paths", { paths: checked });
    const okPaths = new Set(outcomes.filter((o) => o.ok).map((o) => o.path));
    const failed = outcomes.filter((o) => !o.ok);
    const freed = entries
      .filter((e) => okPaths.has(e.path))
      .reduce((a, e) => a + e.sizeBytes, 0);

    // Retire les dossiers nettoyés du cache et de la taille du projet.
    cleanableCache.set(path, entries.filter((e) => !okPaths.has(e.path)));
    const project = projectByPath(path);
    if (project && project.sizeBytes !== undefined) {
      project.sizeBytes = Math.max(0, project.sizeBytes - freed);
    }

    if (selectedPath === path) {
      renderCleanSection(path);
      const sizeEl = document.getElementById("detail-size");
      if (sizeEl && project?.sizeBytes !== undefined) {
        sizeEl.textContent = formatBytes(project.sizeBytes);
      }
    }
    updateSizesDom();

    if (freed > 0) {
      toast(
        failed.length ? "err" : "ok",
        `${formatBytes(freed)} récupéré${failed.length ? ` (${failed.length} échec(s))` : ""}`,
      );
    } else {
      toast("err", "Nettoyage", "Aucun dossier n'a pu être supprimé.");
    }
  } catch (e) {
    toast("err", "Nettoyage impossible", String(e));
  }
}

// ---------- Sécuriser avant suppression (commit + push automatique) ----------
async function doSecureProject(p: ProjectInfo): Promise<void> {
  toast("info", `Sécurisation de ${p.name}…`);
  try {
    const fresh = await call<ProjectInfo>("secure_project", { path: p.path });
    mergeProject(fresh);
    // Le commit + push vient de changer l'état des fichiers : ces caches
    // seraient périmés (ex. liste de fichiers modifiés qui n'existent plus).
    commitsCache.delete(p.path);
    branchesCache.delete(p.path);
    insightCache.delete(p.path);
    fileStatusCache.delete(p.path);
    render();
    if (selectedPath === p.path) restoreDetailSections(p.path);
    toast(
      fresh.safeToDelete ? "ok" : "info",
      fresh.safeToDelete
        ? `${p.name} est maintenant entièrement sauvegardé`
        : `${p.name} : commit + push effectués, vérifie l'état restant`,
    );
  } catch (e) {
    toast("err", `Sécurisation impossible - ${p.name}`, String(e));
  }
}

// ---------- Archiver (supprimer en gardant un souvenir) ----------
function doArchiveProject(p: ProjectInfo, btn: HTMLElement): void {
  const modal = $("#modal");
  $("#modal-title").textContent = "Archiver le projet ?";
  $("#modal-body").innerHTML = `Le projet <strong>${esc(
    p.name,
  )}</strong> sera déplacé vers la corbeille, et une entrée sera gardée dans <strong>Archives</strong> avec un lien vers son remote pour le retrouver facilement.`;
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
    void withBusyButton(btn, async () => {
      try {
        await call("delete_project", { path: p.path });
      } catch (e) {
        toast("err", `Archivage impossible - ${p.name}`, String(e));
        return;
      }
      archives.push({
        name: p.name,
        path: p.path,
        remoteUrl: p.remoteUrl,
        sizeBytes: p.sizeBytes ?? 0,
        archivedAt: Date.now(),
      });
      saveArchives();
      toast("ok", `${p.name} archivé`, "Retrouve-le dans Archives.");
      performDeleteFollowUp(p);
    });
  };
}

// Partie commune à la suppression normale et à l'archivage : retire le
// projet de la liste avec l'animation adaptée à la vue courante.
function performDeleteFollowUp(p: ProjectInfo): void {
  // Sans ça, un projet supprimé/archivé individuellement (pas via l'action
  // groupée) resterait fantôme dans `selection` : le compteur de la barre
  // d'actions groupées resterait faussé indéfiniment.
  selection.delete(p.path);
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

function doRemoveArchive(path: string): void {
  archives = archives.filter((a) => a.path !== path);
  saveArchives();
  render();
}

// ---------- Outils installés ----------
async function doCheckTools(): Promise<void> {
  const section = document.getElementById("tools-section");
  if (section) {
    section.innerHTML = `<div class="clean-loading"><span class="spinner spinner-sm"></span>Vérification en cours…</div>`;
  }
  try {
    toolsCache = await call<ToolCheck[]>("check_tools");
    renderToolsSection();
  } catch (e) {
    if (section) section.innerHTML = `<p class="clean-empty">Vérification impossible : ${esc(String(e))}</p>`;
  }
}

// ---------- Analyse approfondie (santé, branches, fichiers, secrets) ----------
async function doDeepAnalysis(path: string): Promise<void> {
  const section = document.getElementById("deep-section");
  if (section) {
    section.innerHTML = `<div class="clean-loading"><span class="spinner spinner-sm"></span>Analyse en cours…</div>`;
  }
  try {
    const [insights, files, statuses] = await Promise.all([
      call<RepoInsights>("repo_insights", { path }),
      call<FilesInsight>("scan_files_insight", { path }),
      call<FileStatusEntry[]>("file_status", { path }),
    ]);
    branchesCache.set(path, insights);
    insightCache.set(path, files);
    fileStatusCache.set(path, statuses);
    if (selectedPath === path) renderDeepSection(path);
  } catch (e) {
    if (section) section.innerHTML = `<p class="clean-empty">Analyse impossible : ${esc(String(e))}</p>`;
  }
}

function healthChecklist(
  p: ProjectInfo,
  files: FilesInsight | undefined,
): { ok: boolean; label: string }[] {
  const items: { ok: boolean; label: string }[] = [
    { ok: p.hasRemote, label: "Remote distant configuré" },
    { ok: !p.remoteUnreachable, label: "Remote joignable au dernier essai" },
    { ok: p.hasUpstream, label: "Branche suivie par un remote" },
    { ok: !p.isDirty, label: "Aucune modification non commitée" },
    { ok: (p.ahead ?? 0) === 0, label: "Aucun commit en attente de push" },
    { ok: (p.behind ?? 0) === 0, label: "À jour avec le remote (pas de pull en attente)" },
    { ok: p.stashCount === 0, label: "Aucun stash oublié" },
    { ok: !p.error, label: "Dépôt Git lisible sans erreur" },
  ];
  if (files) {
    items.push({ ok: files.largeFiles.length === 0, label: "Pas de gros fichier (> 20 Mo)" });
    items.push({ ok: files.secrets.length === 0, label: "Aucun secret potentiel détecté" });
  }
  return items;
}

function renderDeepSection(path: string): void {
  const section = document.getElementById("deep-section");
  if (!section) return;
  const p = projectByPath(path);
  if (!p) return;
  const insights = branchesCache.get(path);
  const files = insightCache.get(path);
  const statuses = fileStatusCache.get(path) ?? [];

  const checklist = healthChecklist(p, files);
  const checklistHtml = checklist
    .map(
      (i) =>
        `<div class="health-row ${i.ok ? "ok" : "no"}">${icon(i.ok ? "check" : "alert")}<span>${esc(
          i.label,
        )}</span></div>`,
    )
    .join("");

  const branchesHtml = insights
    ? `<div class="sub-k">Branches (${insights.totalCommits} commits sur la branche courante)</div>
       <div class="branch-list">${insights.branches
         .map((b) => {
           const parts: string[] = [];
           if (b.isCurrent) parts.push(`<span class="badge neutral">courante</span>`);
           if (!b.hasUpstream) parts.push(`<span class="badge amber">sans remote</span>`);
           else {
             if ((b.ahead ?? 0) > 0) parts.push(`<span class="badge amber">${b.ahead} non poussé(s)</span>`);
             if ((b.behind ?? 0) > 0) parts.push(`<span class="badge neutral">${b.behind} en retard</span>`);
             if ((b.ahead ?? 0) === 0 && (b.behind ?? 0) === 0) parts.push(`<span class="badge green">à jour</span>`);
           }
           return `<div class="branch-row"><code>${esc(b.name)}</code><div class="branch-badges">${parts.join("")}</div></div>`;
         })
         .join("")}</div>`
    : "";

  const statusLabels: Record<FileStatusEntry["status"], string> = {
    new: "A",
    modified: "M",
    deleted: "D",
    renamed: "R",
    typechange: "T",
    conflicted: "!",
  };
  const filesHtml = statuses.length
    ? `<div class="sub-k">Fichiers modifiés (${statuses.length})</div>
       <div class="file-status-list">${statuses
         .slice(0, 50)
         .map(
           (f) =>
             `<div class="file-status-row"><span class="fs-badge fs-${f.status}">${statusLabels[f.status]}</span><span class="fs-path">${esc(f.path)}</span></div>`,
         )
         .join("")}${statuses.length > 50 ? `<div class="file-status-more">… et ${statuses.length - 50} de plus</div>` : ""}</div>`
    : "";

  const largeHtml = files && files.largeFiles.length
    ? `<div class="sub-k">⚠️ Gros fichiers</div>
       <div class="large-list">${files.largeFiles
         .map((f) => `<div class="large-row"><span class="fs-path">${esc(f.path)}</span><span>${formatBytes(f.sizeBytes)}</span></div>`)
         .join("")}</div>`
    : "";

  const secretsHtml = files && files.secrets.length
    ? `<div class="sub-k">🔑 Secrets potentiels</div>
       <div class="secret-warning">La valeur n'est jamais lue ni affichée - seul l'emplacement est indiqué. Vérifie chaque ligne manuellement.</div>
       <div class="secret-list">${files.secrets
         .map((s) => `<div class="secret-row"><span class="fs-path">${esc(s.location)}</span><span>${esc(s.reason)}</span></div>`)
         .join("")}</div>`
    : "";

  section.innerHTML = `
    <div class="health-list">${checklistHtml}</div>
    ${branchesHtml}
    ${filesHtml}
    ${largeHtml}
    ${secretsHtml}
  `;
}

// ---------- Palette de commandes (Ctrl+K) ----------
interface PaletteCommand {
  label: string;
  hint?: string;
  icon: string;
  run: () => void;
}

function paletteCommands(): PaletteCommand[] {
  const actionCmds: PaletteCommand[] = [
    {
      label: scanned ? "Rescanner mes projets" : "Scanner mes projets",
      icon: "search",
      run: () => scan(true),
    },
    {
      label: "Basculer le thème clair/sombre",
      icon: "moon",
      run: () => applyTheme(theme === "dark" ? "light" : "dark"),
    },
    { label: "Tout synchroniser (fetch)", icon: "refresh", run: () => doSyncAll() },
    { label: "Tout sélectionner (vue courante)", icon: "check", run: () => selectAllVisible() },
  ];
  const navCmds: PaletteCommand[] = NAV.map((item) => ({
    label: `Aller à : ${item.label}`,
    icon: item.icon,
    run: () => {
      if (item.key === "settings" || item.key === "archives" || item.key === "ideas") {
        viewMode = item.key as ViewMode;
      } else {
        viewMode = "list";
        filter = item.key as Filter;
      }
      render();
    },
  }));
  const projectCmds: PaletteCommand[] = projects.map((p) => ({
    label: p.name,
    hint: p.path,
    icon: "folder",
    run: () => openDetail(p.path),
  }));
  return [...actionCmds, ...navCmds, ...projectCmds];
}

let paletteResults: PaletteCommand[] = [];
let paletteIndex = 0;

function openPalette(): void {
  const overlay = document.getElementById("palette");
  const input = $<HTMLInputElement>("#palette-input");
  if (!overlay) return;
  overlay.hidden = false;
  input.value = "";
  paletteIndex = 0;
  renderPaletteList("");
  input.focus();
}

function closePalette(): void {
  const overlay = document.getElementById("palette");
  if (overlay) overlay.hidden = true;
}

function renderPaletteList(query: string): void {
  const list = document.getElementById("palette-list");
  if (!list) return;
  const q = query.trim().toLowerCase();
  paletteResults = paletteCommands()
    .filter((c) => !q || c.label.toLowerCase().includes(q) || (c.hint ?? "").toLowerCase().includes(q))
    .slice(0, 40);
  if (paletteIndex >= paletteResults.length) paletteIndex = 0;
  list.innerHTML = paletteResults.length
    ? paletteResults
        .map(
          (c, i) =>
            `<div class="palette-item ${i === paletteIndex ? "is-active" : ""}" data-index="${i}">${icon(
              c.icon,
            )}<span class="palette-label">${esc(c.label)}</span>${
              c.hint ? `<span class="palette-hint">${esc(c.hint)}</span>` : ""
            }</div>`,
        )
        .join("")
    : `<div class="palette-empty">Aucun résultat.</div>`;
}

function movePaletteSelection(delta: number): void {
  if (paletteResults.length === 0) return;
  paletteIndex = (paletteIndex + delta + paletteResults.length) % paletteResults.length;
  renderPaletteList($<HTMLInputElement>("#palette-input").value);
}

function runPaletteSelection(index: number): void {
  const cmd = paletteResults[index];
  if (!cmd) return;
  closePalette();
  cmd.run();
}

// ---------- Synchronisation globale ----------
// Nombre maximum d'échecs détaillés dans le toast récapitulatif : au-delà,
// on résume plutôt que de produire un pavé illisible pour un gros scan.
const MAX_SYNC_FAILURES_LISTED = 6;

async function doSyncAll(): Promise<void> {
  const targets = projects.filter((p) => p.hasRemote);
  if (targets.length === 0) {
    toast("info", "Synchronisation", "Aucun projet avec remote à synchroniser.");
    return;
  }
  toast("info", `Synchronisation de ${targets.length} projet(s)…`);
  let upToDate = 0;
  let behindCount = 0;
  // On garde le nom et la raison de chaque échec (au lieu d'un simple
  // compteur) pour que l'utilisateur sache quoi vérifier sans devoir rouvrir
  // chaque projet un par un.
  const failed: { name: string; reason: string }[] = [];
  for (const t of targets) {
    try {
      const fresh = await call<ProjectInfo>("fetch_project", { path: t.path });
      mergeProject(fresh);
      if (fresh.remoteUnreachable) {
        failed.push({ name: t.name, reason: fresh.remoteError ?? "Remote injoignable" });
      } else if ((fresh.behind ?? 0) > 0) {
        behindCount++;
      } else {
        upToDate++;
      }
    } catch (e) {
      failed.push({ name: t.name, reason: String(e) });
    }
  }
  render();
  const failBody = failed.length
    ? failed
        .slice(0, MAX_SYNC_FAILURES_LISTED)
        .map((f) => `${f.name} : ${f.reason}`)
        .join("\n") +
      (failed.length > MAX_SYNC_FAILURES_LISTED
        ? `\n… et ${failed.length - MAX_SYNC_FAILURES_LISTED} de plus`
        : "")
    : "";
  toast(
    failed.length ? "err" : "ok",
    `Synchronisation terminée : ${upToDate} à jour, ${behindCount} en retard${
      failed.length ? `, ${failed.length} échec(s)` : ""
    }`,
    failBody,
  );
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
    path: p.path as string | null,
  }));
  const rest = total - topBytes;
  // "Autres" agrège plusieurs projets : pas de fiche unique vers laquelle
  // naviguer, contrairement aux segments ci-dessus qui pointent chacun vers
  // un projet précis.
  if (rest > 0) segments.push({ label: "Autres", bytes: rest, color: "#94a3b8", path: null });

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
        `<div class="leg${s.path ? " leg-clickable" : ""}"${
          s.path
            ? ` data-action="open-project" data-path="${esc(s.path)}" title="Ouvrir ${esc(s.label)}"`
            : ""
        }><span class="leg-dot" style="background:${
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

function bulkPull(btn: HTMLElement): void {
  const targets = [...selection]
    .map((p) => projectByPath(p))
    .filter((p): p is ProjectInfo => !!p && p.hasUpstream);
  if (!targets.length) {
    toast("info", "Pull", "Aucun projet sélectionné n'a de branche distante à mettre à jour.");
    return;
  }
  toast("info", `Pull de ${targets.length} projet(s)…`);
  void withBusyButton(btn, async () => {
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
  });
}

function bulkDelete(btn: HTMLElement): void {
  const targets = [...selection]
    .map((p) => projectByPath(p))
    .filter((p): p is ProjectInfo => !!p);
  if (!targets.length) return;
  const unsafe = targets.filter((t) => !t.safeToDelete).length;
  const modal = $("#modal");
  const warning = unsafe
    ? `<div class="modal-warning">⚠️ ${unsafe} projet(s) sur ${targets.length} ne sont pas entièrement sauvegardés : leurs éléments locaux seront perdus (récupérables dans la corbeille).</div>`
    : "";
  $("#modal-title").textContent = "Supprimer le projet ?";
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
  // Le bouton du bandeau (`btn`) reste affiché le temps de l'opération : la
  // modale se ferme tout de suite, mais son icône tourne jusqu'à la fin.
  confirmBtn.onclick = () => {
    close();
    void withBusyButton(btn, async () => {
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
    });
  };
}

function askDelete(p: ProjectInfo, btn: HTMLElement): void {
  const modal = $("#modal");
  const reasons = p.safeToDelete ? [] : unsafeReasons(p);
  const warning = reasons.length
    ? `<div class="modal-warning">
        <strong>⚠️ Pas entièrement sauvegardé :</strong>
        <ul class="reason-list">${reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
        Ces éléments n'existent que sur ce PC et seront perdus (mais récupérables dans la corbeille).
      </div>`
    : "";
  $("#modal-title").textContent = "Supprimer le projet ?";
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
  // Même logique que bulkDelete : la modale se ferme tout de suite, le
  // bouton d'origine (icône poubelle de la ligne, ou bouton de la fiche
  // détail) tourne pendant la suppression réelle.
  confirmBtn.onclick = () => {
    close();
    void withBusyButton(btn, () => performDelete(p));
  };
}

// Supprime réellement, avec retour visuel immédiat : animation de la ligne
// dans la liste, sinon retour à la liste depuis la fiche détail.
async function performDelete(p: ProjectInfo): Promise<void> {
  try {
    await call("delete_project", { path: p.path });
  } catch (e) {
    toast("err", `Suppression impossible - ${p.name}`, String(e));
    return;
  }
  toast("ok", `${p.name} envoyé à la corbeille`);
  performDeleteFollowUp(p);
}

function openDetail(path: string): void {
  selectedPath = path;
  viewMode = "detail";
  render();
  restoreDetailSections(path);
}

// Réaffiche le README, les commits et les analyses déjà chargés pour ce
// projet après un `render()` qui a reconstruit la fiche détail depuis zéro
// (ex. après fetch/push/sécuriser) - sans ça, ces sections reviendraient à
// leur état "Chargement…"/bouton initial alors que les données sont déjà
// en cache.
function restoreDetailSections(path: string): void {
  loadReadme(path);
  loadCommits(path);
  if (cleanableCache.has(path)) renderCleanSection(path);
  if (branchesCache.has(path)) renderDeepSection(path);
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
  if (action === "open-project") {
    const path = btn.dataset.path;
    if (path) openDetail(path);
    return;
  }
  if (action === "remove-tag") {
    const path = btn.dataset.path;
    const tag = btn.dataset.tag;
    if (path && tag) removeTag(path, tag);
    return;
  }
  if (action === "scan-clean") {
    const path = btn.dataset.path;
    if (path) void withBusyButton(btn, () => doScanClean(path));
    return;
  }
  if (action === "clean-selected") {
    const path = btn.dataset.path;
    if (path) void withBusyButton(btn, () => doCleanSelected(path));
    return;
  }
  if (action === "deep-analysis") {
    const path = btn.dataset.path;
    if (path) void withBusyButton(btn, () => doDeepAnalysis(path));
    return;
  }
  if (action === "check-tools") {
    void withBusyButton(btn, () => doCheckTools());
    return;
  }
  if (action === "scan") {
    scan();
    return;
  }
  if (action === "browse") {
    void withBusyButton(btn, () => browseFolder());
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
    bulkPull(btn);
    return;
  }
  if (action === "bulk-delete") {
    bulkDelete(btn);
    return;
  }
  if (action === "sync-all") {
    void withBusyButton(btn, () => doSyncAll());
    return;
  }
  if (action === "open-palette") {
    openPalette();
    return;
  }
  if (action === "archive-open") {
    const url = btn.dataset.url;
    if (url) {
      void withBusyButton(btn, () =>
        call("open_url", { url }).catch((e) => toast("err", "Ouverture du remote", String(e))),
      );
    }
    return;
  }
  if (action === "archive-remove") {
    const p = btn.dataset.archivePath;
    if (p) doRemoveArchive(p);
    return;
  }
  if (action === "remove-idea") {
    const id = btn.dataset.ideaId;
    if (id) {
      removeIdea(id);
      renderIdeasList();
    }
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
  if (action === "open") void withBusyButton(btn, () => doOpen(p));
  else if (action === "editor") void withBusyButton(btn, () => doOpenEditor(p));
  else if (action === "pull") void withBusyButton(btn, () => doPull(p));
  else if (action === "fetch") void withBusyButton(btn, () => doFetch(p));
  else if (action === "push") void withBusyButton(btn, () => doPush(p));
  else if (action === "remote") void withBusyButton(btn, () => doOpenRemote(p));
  else if (action === "secure") void withBusyButton(btn, () => doSecureProject(p));
  else if (action === "archive") doArchiveProject(p, btn);
  else if (action === "delete") askDelete(p, btn);
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

// ---------- Notifications Windows ----------
// Résumé envoyé uniquement après un scan déclenché manuellement (pas au
// lancement automatique de l'app, pour ne pas être intrusif à chaque ouverture).
async function notifyScanSummary(): Promise<void> {
  if (!IN_TAURI || projects.length === 0) return;
  try {
    const { isPermissionGranted, requestPermission, sendNotification } = await import(
      "@tauri-apps/plugin-notification"
    );
    let granted = await isPermissionGranted();
    if (!granted) {
      granted = (await requestPermission()) === "granted";
    }
    if (!granted) return;
    const critical = projects.filter((p) => p.riskLevel === "critical").length;
    const safe = projects.filter((p) => p.safeToDelete).length;
    const body =
      critical > 0
        ? `⚠️ ${critical} projet(s) non sauvegardé(s) du tout. ${safe} supprimable(s) en sécurité.`
        : `${projects.length} projet(s) analysé(s) - ${safe} supprimable(s) en sécurité.`;
    sendNotification({ title: "Dev Project Manager", body });
  } catch {
    // Notifications indisponibles (permission refusée, plateforme…) : silencieux.
  }
}

// ---------- Mises à jour ----------
interface TauriUpdate {
  version: string;
  downloadAndInstall: (onEvent?: (event: unknown) => void) => Promise<void>;
}
let pendingUpdate: TauriUpdate | null = null;

async function checkForUpdate(): Promise<void> {
  if (!IN_TAURI) {
    // Aperçu navigateur : bandeau de démo si l'URL contient ?demo-update.
    if (location.search.includes("demo-update")) showUpdateBanner("0.1.2");
    return;
  }
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = (await check()) as unknown as TauriUpdate | null;
    if (update) {
      pendingUpdate = update;
      showUpdateBanner(update.version);
    }
  } catch (e) {
    // Silencieux : pas de réseau ou pas de release → on n'embête pas l'utilisateur.
    console.warn("Vérification de mise à jour impossible", e);
  }
}

function showUpdateBanner(version: string): void {
  const text = document.getElementById("update-text");
  if (text) {
    text.textContent = `Version ${version} disponible - installe-la pour la dernière version.`;
  }
  const banner = document.getElementById("update-banner");
  if (banner) banner.hidden = false;
}

async function doInstallUpdate(): Promise<void> {
  const btn = document.getElementById("update-install") as HTMLButtonElement | null;
  if (!IN_TAURI || !pendingUpdate) {
    if (btn) btn.textContent = "(démo) indisponible dans l'aperçu";
    return;
  }
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Téléchargement…";
  }
  try {
    await pendingUpdate.downloadAndInstall((event) => {
      const e = event as { event?: string };
      if (btn && e.event === "Finished") btn.textContent = "Installation…";
    });
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (err) {
    toast("err", "Mise à jour échouée", String(err));
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Réessayer";
    }
  }
}

// ---------- Init ----------
async function init(): Promise<void> {
  $("#search-box").innerHTML = `${icon(
    "search",
  )}<input id="search" type="search" placeholder="Rechercher un projet…" autocomplete="off" />`;
  $("#refresh-btn").innerHTML = icon("refresh");
  $("#palette-btn").innerHTML = icon("command");
  loadMeta();
  loadArchives();
  loadIdeas();
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

  $("#scan-btn").addEventListener("click", () => scan(true));
  $("#refresh-btn").addEventListener("click", () => scan(true));

  // Projets renvoyés en flux par le backend pendant un scan : on les ajoute
  // au fur et à mesure au lieu d'attendre la fin complète du scan.
  if (IN_TAURI) {
    await listen<ProjectInfo>("project-found", (event) => {
      if (!loading) return;
      const p = event.payload;
      if (projects.some((x) => x.path === p.path)) return;
      projects.push(p);
      scheduleRender();
    });
  }

  $("#search").addEventListener("input", (e) => {
    search = (e.target as HTMLInputElement).value;
    if (viewMode === "list") render();
  });

  $("#nav").addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>(".nav-item");
    if (!btn || !btn.dataset.key) return;
    const key = btn.dataset.key;
    if (key === "settings" || key === "archives" || key === "ideas") {
      viewMode = key as ViewMode;
    } else {
      viewMode = "list";
      filter = key as Filter;
    }
    render();
  });

  $("#view").addEventListener("click", (e) => {
    const el = e.target as HTMLElement;
    const favBtn = el.closest<HTMLElement>("[data-fav]");
    if (favBtn?.dataset.fav) {
      toggleFavorite(favBtn.dataset.fav);
      return;
    }
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
      return;
    }
    if (el.matches("#clean-section input[data-clean]") && selectedPath) {
      updateCleanTotal(selectedPath);
    }
  });

  // Ajout d'un tag (formulaire dans la fiche détail).
  $("#view").addEventListener("submit", (e) => {
    const form = e.target as HTMLElement;
    if (!form.matches(".tag-add")) return;
    e.preventDefault();
    const path = (form as HTMLElement).dataset.path;
    const input = form.querySelector<HTMLInputElement>(".tag-input");
    if (path && input) {
      addTag(path, input.value);
      input.value = "";
    }
  });

  // Sauvegarde de la note perso quand on quitte le champ.
  $("#view").addEventListener(
    "blur",
    (e) => {
      const el = e.target as HTMLElement;
      if (el.matches(".note-input") && el.dataset.path) {
        saveNote(el.dataset.path, (el as HTMLTextAreaElement).value);
      }
    },
    true, // capture : "blur" ne bouillonne pas nativement
  );

  // Bandeau de mise à jour
  $("#update-install").addEventListener("click", doInstallUpdate);
  $("#update-later").addEventListener("click", () => {
    const banner = document.getElementById("update-banner");
    if (banner) banner.hidden = true;
  });
  checkForUpdate();

  // Palette de commandes (Ctrl+K / Cmd+K pour ouvrir, Echap pour fermer).
  $("#palette-btn").addEventListener("click", openPalette);
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      const overlay = document.getElementById("palette");
      if (overlay?.hidden === false) closePalette();
      else openPalette();
      return;
    }
    if (e.key === "Escape") {
      const overlay = document.getElementById("palette");
      if (overlay && !overlay.hidden) closePalette();
    }
  });
  $("#palette").addEventListener("click", (e) => {
    if (e.target === document.getElementById("palette")) closePalette();
  });
  $("#palette-input").addEventListener("input", (e) => {
    renderPaletteList((e.target as HTMLInputElement).value);
  });
  $("#palette-input").addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      movePaletteSelection(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      movePaletteSelection(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      runPaletteSelection(paletteIndex);
    }
  });
  $("#palette-list").addEventListener("click", (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>(".palette-item");
    if (item?.dataset.index) runPaletteSelection(Number(item.dataset.index));
  });

  // Détection automatique au démarrage si des dossiers sont déjà connus
  // (silencieuse : pas de notification, contrairement à un scan manuel).
  if (roots.length > 0) {
    scan(false);
  } else {
    render();
  }
}

init();
