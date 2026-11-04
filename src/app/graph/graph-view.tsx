"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { hideEntity, mergeEntity, renameEntity } from "./actions";
import { ENTITY_TYPES, focusLayout, overviewLayout, TYPE_LABEL, type GraphData, type Layout } from "./positions";

type Mode = "sources" | "knowledge";

const date = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";

/**
 * Two views of what the agent reads: a map from the agent through each source and
 * conversation to what it's about, and an explorer for the knowledge graph that
 * shows the most important entities, or one entity and everything it connects to.
 */
export function GraphView({ data, initial }: { data: GraphData; initial: { tree: Layout; overview: Layout } }) {
  const params = useSearchParams();
  const [mode, setModeState] = useState<Mode>(params.get("view") === "knowledge" ? "knowledge" : "sources");
  const [selected, setSelected] = useState("agent");
  /** Focused entities, oldest first; the last one is in the middle. Empty means the overview. */
  const [trail, setTrail] = useState<string[]>([]);
  const [types, setTypes] = useState<string[]>([...ENTITY_TYPES]);
  const [query, setQuery] = useState("");

  const present = useMemo(() => ENTITY_TYPES.filter((t) => data.entities.some((e) => e.type === t)), [data]);
  // An entity hidden or merged away drops out of the trail.
  const live = useMemo(() => trail.filter((id) => data.entities.some((e) => e.id === id)), [trail, data]);
  const focus = live.at(-1);
  const layout = useMemo(() => {
    if (mode === "sources") return initial.tree;
    if (focus) return focusLayout(data, focus);
    return types.length === ENTITY_TYPES.length ? initial.overview : overviewLayout(data, { types });
  }, [mode, focus, types, data, initial]);
  const layoutKey = `${mode}:${focus ?? ""}:${types.join(",")}`;

  // Kept in the URL so a view can be linked to, without a navigation.
  const setMode = (next: Mode) => {
    setModeState(next);
    window.history.replaceState(null, "", next === "knowledge" ? "?view=knowledge" : window.location.pathname);
  };
  const focusOn = (id: string) => {
    setMode("knowledge");
    setSelected(id);
    setTrail((t) => (t.at(-1) === id ? t : [...t.filter((x) => x !== id), id]));
  };
  const select = (id: string) => {
    if (data.entities.some((e) => e.id === id)) focusOn(id);
    else setSelected(id);
  };
  const matches = query.trim()
    ? data.entities.filter((e) => e.name.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 8)
    : [];
  const name = (id: string) => data.entities.find((e) => e.id === id)?.name ?? "?";

  return (
    <div className="graph">
      <div className="graph-bar">
        <div className="segmented" role="tablist">
          <button role="tab" aria-selected={mode === "sources"} onClick={() => setMode("sources")}>
            Sources
          </button>
          <button role="tab" aria-selected={mode === "knowledge"} onClick={() => setMode("knowledge")}>
            Knowledge
          </button>
        </div>
        <div className="graph-search">
          <input
            type="search"
            placeholder="Find a person, product, topic…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && matches[0]) {
                focusOn(matches[0].id);
                setQuery("");
              }
            }}
            aria-label="Find an entity"
          />
          {matches.length > 0 && (
            <ul className="graph-matches">
              {matches.map((m) => (
                <li key={m.id}>
                  <button
                    className="link-button"
                    onClick={() => {
                      focusOn(m.id);
                      setQuery("");
                    }}
                  >
                    <i className={`swatch t-${m.type}`} />
                    {m.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <span className="muted small mono">
          {data.threads.length} conversation{data.threads.length === 1 ? "" : "s"} · {data.entities.length} entities · {data.edges.filter((e) => e.current).length} facts
        </span>
      </div>

      {mode === "knowledge" && (
        <div className="graph-tools">
          <nav className="crumbs" aria-label="Where you are">
            <button className="link-button" onClick={() => setTrail([])} aria-current={!focus ? "page" : undefined}>
              Most connected
            </button>
            {live.map((id, i) => (
              <span key={id}>
                <span className="muted"> › </span>
                <button className="link-button" onClick={() => setTrail(live.slice(0, i + 1))} aria-current={i === live.length - 1 ? "page" : undefined}>
                  {name(id)}
                </button>
              </span>
            ))}
          </nav>
          <div className="legend" role="group" aria-label="Show types">
            {present.map((t) => {
              const on = types.includes(t);
              return (
                <button
                  key={t}
                  className={`type-chip${on ? "" : " off"}`}
                  aria-pressed={on}
                  disabled={!!focus}
                  title={focus ? undefined : on ? `Hide ${TYPE_LABEL[t].toLowerCase()}` : `Show ${TYPE_LABEL[t].toLowerCase()}`}
                  onClick={() => setTypes(on ? types.filter((x) => x !== t) : [...types, t])}
                >
                  <i className={`swatch t-${t}`} />
                  {TYPE_LABEL[t]}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="graph-body">
        <Canvas key={layoutKey} layout={layout} selected={selected} onSelect={select} />
        <Details data={data} id={selected} onSelect={select} />
      </div>
      <p className="muted small">
        {mode === "sources"
          ? "Conversations feed their sources, sources feed the agent, and these are the things it knows most about. Click one to explore it. Scroll to zoom, drag to move, double-click to fit."
          : focus
            ? `${name(focus)} and its closest connections; the panel lists every fact. Click another node to move there.`
            : "The most connected people, products and topics. Click one to see its connections."}
      </p>
    </div>
  );
}

function Canvas({ layout, selected, onSelect }: { layout: Layout; selected: string; onSelect: (id: string) => void }) {
  const { nodes, links, headers } = layout;
  const svg = useRef<SVGSVGElement>(null);
  const [hovered, setHovered] = useState<string>();
  const bounds = useMemo(() => {
    const xs = nodes.map((n) => n.x);
    const ys = [...nodes.map((n) => n.y), ...(headers ?? []).map((h) => h.y)];
    // Room for labels, which sit beside or below the nodes.
    const right = nodes.some((n) => n.labelAt === "right") ? 300 : 140;
    const left = nodes.some((n) => n.labelAt === "left") ? 300 : 140;
    const [x0, x1, y0, y1] = [Math.min(...xs) - left, Math.max(...xs) + right, Math.min(...ys) - 50, Math.max(...ys) + 60];
    return { x: x0, y: y0, w: Math.max(x1 - x0, 400), h: Math.max(y1 - y0, 300) };
  }, [nodes, headers]);
  const [view, setView] = useState(bounds);
  const [size, setSize] = useState({ w: 800, h: 560 });
  const drag = useRef<{ x: number; y: number; view: typeof view } | null>(null);
  // Units per screen pixel (the viewBox is fitted, so the tighter axis decides). Nodes and text keep their on-screen size.
  const k = Math.max(view.w / size.w, view.h / size.h);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const active = hovered ?? (selected !== "agent" && byId.has(selected) ? selected : undefined);
  const near = useMemo(() => {
    const set = new Set(active ? [active] : []);
    for (const l of links) {
      if (l.a === active) set.add(l.b);
      if (l.b === active) set.add(l.a);
    }
    return set;
  }, [links, active]);
  // In the focus view everything is already one hop away; dimming would hide it.
  const dimming = !!active && !nodes.some((n) => n.sublabel);

  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setSize({ w: entry.contentRect.width || 800, h: entry.contentRect.height || 560 }));
    observer.observe(el);
    // Wheel zoom needs a non-passive listener to stop the page scrolling.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      setView((v) => {
        const z = Math.exp(e.deltaY * 0.0015);
        const px = v.x + ((e.clientX - rect.left) / rect.width) * v.w;
        const py = v.y + ((e.clientY - rect.top) / rect.height) * v.h;
        return { x: px - (px - v.x) * z, y: py - (py - v.y) * z, w: v.w * z, h: v.h * z };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      observer.disconnect();
      el.removeEventListener("wheel", onWheel);
    };
  }, []);

  return (
    <svg
      ref={svg}
      className="graph-canvas"
      viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
      onPointerDown={(e) => {
        if ((e.target as Element).closest("g.node")) return;
        drag.current = { x: e.clientX, y: e.clientY, view };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const s = Math.max(d.view.w / rect.width, d.view.h / rect.height);
        setView({ ...d.view, x: d.view.x - (e.clientX - d.x) * s, y: d.view.y - (e.clientY - d.y) * s });
      }}
      onPointerUp={() => (drag.current = null)}
      onDoubleClick={() => setView(bounds)}
      role="img"
      aria-label="Graph of what the agent can read"
    >
      {headers?.map((h) => (
        <text key={h.text} className="header" x={h.x} y={h.y} fontSize={10.5 * k}>
          {h.text}
        </text>
      ))}
      <g className="links">
        {links.map((l, i) => {
          const a = byId.get(l.a);
          const b = byId.get(l.b);
          if (!a || !b) return null;
          const touches = !!active && (l.a === active || l.b === active);
          const cls = `link${touches ? " on" : ""}${dimming && !touches ? " dim" : ""}${l.current === false ? " past" : ""}`;
          const mx = (a.x + b.x) / 2;
          return (
            <g key={`${l.a}-${l.b}-${i}`}>
              {l.curved ? (
                <path className={cls} d={`M${a.x} ${a.y}C${mx} ${a.y} ${mx} ${b.y} ${b.x} ${b.y}`} />
              ) : (
                <line className={cls} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
              )}
              {l.label && (
                <text className="link-label" x={a.x + (b.x - a.x) * 0.55} y={a.y + (b.y - a.y) * 0.55} dy="0.35em" fontSize={10.5 * k} strokeWidth={3 * k}>
                  {l.label.length > 30 ? `${l.label.slice(0, 29)}…` : l.label}
                </text>
              )}
            </g>
          );
        })}
      </g>
      {nodes.map((n) => {
        const label = n.label.length > 28 ? `${n.label.slice(0, 27)}…` : n.label;
        const at = n.labelAt ?? "below";
        const show = n.labelled !== false || n.id === hovered || n.id === selected;
        return (
          <g
            key={n.id}
            className={`node ${n.kind}${n.type ? ` t-${n.type}` : ""}${n.id === selected ? " selected" : ""}${dimming && !near.has(n.id) ? " dim" : ""}`}
            transform={`translate(${n.x} ${n.y})`}
            onClick={() => onSelect(n.id)}
            onPointerEnter={() => setHovered(n.id)}
            onPointerLeave={() => setHovered(undefined)}
            tabIndex={0}
            onKeyDown={(e) => e.key === "Enter" && onSelect(n.id)}
          >
            <circle r={n.r * k} strokeWidth={2 * k} />
            {n.kind === "agent" && (
              <text className="glyph" dy="0.35em" fontSize={9.5 * k}>
                ALRO
              </text>
            )}
            {show && (
              <text
                className="name"
                x={at === "right" ? (n.r + 6) * k : at === "left" ? -(n.r + 6) * k : 0}
                dy={at === "below" ? (n.r + 14) * k : "0.35em"}
                textAnchor={at === "right" ? "start" : at === "left" ? "end" : "middle"}
                fontSize={(n.kind === "entity" ? 12 : 12.5) * k}
                strokeWidth={4 * k}
              >
                {label}
                {n.sublabel && (
                  <tspan className="sublabel" x={at === "right" ? (n.r + 6) * k : at === "left" ? -(n.r + 6) * k : 0} dy={15 * k} fontSize={10.5 * k}>
                    {n.sublabel.length > 34 ? `${n.sublabel.slice(0, 33)}…` : n.sublabel}
                  </tspan>
                )}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function Details({ data, id, onSelect }: { data: GraphData; id: string; onSelect: (id: string) => void }) {
  const name = (entityId: string) => data.entities.find((e) => e.id === entityId)?.name ?? "?";
  const typeOf = (entityId: string) => data.entities.find((e) => e.id === entityId)?.type;
  const chip = (target: string, label: string, extra?: string, type?: string) => (
    <button key={target} className="chip-button" onClick={() => onSelect(target)}>
      {type && <i className={`swatch t-${type}`} />}
      {label}
      {extra && <span className="muted"> {extra}</span>}
    </button>
  );

  const entity = data.entities.find((e) => e.id === id);
  const thread = data.threads.find((t) => t.id === id);

  if (id.startsWith("source:")) {
    const key = id.slice("source:".length);
    const list = data.threads.filter((t) => t.source === key);
    return (
      <aside className="graph-details">
        <p className="label">Source</p>
        <h2>{list[0]?.sourceLabel ?? key}</h2>
        <p className="muted small">
          {list.length} conversation{list.length === 1 ? "" : "s"} · {list.reduce((n, t) => n + t.messages, 0).toLocaleString("en-US")} messages
        </p>
        <ul className="detail-list">
          {list.map((t) => (
            <li key={t.id}>
              <button className="link-button" onClick={() => onSelect(t.id)}>
                {t.title}
              </button>
              <span className="muted small">
                {t.messages} msgs{t.lastAt ? ` · last ${date(t.lastAt)}` : ""}
              </span>
            </li>
          ))}
        </ul>
      </aside>
    );
  }

  if (thread) {
    const here = data.places.filter((p) => p.threadId === id).sort((a, b) => b.n - a.n);
    return (
      <aside className="graph-details">
        <p className="label">{thread.sourceLabel} conversation</p>
        <h2>{thread.title}</h2>
        <p className="muted small">
          {thread.messages} messages{thread.lastAt ? ` · last ${date(thread.lastAt)}` : ""}
        </p>
        <p className="label">Talked about ({here.length})</p>
        {here.length ? (
          <div className="chips">{here.slice(0, 40).map((p) => chip(p.entityId, name(p.entityId), `×${p.n}`, typeOf(p.entityId)))}</div>
        ) : (
          <p className="muted small">Not in the graph yet.</p>
        )}
      </aside>
    );
  }

  if (entity) {
    const facts = data.edges.filter((e) => e.source === id || e.target === id);
    const current = facts.filter((f) => f.current);
    const earlier = facts.filter((f) => !f.current);
    const where = data.places.filter((p) => p.entityId === id);
    const fact = (f: GraphData["edges"][number]) => (
      <li key={f.id} className={f.current ? "" : "past"}>
        <span className="small">{f.fact}</span>
        <span className="muted small">
          {f.validFrom ? date(f.validFrom) : ""}
          {!f.current && f.validTo ? ` → replaced ${date(f.validTo)}` : ""}
        </span>
      </li>
    );
    return (
      <aside className="graph-details">
        <p className="label">
          <i className={`swatch t-${entity.type}`} /> {TYPE_LABEL[entity.type] ?? entity.type}
        </p>
        <h2>{entity.name}</h2>
        {entity.summary && <p className="small">{entity.summary}</p>}
        <p className="label">What&apos;s true now ({current.length})</p>
        {current.length ? <ul className="detail-list">{current.map(fact)}</ul> : <p className="muted small">No facts yet.</p>}
        {earlier.length > 0 && (
          <details>
            <summary className="label">Earlier, since replaced ({earlier.length})</summary>
            <ul className="detail-list">{earlier.map(fact)}</ul>
          </details>
        )}
        <p className="label">Mentioned in</p>
        <div className="chips">{where.map((p) => chip(p.threadId, data.threads.find((t) => t.id === p.threadId)?.title ?? "conversation", `×${p.n}`))}</div>
        <EntityEdit key={entity.id} entity={entity} all={data.entities} />
      </aside>
    );
  }

  const sources = [...new Set(data.threads.map((t) => t.source))];
  return (
    <aside className="graph-details">
      <p className="label">Agent</p>
      <h2>ALRO</h2>
      <p className="muted small">
        Answers from {data.threads.length} conversation{data.threads.length === 1 ? "" : "s"} across {sources.length} source{sources.length === 1 ? "" : "s"}, through a
        knowledge graph of {data.entities.length} entities and {data.edges.filter((e) => e.current).length} current facts.
      </p>
      <p className="label">Sources</p>
      <div className="chips">{sources.map((s) => chip(`source:${s}`, data.threads.find((t) => t.source === s)!.sourceLabel))}</div>
    </aside>
  );
}

/** Fix the graph by hand: rename, fold a duplicate into the real thing, or hide noise. */
function EntityEdit({ entity, all }: { entity: GraphData["entities"][number]; all: GraphData["entities"] }) {
  const [mode, setMode] = useState<"rename" | "merge">();
  const [value, setValue] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string>();
  const run = (fn: () => Promise<void>) =>
    startTransition(async () => {
      try {
        setError(undefined);
        await fn();
        setMode(undefined);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed");
      }
    });
  const target = all.find((e) => e.id !== entity.id && e.name.toLowerCase() === value.trim().toLowerCase());

  return (
    <div className="entity-edit">
      <p className="label">Fix</p>
      {!mode && (
        <div className="chips">
          <button className="chip-button" onClick={() => (setMode("rename"), setValue(entity.name))}>
            Rename
          </button>
          <button className="chip-button" onClick={() => (setMode("merge"), setValue(""))}>
            Same as…
          </button>
          <button
            className="chip-button"
            disabled={pending}
            onClick={() => window.confirm(`Hide "${entity.name}" from the graph, search and answers?`) && run(() => hideEntity(entity.id))}
          >
            Hide
          </button>
        </div>
      )}
      {mode && (
        <form
          className="entity-edit-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (mode === "rename") run(() => renameEntity(entity.id, value));
            else if (target) run(() => mergeEntity(entity.id, target.id));
          }}
        >
          <input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            list={mode === "merge" ? `merge-${entity.id}` : undefined}
            placeholder={mode === "merge" ? "The entity this really is" : "New name"}
            aria-label={mode === "merge" ? "Merge into" : "New name"}
          />
          {mode === "merge" && (
            <datalist id={`merge-${entity.id}`}>
              {all.filter((e) => e.id !== entity.id).map((e) => (
                <option key={e.id} value={e.name} />
              ))}
            </datalist>
          )}
          <div className="chips">
            <button type="submit" className="chip-button" disabled={pending || (mode === "merge" ? !target : !value.trim())}>
              {mode === "merge" ? (target ? `Merge into ${target.name}` : "Pick an entity") : "Save"}
            </button>
            <button type="button" className="chip-button" onClick={() => setMode(undefined)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}
