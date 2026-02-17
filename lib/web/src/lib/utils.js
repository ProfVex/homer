import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

export function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

// ── File path extraction ────────────────────────────────────────
const FILE_RE = /(?:src|lib|app|pages|components|hooks|utils|test|tests|spec|config|public|assets|api|scripts|bin|deploy|docker|k8s|infra)\/[^\s,)"']+\.[a-z]{1,5}/gi;

export function extractFilePaths(text) {
  const fps = [];
  FILE_RE.lastIndex = 0;
  let m;
  while ((m = FILE_RE.exec(text)) !== null) {
    const fp = m[0].replace(/[,.)]+$/, "");
    if (!fps.includes(fp)) fps.push(fp);
  }
  return fps;
}

// ── Time formatting ─────────────────────────────────────────────
export function formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${rem.toString().padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${(m % 60).toString().padStart(2, "0")}m`;
}

export function formatRelative(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toString().padStart(2, "0")}`;
}

// ── NotHomer™ avatars ────────────────────────────────────────────
export const NOT_HOMER_AVATARS = [
  { src: "/avatars/homer-donut.svg",     name: "Donut Enthusiast" },
  { src: "/avatars/homer-beer.svg",      name: "Tavern Regular" },
  { src: "/avatars/homer-sleep.svg",     name: "Napping on the Job" },
  { src: "/avatars/homer-doh.svg",       name: "D'oh!" },
  { src: "/avatars/homer-nuke.svg",      name: "Safety Inspector" },
  { src: "/avatars/homer-brain.svg",     name: "Big Brain Mode" },
  { src: "/avatars/homer-rage.svg",      name: "WHY YOU LITTLE" },
  { src: "/avatars/homer-thinking.svg",  name: "Rare Thinking" },
  { src: "/avatars/homer-happy.svg",     name: "Pure Bliss" },
  { src: "/avatars/homer-scared.svg",    name: "Maximum Fear" },
  { src: "/avatars/homer-cool.svg",      name: "Mr. Plow" },
  { src: "/avatars/homer-fat.svg",       name: "Muumuu Mode" },
  { src: "/avatars/homer-hurt.svg",      name: "Everything Hurts" },
  { src: "/avatars/homer-detective.svg", name: "Detective Mode" },
  { src: "/avatars/homer-angel.svg",     name: "Wasn't Me" },
  { src: "/avatars/homer-chef.svg",      name: "Cooking Disaster" },
  { src: "/avatars/homer-builder.svg",   name: "DIY Disaster" },
  { src: "/avatars/homer-rich.svg",      name: "Stonks" },
];

export function getHomerAvatar(index) {
  return NOT_HOMER_AVATARS[index % NOT_HOMER_AVATARS.length];
}

// ── Roles ───────────────────────────────────────────────────────
export const ROLES = {
  general:    { icon: "\u25CF", color: "#89b4fa", name: "General" },
  planner:    { icon: "\u25C6", color: "#a6e3a1", name: "Planner" },
  coder:      { icon: "\u25B2", color: "#f9e2af", name: "Coder" },
  data:       { icon: "\u25A3", color: "#f38ba8", name: "Data" },
  api:        { icon: "\u25C8", color: "#cba6f7", name: "API" },
  researcher: { icon: "\uD83D\uDD0D", color: "#f9e2af", name: "Researcher" },
  verifier:   { icon: "\u2713", color: "#89b4fa", name: "Verifier" },
};

// ── Status colors ───────────────────────────────────────────────
export const STATUS_COLORS = {
  working:   { bg: "bg-blue/15", text: "text-blue", border: "border-blue/40" },
  verifying: { bg: "bg-yellow/15", text: "text-yellow", border: "border-yellow/40" },
  done:      { bg: "bg-green/15", text: "text-green", border: "border-green/40" },
  failed:    { bg: "bg-red/15", text: "text-red", border: "border-red/40" },
  blocked:   { bg: "bg-peach/15", text: "text-peach", border: "border-peach/40" },
  rerouted:  { bg: "bg-overlay0/15", text: "text-overlay0", border: "border-overlay0/40" },
  exited:    { bg: "bg-surface2/15", text: "text-surface2", border: "border-surface2/40" },
  killed:    { bg: "bg-surface2/15", text: "text-surface2", border: "border-surface2/40" },
};
