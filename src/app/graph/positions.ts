/**
 * Graph layouts. The initial ones are computed on the server and sent down, since
 * floating point differs slightly between Node and browsers; later ones (a filter,
 * focusing an entity) are computed in the browser after it has taken over.
 */

export interface GraphData {
  threads: { id: string; title: string; kind: string; source: string; sourceLabel: string; messages: number; lastAt: string | null }[];
  entities: { id: string; name: string; type: string; summary: string | null; mentions: number }[];
  edges: { id: string; source: string; target: string; relation: string; fact: string; current: boolean; validFrom: string | null; validTo: string | null }[];
  /** How often each entity comes up in each conversation. */
  places: { entityId: string; threadId: string; n: number }[];
}

export type Kind = "agent" | "source" | "thread" | "entity";

export interface Node {
  id: string;
  kind: Kind;
  label: string;
  x: number;
  y: number;
  /** Radius in screen pixels. */
  r: number;
  type?: string;
  /** Where the label sits: below the node, or to its right/left. */
  labelAt?: "below" | "right" | "left";
  /** Labelled up front; other nodes show their label on hover or when selected. */
  labelled?: boolean;
  /** A second, quieter line under the label: how a neighbour relates to the focused entity. */
  sublabel?: string;
}

export interface Link {
  a: string;
  b: string;
  /** Shown along the link (the relation, in the focus view). */
  label?: string;
  current?: boolean;
  /** Drawn as a horizontal S-curve (the tree). */
  curved?: boolean;
}

export interface Layout {
  nodes: Node[];
  links: Link[];
  /** Column headings (the tree). */
  headers?: { x: number; y: number; text: string }[];
}

export const ENTITY_TYPES = ["person", "company", "product", "project", "deal", "topic", "other"] as const;
export const TYPE_LABEL: Record<string, string> = {
  person: "People",
  company: "Companies",
  product: "Products & tools",
  project: "Projects",
  deal: "Deals",
  topic: "Topics",
  other: "Other",
};

/** Entities in the sources view's last column. */
const TOPICS = 14;
/** Entities drawn in the knowledge overview. */
export const OVERVIEW_SIZE = 30;
/** Neighbours drawn around a focused entity. */
const FOCUS_SIZE = 18;

/** How central an entity is: how often it comes up plus how many facts it's in. */
export function importance(data: GraphData): Map<string, number> {
  const score = new Map(data.entities.map((e) => [e.id, e.mentions]));
  for (const e of data.edges) {
    if (!e.current) continue;
    for (const id of [e.source, e.target]) score.set(id, (score.get(id) ?? 0) + 1);
  }
  return score;
}

const humanize = (relation: string) => relation.replace(/_/g, " ");

/**
 * Left to right, the way information flows: conversations → their sources → the agent → what the
 * agent knows from them (the most central entities). Every column is centred on the agent.
 */
export function treeLayout(data: GraphData): Layout {
  const COLUMN = { thread: 0, source: 250, agent: 480, topic: 720 };
  const nodes: Node[] = [];
  const links: Link[] = [];
  const stack = (count: number, row: number, i: number) => (i - (count - 1) / 2) * row;

  const sources = [...new Set(data.threads.map((t) => t.source))];
  const ordered = sources.flatMap((s) => data.threads.filter((t) => t.source === s));
  const maxMsgs = Math.max(1, ...data.threads.map((t) => t.messages));
  ordered.forEach((t, i) => {
    nodes.push({ id: t.id, kind: "thread", label: t.title, sublabel: `${t.messages} msgs`, x: COLUMN.thread, y: stack(ordered.length, 52, i), r: 6 + 5 * Math.sqrt(t.messages / maxMsgs), labelAt: "left" });
  });
  for (const s of sources) {
    const list = data.threads.filter((t) => t.source === s);
    const ys = list.map((t) => nodes.find((n) => n.id === t.id)!.y);
    nodes.push({ id: `source:${s}`, kind: "source", label: list[0].sourceLabel, x: COLUMN.source, y: ys.reduce((a, b) => a + b, 0) / ys.length, r: 11, labelAt: "below" });
    for (const t of list) links.push({ a: t.id, b: `source:${s}`, curved: true });
    links.push({ a: `source:${s}`, b: "agent", curved: true });
  }
  nodes.push({ id: "agent", kind: "agent", label: "ALRO agent", x: COLUMN.agent, y: 0, r: 22, labelAt: "below" });

  const score = importance(data);
  const topics = [...data.entities].sort((a, b) => (score.get(b.id) ?? 0) - (score.get(a.id) ?? 0)).slice(0, TOPICS);
  topics.forEach((e, i) => {
    nodes.push({ id: e.id, kind: "entity", type: e.type, label: e.name, x: COLUMN.topic, y: stack(topics.length, 34, i), r: 6, labelAt: "right" });
    links.push({ a: "agent", b: e.id, curved: true });
  });

  const top = Math.min(...nodes.map((n) => n.y)) - 60;
  return {
    nodes,
    links,
    headers: [
      { x: COLUMN.thread - 60, y: top, text: "CONVERSATIONS" },
      { x: COLUMN.source, y: top, text: "SOURCES" },
      { x: COLUMN.agent, y: top, text: "AGENT" },
      { x: COLUMN.topic + 70, y: top, text: "WHAT THEY'RE ABOUT" },
    ],
  };
}

/** The most important entities of the chosen types and the facts between them, laid out by a small force simulation. */
export function overviewLayout(data: GraphData, opts: { types?: readonly string[]; size?: number } = {}): Layout {
  const score = importance(data);
  const types = new Set(opts.types ?? ENTITY_TYPES);
  const chosen = data.entities
    .filter((e) => types.has(e.type))
    .sort((a, b) => (score.get(b.id) ?? 0) - (score.get(a.id) ?? 0))
    .slice(0, opts.size ?? OVERVIEW_SIZE);
  const ids = new Set(chosen.map((e) => e.id));
  // One link per pair, however many facts connect them.
  const pairs = new Map<string, Link>();
  for (const e of data.edges) {
    if (!e.current || !ids.has(e.source) || !ids.has(e.target)) continue;
    const key = [e.source, e.target].sort().join("|");
    if (!pairs.has(key)) pairs.set(key, { a: e.source, b: e.target, current: true });
  }
  const links = [...pairs.values()];
  const max = Math.max(1, ...chosen.map((e) => score.get(e.id) ?? 0));
  const nodes: Node[] = chosen.map((e, i) => {
    const angle = i * 2.399963; // golden-angle spiral as the starting position
    const radius = 40 * Math.sqrt(i + 1);
    return { id: e.id, kind: "entity", type: e.type, label: e.name, r: 5 + 9 * Math.sqrt((score.get(e.id) ?? 0) / max), x: radius * Math.cos(angle), y: radius * Math.sin(angle), labelled: true };
  });
  simulate(nodes, links);
  return { nodes, links };
}

/** One entity in the middle and everything it's directly connected to around it, each link named. */
export function focusLayout(data: GraphData, centerId: string): Layout {
  const center = data.entities.find((e) => e.id === centerId);
  if (!center) return { nodes: [], links: [] };
  const score = importance(data);
  const byNeighbour = new Map<string, { relations: string[]; current: boolean }>();
  for (const e of data.edges) {
    const other = e.source === centerId ? e.target : e.target === centerId ? e.source : undefined;
    if (!other || other === centerId) continue;
    const entry = byNeighbour.get(other) ?? { relations: [], current: false };
    // Read relations from the centre outwards: "proposed", or "← uses" when the neighbour is the subject.
    entry.relations.push(e.source === centerId ? humanize(e.relation) : `← ${humanize(e.relation)}`);
    entry.current ||= e.current;
    byNeighbour.set(other, entry);
  }
  const neighbours = [...byNeighbour.entries()]
    .filter(([id]) => data.entities.some((e) => e.id === id))
    .sort(([a, x], [b, y]) => Number(y.current) - Number(x.current) || (score.get(b) ?? 0) - (score.get(a) ?? 0))
    .slice(0, FOCUS_SIZE);

  // Two columns either side of the centre, evenly spaced: every label gets its own row.
  const nodes: Node[] = [{ id: center.id, kind: "entity", type: center.type, label: center.name, x: 0, y: 0, r: 16, labelAt: "below", labelled: true }];
  const links: Link[] = [];
  const ROW = 58;
  const half = Math.ceil(neighbours.length / 2);
  neighbours.forEach(([id, info], i) => {
    const e = data.entities.find((x) => x.id === id)!;
    const right = i < half;
    const count = right ? half : neighbours.length - half;
    const y = ((right ? i : i - half) - (count - 1) / 2) * ROW;
    // The relation goes under the neighbour's name, where there's room, rather than along the links.
    const [first, ...rest] = [...new Set(info.relations)];
    const sublabel = rest.length ? `${first} +${rest.length}` : first;
    nodes.push({ id, kind: "entity", type: e.type, label: e.name, sublabel, x: right ? 300 : -300, y, r: 7, labelAt: right ? "right" : "left", labelled: true });
    links.push({ a: center.id, b: id, current: info.current, curved: true });
  });
  return { nodes, links };
}

/** Repulsion between every pair, springs along links, light gravity to the middle. */
function simulate(nodes: Node[], links: Link[]) {
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const pairs = links.map((l) => [index.get(l.a)!, index.get(l.b)!] as const);
  const STEPS = 320;
  for (let step = 0; step < STEPS; step++) {
    const heat = 1 - step / STEPS;
    const dx = new Float64Array(nodes.length);
    const dy = new Float64Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const x = nodes[i].x - nodes[j].x;
        const y = nodes[i].y - nodes[j].y;
        const d2 = Math.max(x * x + y * y, 25);
        // Labels need room: every node pushes hard, big ones harder.
        const f = (6000 + 60 * nodes[i].r * nodes[j].r) / d2;
        dx[i] += x * f;
        dy[i] += y * f;
        dx[j] -= x * f;
        dy[j] -= y * f;
      }
    }
    for (const [i, j] of pairs) {
      const x = nodes[j].x - nodes[i].x;
      const y = nodes[j].y - nodes[i].y;
      const d = Math.hypot(x, y) || 1;
      const f = (d - 120) * 0.04;
      dx[i] += (x / d) * f;
      dy[i] += (y / d) * f;
      dx[j] -= (x / d) * f;
      dy[j] -= (y / d) * f;
    }
    for (let i = 0; i < nodes.length; i++) {
      dx[i] -= nodes[i].x * 0.03;
      dy[i] -= nodes[i].y * 0.03;
      const len = Math.hypot(dx[i], dy[i]);
      const cap = 30 * heat + 1;
      const k = len > cap ? cap / len : 1;
      nodes[i].x += dx[i] * k;
      nodes[i].y += dy[i] * k;
    }
  }
  for (const n of nodes) {
    n.x = Math.round(n.x * 10) / 10;
    n.y = Math.round(n.y * 10) / 10;
  }
}
