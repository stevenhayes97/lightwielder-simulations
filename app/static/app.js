// Lightwielder DB: schema-driven CRUD UI (vanilla JS, no build step).
"use strict";

const BASE_STATS = ["hp", "strength", "intelligence", "stamina"];
const GEAR_STATS = ["armor", "attack", "damage", "speed", "resistance"];
const STAT_LABEL = { hp: "HP", strength: "STR", intelligence: "INT", stamina: "STA",
  armor: "Armor", attack: "Attack", damage: "Damage", speed: "Speed", resistance: "Resist" };
const LIST_HIDDEN = new Set(["bio", "lore", "description", "created_at", "updated_at"]);
const TEXTAREA = new Set(["bio", "notes", "description", "lore"]);
const SYSTEM_COLS = new Set(["id", "created_at", "updated_at"]);

const state = { meta: null, lookups: {}, sort: {}, filters: {} };
const $ = (sel, el = document) => el.querySelector(sel);
const main = $("#main");

// ------------------------------------------------------------------ helpers
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pretty = (s) => s.replace(/_id$/, "").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

async function api(method, path, body) {
  const res = await fetch("/api/" + path, {
    method, headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 2200);
}

// Tables that have their own "sheet" page, keyed by table -> route word
const SHEETS = { characters: "character", items: "item", loadouts: "loadout", effects: "effect", factions: "faction" };

async function loadLookups() {
  // every table with a label column is used to show FK values by name
  const tables = Object.keys(state.meta).filter((t) => state.meta[t].label);
  const results = await Promise.all(tables.map((t) => api("GET", t)));
  state.lookups = Object.fromEntries(tables.map((t, i) => [t, results[i]]));
  state.labels = {};
  for (const [t, rows] of Object.entries(state.lookups)) {
    const col = state.meta[t].label;
    state.labels[t] = new Map(rows.map((r) => [r.id, t === "characters" ? fullName(r) : r[col]]));
  }
  state.seq = new Map(state.lookups.story_points.map((s) => [s.id, s.sequence]));
}

// "Alexander IV" (titles are versioned in character_titles, so they're not part of the name)
const charName = (id, fallback) => state.labels.characters?.get(id) ?? fallback;
const fullName = (c) => [c.name, c.suffix].filter(Boolean).join(" ");
// Fields shown first in forms, in this order (older DBs append new columns at the end)
const PLACEHOLDER = { suffix: "e.g. IV, Jr.", title: "e.g. the Great", nickname: "e.g. Sandy", rank: "e.g. Knight-Captain" };
const FIELD_ORDER = { characters: ["name", "suffix", "nickname"] };
function orderedColumns(table) {
  const first = FIELD_ORDER[table] || [];
  const cols = state.meta[table].columns;
  return [...first.map((n) => cols.find((c) => c.name === n)).filter(Boolean), ...cols.filter((c) => !first.includes(c.name))];
}
const signed = (n, pct) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n)}${pct ? "%" : ""}`;
// "+2 gear · −3 effects" (or with "base N · " prefix) from a /simulate parts entry
function partsText(p, withBase) {
  const bits = withBase ? [`base ${p.base}`] : [];
  if (p.gear_flat) bits.push(`${signed(p.gear_flat)} gear`);
  if (p.gear_pct) bits.push(`${signed(p.gear_pct, true)} gear`);
  if (p.effect_flat) bits.push(`${signed(p.effect_flat)} effects`);
  if (p.effect_pct) bits.push(`${signed(p.effect_pct, true)} effects`);
  return bits.join(" · ");
}
// "Knight · Example Order" (+ " (secretly Example Cult)") from an affiliation row
function affilText(a, html) {
  if (!a) return "";
  const name = (fid) => state.labels.factions?.get(fid) ?? `#${fid}`;
  const faction = a.faction_id ? (a.faction ?? name(a.faction_id)) : "unaffiliated";
  const link = (fid, label) => html && fid ? `<a href="#/faction/${fid}">${esc(label)}</a>` : html ? esc(label) : label;
  let t = [a.rank && (html ? esc(a.rank) : a.rank), link(a.faction_id, faction)].filter(Boolean).join(" · ");
  if (a.secret_faction_id) {
    const sec = link(a.secret_faction_id, a.secret_faction ?? name(a.secret_faction_id));
    t += html ? ` <span class="badge secret" title="True loyalty, hidden from others">secretly ${sec}</span>` : ` (secretly ${sec})`;
  }
  return t;
}
const modText = (m) => `${signed(m.amount, m.mod_type === "percent")} ${STAT_LABEL[m.stat] || m.stat}`;

function colMeta(table, name) { return state.meta[table].columns.find((c) => c.name === name); }

function fmtCell(table, col, v) {
  if ((v === null || v === "") && table === "loadouts" && col.name === "character_id") return `<span class="badge">generic</span>`;
  if (v === null || v === undefined || v === "") return `<span class="null">-</span>`;
  if (col.fk) {
    const label = state.labels[col.fk.table]?.get(v);
    return esc(label ?? `#${v}`);
  }
  if (col.boolean) return v ? `<span class="badge on">yes</span>` : `<span class="badge">no</span>`;
  if (col.name === "status") return `<span class="badge ${v === "alive" ? "on" : v === "dead" ? "dead" : ""}">${esc(v)}</span>`;
  return esc(v);
}

function rowLabel(table, row) {
  const col = state.meta[table].label;
  if (col && row[col]) return row[col];
  if (table === "character_affiliations") return `${state.labels.characters.get(row.character_id)} @ ${state.labels.story_points.get(row.story_point_id)}: ${affilText(row)}`;
  if (table === "character_titles") return `${state.labels.characters.get(row.character_id)} @ ${state.labels.story_points.get(row.story_point_id)}: ${row.title ?? "no title"}`;
  if (table === "character_stats") return `${state.labels.characters.get(row.character_id)} @ ${state.labels.story_points.get(row.story_point_id)}`;
  if (table === "character_equipment") return `${state.labels.items.get(row.item_id)} → ${state.labels.characters.get(row.character_id)}`;
  if (table === "item_modifiers") return `${state.labels.items.get(row.item_id)}: ${modText(row)}`;
  if (table === "effect_modifiers") return `${state.labels.effects.get(row.effect_id)}: ${modText(row)}`;
  if (table === "character_effects") return `${state.labels.effects.get(row.effect_id)} on ${state.labels.characters.get(row.character_id)}`;
  if (table === "loadout_items") return `${state.labels.items.get(row.item_id)} in ${state.labels.loadouts.get(row.loadout_id)}`;
  return `#${row.id}`;
}

// ------------------------------------------------------------------ nav / routing
const NAV_GROUPS = [
  ["Roster", ["characters", "character_stats", "character_affiliations", "character_titles", "factions", "story_points"]],
  ["Gear", ["items", "item_modifiers", "character_equipment"]],
  ["Effects", ["effects", "effect_modifiers", "character_effects"]],
  ["Loadouts", ["loadouts", "loadout_items"]],
];
function renderNav(active) {
  const link = (href, key, title) => `<a href="${href}" class="${active === key ? "active" : ""}">${esc(title)}</a>`;
  $("#nav").innerHTML =
    link("#/lab", "lab", "⚖ Loadout Lab") + link("#/t/effective", "effective", "Effective Stats") +
    NAV_GROUPS.map(([g, ts]) => `<div class="nav-group">${g}</div>` +
      ts.filter((t) => state.meta[t]).map((t) => link(`#/t/${t}`, t, state.meta[t].title)).join("")).join("");
}

async function route() {
  $("#nav").classList.remove("open");
  const [, kind, arg] = (location.hash || "#/t/characters").split("/");
  try {
    if (kind === "character") { renderNav("characters"); await renderCharacterSheet(+arg); }
    else if (kind === "item") { renderNav("items"); await renderItemSheet(+arg); }
    else if (kind === "loadout") { renderNav("loadouts"); await renderLoadoutSheet(+arg); }
    else if (kind === "effect") { renderNav("effects"); await renderEffectSheet(+arg); }
    else if (kind === "faction") { renderNav("factions"); await renderFactionSheet(+arg); }
    else if (kind === "lab") { renderNav("lab"); await renderLab(); }
    else if (arg === "effective") { renderNav("effective"); await renderEffective(); }
    else if (state.meta[arg]) { renderNav(arg); await renderTable(arg); }
    else location.hash = "#/t/characters";
  } catch (e) {
    main.innerHTML = `<div class="error">${esc(e.message)}</div>`;
  }
  main.focus({ preventScroll: true });
}

// ------------------------------------------------------------------ generic table view
async function renderTable(table) {
  const m = state.meta[table];
  const filters = state.filters[table] || (state.filters[table] = {});
  const params = new URLSearchParams(Object.entries(filters).filter(([, v]) => v !== ""));
  let rows = await api("GET", `${table}?${params}`);
  const sort = state.sort[table];
  if (sort) {
    rows.sort((a, b) => {
      const x = a[sort.col], y = b[sort.col];
      if (x === y) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * sort.dir;
    });
  }
  const cols = orderedColumns(table).filter((c) => !LIST_HIDDEN.has(c.name));
  const fkCols = m.columns.filter((c) => c.fk);
  const hasSheet = table in SHEETS;

  main.innerHTML = `
    <div class="page-head">
      <h1>${esc(m.title)}</h1><span class="sub">${rows.length} row${rows.length === 1 ? "" : "s"}</span>
      <span class="spacer"></span>
      <button class="btn primary" id="new-row">+ New</button>
    </div>
    <div class="toolbar">
      <input type="search" id="q" placeholder="Search text…" value="${esc(filters.q || "")}">
      ${fkCols.map((c) => `
        <select data-filter="${c.name}" aria-label="Filter by ${esc(pretty(c.name))}">
          <option value="">All ${esc(pretty(c.name).toLowerCase())}s</option>
          ${state.lookups[c.fk.table].map((r) => `<option value="${r.id}" ${String(filters[c.name]) === String(r.id) ? "selected" : ""}>${esc(state.labels[c.fk.table].get(r.id))}</option>`).join("")}
        </select>`).join("")}
    </div>
    <div class="table-wrap">
      ${rows.length ? `<table>
        <thead><tr>${cols.map((c) => `<th class="sortable ${isNum(c) ? "num" : ""}" data-col="${c.name}">${esc(pretty(c.name))}${sort?.col === c.name ? (sort.dir > 0 ? " ▲" : " ▼") : ""}</th>`).join("")}${hasSheet ? "<th></th>" : ""}</tr></thead>
        <tbody>${rows.map((r) => `<tr class="clickable" data-id="${r.id}">${cols.map((c) =>
          `<td class="${isNum(c) && !c.fk ? "num" : ""} ${c.type === "TEXT" ? "trunc" : ""}">${fmtCell(table, c, r[c.name])}</td>`).join("")}
          ${hasSheet ? `<td><a class="btn small" href="#/${SHEETS[table]}/${r.id}" data-stop>Sheet →</a></td>` : ""}</tr>`).join("")}
        </tbody></table>` : `<div class="empty">Nothing here yet. Click <b>+ New</b> to add one.</div>`}
    </div>`;

  const reload = () => renderTable(table);
  $("#new-row").onclick = () => openForm(table, null, { ...pickFilters(filters) }, reload);
  let qTimer;
  $("#q").oninput = (e) => { clearTimeout(qTimer); qTimer = setTimeout(() => { filters.q = e.target.value; reload().then(() => { const q = $("#q"); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }); }, 250); };
  main.querySelectorAll("[data-filter]").forEach((s) => s.onchange = () => { filters[s.dataset.filter] = s.value; reload(); });
  main.querySelectorAll("th.sortable").forEach((th) => th.onclick = () => {
    const col = th.dataset.col, cur = state.sort[table];
    state.sort[table] = cur?.col === col ? { col, dir: -cur.dir } : { col, dir: 1 };
    reload();
  });
  main.querySelectorAll("tr.clickable").forEach((tr) => tr.onclick = (e) => {
    if (e.target.closest("[data-stop]")) return;
    openForm(table, rows.find((r) => r.id === +tr.dataset.id), null, reload);
  });
}

const isNum = (c) => c.type === "INTEGER" || c.type === "REAL";
function pickFilters(f) { const o = {}; for (const [k, v] of Object.entries(f)) if (k !== "q" && v !== "") o[k] = +v; return o; }

// ------------------------------------------------------------------ form drawer
function parseDefault(d) {
  if (d === null || d === undefined || d.startsWith("(")) return "";
  return d.replace(/^'(.*)'$/, "$1");
}

function fieldHtml(table, c, value) {
  const id = `f-${c.name}`;
  const req = c.notnull && c.default === null;
  const label = `<label for="${id}">${esc(pretty(c.name))}${req ? ' <span class="req">*</span>' : ""}</label>`;
  const v = value ?? "";
  if (c.boolean) {
    return `<div class="field check"><input type="checkbox" id="${id}" name="${c.name}" ${v === 1 || v === "1" ? "checked" : ""}>${label}</div>`;
  }
  let input;
  if (c.fk) {
    const opts = state.lookups[c.fk.table].map((r) =>
      `<option value="${r.id}" ${String(v) === String(r.id) ? "selected" : ""}>${esc(state.labels[c.fk.table].get(r.id))}${c.fk.table === "story_points" ? ` (${r.sequence})` : ""}</option>`).join("");
    const blank = c.notnull ? `<option value="" disabled ${v === "" ? "selected" : ""}>Choose…</option>` : `<option value="">${c.name === "faction_id" ? "- unaffiliated -" : c.name === "secret_faction_id" ? "- none -" : c.name.startsWith("until") ? (table === "character_effects" ? "- ongoing -" : "- still held -") : c.name === "character_id" ? "- generic (any character) -" : "-"}</option>`;
    input = `<select id="${id}" name="${c.name}" ${req ? "required" : ""}>${blank}${opts}</select>`;
  } else if (c.options) {
    input = `<select id="${id}" name="${c.name}">${c.notnull ? "" : '<option value="">-</option>'}${c.options.map((o) =>
      `<option ${String(v) === String(o) ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
  } else if (TEXTAREA.has(c.name)) {
    input = `<textarea id="${id}" name="${c.name}">${esc(v)}</textarea>`;
  } else if (isNum(c)) {
    input = `<input type="number" id="${id}" name="${c.name}" value="${esc(v)}" step="${c.type === "REAL" ? "any" : "1"}" ${req ? "required" : ""}>`;
  } else {
    const ph = PLACEHOLDER[c.name] ? ` placeholder="${esc(PLACEHOLDER[c.name])}"` : "";
    input = `<input type="text" id="${id}" name="${c.name}" value="${esc(v)}"${ph} ${req ? "required" : ""}>`;
  }
  const wide = TEXTAREA.has(c.name) || c.name === "change_reason" || c.name === "name";
  return `<div class="field ${wide ? "wide" : ""}">${label}${input}</div>`;
}

function openForm(table, row, presets, onSaved) {
  const m = state.meta[table];
  const dlg = $("#drawer"), form = $("#drawer-form"), err = $("#drawer-error");
  const isNew = !row;
  const singular = m.title.replace(/s$/, "").replace(/ies$/, "y");
  $("#drawer-title").textContent = isNew ? `New ${singular}` : `Edit ${rowLabel(table, row)}`;
  err.hidden = true;
  const values = {};
  for (const c of m.columns) values[c.name] = isNew ? parseDefault(c.default) : row[c.name];
  Object.assign(values, presets || {});
  $("#drawer-fields").innerHTML = orderedColumns(table).filter((c) => !SYSTEM_COLS.has(c.name))
    .map((c) => fieldHtml(table, c, values[c.name])).join("");
  const del = $("#drawer-delete");
  del.hidden = isNew;
  del.onclick = async () => {
    if (!confirm(`Delete "${rowLabel(table, row)}"? This cannot be undone.`)) return;
    try {
      await api("DELETE", `${table}/${row.id}`);
      dlg.close(); toast("Deleted");
      await loadLookups(); onSaved?.(null);
    } catch (e) { err.textContent = e.message; err.hidden = false; }
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = {};
    for (const c of m.columns) {
      if (SYSTEM_COLS.has(c.name)) continue;
      const el = form.elements[c.name];
      if (c.boolean) body[c.name] = el.checked ? 1 : 0;
      else if (el.value === "") body[c.name] = null;
      else body[c.name] = isNum(c) ? Number(el.value) : el.value;
    }
    try {
      const saved = isNew ? await api("POST", table, body) : await api("PUT", `${table}/${row.id}`, body);
      dlg.close(); toast(isNew ? "Created" : "Saved");
      await loadLookups(); onSaved?.(saved);
    } catch (ex) { err.textContent = ex.message; err.hidden = false; err.scrollIntoView({ block: "nearest" }); }
  };
  dlg.showModal();
  const first = $("#drawer-fields").querySelector("input:not([type=checkbox]), select, textarea");
  first?.focus();
}
document.querySelectorAll("[data-close]").forEach((b) => b.onclick = () => $("#drawer").close());

// ------------------------------------------------------------------ character sheet
async function renderCharacterSheet(id) {
  const sheet = await api("GET", `characters/${id}/sheet`);
  const { character: ch, stats, equipment, effects: charEffects, affiliations: affils, titles, effective } = sheet;
  const statById = new Map(stats.map((s) => [s.id, s]));
  const reload = () => renderCharacterSheet(id);
  const sel = state.sheetPoint?.[id];
  const pointIds = effective.map((e) => e.story_point_id);
  const point = pointIds.includes(sel) ? sel : pointIds[pointIds.length - 1];
  const cur = effective.find((e) => e.story_point_id === point);
  const usedGear = GEAR_STATS.filter((s) => effective.some((e) => e[s] !== 0));
  const seqOf = (spid) => state.seq.get(spid);
  const pointSeq = seqOf(point);
  const activeAt = (eq) => pointSeq !== undefined && eq.from_sequence <= pointSeq && (eq.until_sequence === null || eq.until_sequence > pointSeq);
  // per-stat breakdown (base / gear / effects) for the selected point; same math as the view
  const sim = cur ? await api("GET", `simulate?character_id=${id}&story_point_id=${point}&current=1&story_effects=1`) : null;
  const parts = sim?.columns[0]?.parts;
  const activeEffects = charEffects.filter(activeAt);
  // rank & faction version in effect at the selected point (latest one if no stat point is selected)
  const affilNow = pointSeq === undefined ? affils[affils.length - 1] : [...affils].reverse().find((a) => a.sequence <= pointSeq);
  const affilById = new Map(affils.map((a) => [a.id, a]));
  // title version in effect at the selected point, same rule as rank & faction
  const titleNow = pointSeq === undefined ? titles[titles.length - 1] : [...titles].reverse().find((t) => t.sequence <= pointSeq);
  const titleById = new Map(titles.map((t) => [t.id, t]));

  const fact = (k, v) => v ? `<div><div class="k">${k}</div>${esc(v)}</div>` : "";
  const cell = (e, s, prev) => {
    const isBase = BASE_STATS.includes(s);
    const base = isBase ? statById.get(e.stats_id)[s] : 0;
    const mod = isBase ? e[s] - base : 0;
    const d = prev ? e[s] - prev[s] : 0;
    return `<td class="num">${e[s]}${mod ? `<span class="gear" title="base ${base}, gear & effects ${signed(mod)}">(${signed(mod)})</span>` : ""}${d ? ` <span class="${d > 0 ? "up" : "down"}">${d > 0 ? "▲" : "▼"}${Math.abs(d)}</span>` : ""}</td>`;
  };

  main.innerHTML = `
    <div class="page-head">
      <div><h1>${esc(fullName(ch))}${titleNow?.title ? ` <span class="sub">${esc(titleNow.title)}</span>` : ""}</h1>
      ${ch.nickname ? `<div class="sub">“${esc(ch.nickname)}”</div>` : ""}
      <div class="sub">${[ch.race, ch.class, ch.subclass].filter(Boolean).map(esc).join(" · ") || "No class set"}
        <span class="badge ${ch.status === "alive" ? "on" : ch.status === "dead" ? "dead" : ""}">${esc(ch.status)}</span>
        ${ch.role ? `<span class="badge">${esc(ch.role)}</span>` : ""}</div>
      ${affilNow ? `<div class="sub">${affilText(affilNow, true)}${point !== undefined ? ` <span class="null">at ${esc(state.labels.story_points.get(point))}</span>` : ""}</div>` : ""}</div>
      <span class="spacer"></span>
      <a class="btn" href="#/t/characters">← Roster</a>
      <button class="btn" id="edit-char">Edit</button>
    </div>
    <div class="detail">${fact("Class", [ch.class, ch.subclass].filter(Boolean).join(" / "))}${fact("Rank", affilNow?.rank)}${affilNow ? `<div><div class="k">Faction</div>${affilNow.faction_id ? `<a href="#/faction/${affilNow.faction_id}">${esc(affilNow.faction)}</a>` : "unaffiliated"}</div>` : ""}${affilNow?.secret_faction_id ? `<div><div class="k">Secret loyalty</div><a href="#/faction/${affilNow.secret_faction_id}">${esc(affilNow.secret_faction)}</a></div>` : ""}${fact("Alignment", ch.alignment)}${fact("Age", ch.age)}</div>
    ${ch.bio ? `<h3>Bio</h3><div class="prose">${esc(ch.bio)}</div>` : ""}

    <h3>Effective stats at
      <select id="point">${effective.map((e) => `<option value="${e.story_point_id}" ${e.story_point_id === point ? "selected" : ""}>${esc(e.story_point)}</option>`).join("")}</select>
    </h3>
    ${cur ? `<div class="cards">${[...BASE_STATS, ...usedGear].map((s) => {
      const p = parts?.[s];
      const detail = p && BASE_STATS.includes(s) ? partsText(p, false) : "";
      return `<div class="card" title="${p ? esc(partsText(p, true)) : ""}"><div class="k">${STAT_LABEL[s]}</div><div class="v">${cur[s]}</div>${detail ? `<div class="card-sub">${esc(p.base)} ${esc(detail)}</div>` : ""}</div>`;
    }).join("")}</div>
    ${cur.is_snapshot ? "" : `<p class="sub">No stat version recorded at this point; base stats carried forward from <b>${esc(statById.get(cur.stats_id).story_point)}</b>.</p>`}`
    : `<div class="empty">No stat versions yet. Add one below.</div>`}

    <h3>Gear at this point</h3>
    ${tableHtml(["Item", "Category", "Slot", "State"], equipment.filter(activeAt).map((e) =>
      `<tr class="${e.equipped ? "" : "carried"}"><td><a href="#/item/${e.item_id}">${esc(e.item_name)}</a>${e.quantity > 1 ? ` ×${e.quantity}` : ""}</td><td>${esc(e.category)}</td><td>${esc(e.slot ?? "-")}</td><td>${e.equipped ? '<span class="badge on">equipped</span>' : '<span class="badge">carried</span>'}</td></tr>`), "Nothing held at this point.")}

    <h3>Effects at this point</h3>
    ${tableHtml(["Effect", "Modifiers", "Since", "Until", "Cause"], activeEffects.map((e) => {
      const ef = sim?.effects.find((x) => x.character_effect_id === e.id);
      return `<tr><td><a href="#/effect/${e.effect_id}">${esc(e.effect_name)}</a> <span class="badge ${e.kind}">${esc(e.kind)}</span></td><td>${esc(ef ? ef.modifiers.filter((m) => !m.condition).map(modText).join(", ") : "")}</td><td>${esc(e.from_label)}</td><td>${e.until_label ? esc(e.until_label) : '<span class="null">ongoing</span>'}</td><td class="trunc">${esc(e.cause ?? "")}</td></tr>`;
    }), "No buffs or debuffs at this point.")}

    <h3>Progression <span class="spacer"></span></h3>
    <div class="toolbar"><button class="btn primary" id="add-stats">+ Stat version</button>
      <span class="sub">Numbers include gear and effects (their net change in brackets); ▲▼ is the change from the previous point. Click a row to edit its stat version.</span></div>
    ${tableHtml(["Story point", ...BASE_STATS.map((s) => STAT_LABEL[s]), ...usedGear.map((s) => STAT_LABEL[s]), "Reason"],
      effective.map((e, i) => {
        const sv = statById.get(e.stats_id);
        return `<tr class="clickable ${e.story_point_id === point ? "selected" : ""}" data-stats="${e.stats_id}"><td>${esc(e.story_point)}${e.is_snapshot ? "" : ' <span class="badge" title="No stat version here; carried forward">carried</span>'}</td>${[...BASE_STATS, ...usedGear].map((s) => cell(e, s, effective[i - 1])).join("")}<td class="trunc">${e.is_snapshot ? esc(sv.change_reason ?? "") : ""}</td></tr>`;
      }), "No stat versions yet.", [...BASE_STATS, ...usedGear].map(() => "num"))}

    <h3>Rank &amp; faction history</h3>
    <div class="toolbar"><button class="btn primary" id="add-affil">+ Rank / faction version</button>
      <span class="sub">Each version carries forward until the next. Add one where a promotion, defection or betrayal happens. Click a row to edit.</span></div>
    ${tableHtml(["Story point", "Rank", "Faction", "Secret loyalty", "Reason"], affils.map((a, i) => {
      const prev = affils[i - 1];
      const changed = (k) => prev && prev[k] !== a[k] ? ' class="changed"' : "";
      return `<tr class="clickable ${affilNow?.id === a.id ? "selected" : ""}" data-affil="${a.id}"><td>${esc(a.story_point)}</td><td${changed("rank")}>${esc(a.rank ?? "")}</td><td${changed("faction_id")}>${a.faction_id ? esc(a.faction) : '<span class="null">unaffiliated</span>'}</td><td${changed("secret_faction_id")}>${a.secret_faction_id ? `<span class="badge secret">${esc(a.secret_faction)}</span>` : ""}</td><td class="trunc">${esc(a.change_reason ?? "")}</td></tr>`;
    }), "No rank or faction recorded yet.")}

    <h3>Title history</h3>
    <div class="toolbar"><button class="btn primary" id="add-title">+ Title version</button>
      <span class="sub">A title carries forward until the next version. Leave the title blank to record that it was lost. Click a row to edit.</span></div>
    ${tableHtml(["Story point", "Title", "Reason"], titles.map((t) =>
      `<tr class="clickable ${titleNow?.id === t.id ? "selected" : ""}" data-title="${t.id}"><td>${esc(t.story_point)}</td><td>${t.title ? esc(t.title) : '<span class="null">no title</span>'}</td><td class="trunc">${esc(t.change_reason ?? "")}</td></tr>`),
      "No title yet.")}

    <h3>Equipment history</h3>
    <div class="toolbar"><button class="btn primary" id="add-gear">+ Give item</button></div>
    ${tableHtml(["Item", "From", "Until", "State", "Qty", "Notes"], equipment.map((e) =>
      `<tr class="clickable" data-eq="${e.id}"><td>${esc(e.item_name)}</td><td>${esc(e.from_label)}</td><td>${e.until_label ? esc(e.until_label) : '<span class="null">still held</span>'}</td><td>${e.equipped ? "equipped" : "carried"}</td><td class="num">${e.quantity}</td><td class="trunc">${esc(e.notes ?? "")}</td></tr>`), "No gear yet.")}

    <h3>Effect history</h3>
    <div class="toolbar"><button class="btn primary" id="add-effect">+ Apply effect</button>
      <span class="sub">E.g. injured from Ch. 7 until Ch. 9. Leave “until” blank if it's ongoing.</span></div>
    ${tableHtml(["Effect", "From", "Until", "Cause", "Notes"], charEffects.map((e) =>
      `<tr class="clickable" data-cef="${e.id}"><td>${esc(e.effect_name)} <span class="badge ${e.kind}">${esc(e.kind)}</span></td><td>${esc(e.from_label)}</td><td>${e.until_label ? esc(e.until_label) : '<span class="null">ongoing</span>'}</td><td class="trunc">${esc(e.cause ?? "")}</td><td class="trunc">${esc(e.notes ?? "")}</td></tr>`),
      "No effects recorded on the timeline.")}

    <h3>Loadouts</h3>
    <div class="toolbar">
      <button class="btn primary" id="add-loadout">+ Loadout</button>
      <button class="btn" id="save-loadout" ${equipment.some(activeAt) ? "" : "disabled"}>Save gear at this point as loadout</button>
      <a class="btn" href="#/lab" id="open-lab">⚖ Compare in Loadout Lab</a>
    </div>
    ${tableHtml(["Loadout", "Purpose", "Description"], state.lookups.loadouts.filter((l) => l.character_id === id).map((l) =>
      `<tr><td><a href="#/loadout/${l.id}">${esc(l.name)}</a></td><td>${esc(l.purpose ?? "")}</td><td class="trunc">${esc(l.description ?? "")}</td></tr>`),
      "No personal loadouts yet. Generic loadouts can still be used in the Lab.")}
    ${ch.notes ? `<h3>Notes</h3><div class="prose">${esc(ch.notes)}</div>` : ""}`;

  $("#add-loadout").onclick = () => openForm("loadouts", null, { character_id: id }, (saved) => saved && (location.hash = `#/loadout/${saved.id}`));
  $("#save-loadout").onclick = async () => {
    const label = state.labels.story_points.get(point);
    const name = prompt("Name for the new loadout:", `${fullName(ch)} @ ${label}`);
    if (!name) return;
    const lo = await api("POST", "loadouts", { name, character_id: id, description: `Snapshot of story gear at ${label}` });
    for (const e of equipment.filter(activeAt)) {
      await api("POST", "loadout_items", { loadout_id: lo.id, item_id: e.item_id, equipped: e.equipped, quantity: e.quantity });
    }
    await loadLookups();
    toast("Loadout saved");
    location.hash = `#/loadout/${lo.id}`;
  };
  $("#open-lab").onclick = () => { setLabCharacter(id, point); };
  $("#add-effect").onclick = () => openForm("character_effects", null, { character_id: id, from_story_point_id: point ?? "" }, reload);
  main.querySelectorAll("[data-cef]").forEach((tr) => tr.onclick = () => {
    const e = charEffects.find((x) => x.id === +tr.dataset.cef);
    const row = {}; for (const c of state.meta.character_effects.columns) row[c.name] = e[c.name];
    openForm("character_effects", row, null, reload);
  });

  $("#edit-char").onclick = () => openForm("characters", ch, null, (saved) => saved ? reload() : (location.hash = "#/t/characters"));
  $("#point").onchange = (e) => { (state.sheetPoint ||= {})[id] = +e.target.value; reload(); };
  $("#add-stats").onclick = () => {
    const last = stats[stats.length - 1];
    const taken = new Set(stats.map((s) => s.story_point_id));
    const nextPoint = state.lookups.story_points.find((sp) => !taken.has(sp.id) && (!last || sp.sequence > last.sequence));
    const preset = { character_id: id, story_point_id: nextPoint?.id ?? "" };
    if (last) for (const s of BASE_STATS) preset[s] = last[s];
    openForm("character_stats", null, preset, reload);
  };
  $("#add-affil").onclick = () => {
    const last = affils[affils.length - 1];
    const taken = new Set(affils.map((a) => a.story_point_id));
    const free = (sp) => !taken.has(sp.id);
    const nextPoint = (point !== undefined && free({ id: point }) ? state.lookups.story_points.find((sp) => sp.id === point) : null)
      ?? state.lookups.story_points.find((sp) => free(sp) && (!last || sp.sequence > last.sequence));
    const preset = { character_id: id, story_point_id: nextPoint?.id ?? "" };
    if (last) Object.assign(preset, { faction_id: last.faction_id, rank: last.rank, secret_faction_id: last.secret_faction_id });
    openForm("character_affiliations", null, preset, reload);
  };
  main.querySelectorAll("[data-affil]").forEach((tr) => tr.onclick = () => {
    const a = affilById.get(+tr.dataset.affil);
    const row = {}; for (const c of state.meta.character_affiliations.columns) row[c.name] = a[c.name];
    openForm("character_affiliations", row, null, reload);
  });
  $("#add-title").onclick = () => {
    const last = titles[titles.length - 1];
    const taken = new Set(titles.map((t) => t.story_point_id));
    const free = (sp) => !taken.has(sp.id);
    const nextPoint = (point !== undefined && free({ id: point }) ? state.lookups.story_points.find((sp) => sp.id === point) : null)
      ?? state.lookups.story_points.find((sp) => free(sp) && (!last || sp.sequence > last.sequence));
    openForm("character_titles", null, { character_id: id, story_point_id: nextPoint?.id ?? "" }, reload);
  };
  main.querySelectorAll("[data-title]").forEach((tr) => tr.onclick = () => {
    const t = titleById.get(+tr.dataset.title);
    const row = {}; for (const c of state.meta.character_titles.columns) row[c.name] = t[c.name];
    openForm("character_titles", row, null, reload);
  });
  $("#add-gear").onclick = () => openForm("character_equipment", null, { character_id: id, from_story_point_id: point ?? "" }, reload);
  main.querySelectorAll("[data-stats]").forEach((tr) => tr.onclick = () => openForm("character_stats", statById.get(+tr.dataset.stats), null, reload));
  main.querySelectorAll("[data-eq]").forEach((tr) => tr.onclick = () => {
    const e = equipment.find((x) => x.id === +tr.dataset.eq);
    const row = {}; for (const c of state.meta.character_equipment.columns) row[c.name] = e[c.name];
    openForm("character_equipment", row, null, reload);
  });
}

function tableHtml(headers, rows, emptyMsg, numCols = []) {
  if (!rows.length) return `<div class="table-wrap"><div class="empty">${emptyMsg}</div></div>`;
  return `<div class="table-wrap"><table><thead><tr>${headers.map((h, i) => `<th class="${numCols[i - 1] || ""}">${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

// ------------------------------------------------------------------ item sheet
async function renderItemSheet(id) {
  const { item, modifiers, holders, loadouts } = await api("GET", `items/${id}/sheet`);
  const reload = () => renderItemSheet(id);
  const fact = (k, v) => (v !== null && v !== "" && v !== undefined) ? `<div><div class="k">${k}</div>${esc(v)}</div>` : "";
  main.innerHTML = `
    <div class="page-head">
      <div><h1>${esc(item.name)}</h1>
      <div class="sub">${[item.rarity, item.subtype || item.category].filter(Boolean).map(esc).join(" · ")}</div></div>
      <span class="spacer"></span>
      <a class="btn" href="#/t/items">← Items</a>
      <button class="btn" id="edit-item">Edit</button>
    </div>
    <div class="detail">${fact("Category", item.category)}${fact("Slot", item.slot)}${fact("Damage", item.damage && `${item.damage}${item.damage_type ? " " + item.damage_type : ""}`)}
      ${fact("Armor rating", item.armor_rating || null)}${fact("Weight", item.weight)}${fact("Value", item.value)}${fact("Req. strength", item.req_strength)}</div>
    ${item.description ? `<h3>Description</h3><div class="prose">${esc(item.description)}</div>` : ""}
    <h3>Modifiers</h3>
    <div class="toolbar"><button class="btn primary" id="add-mod">+ Modifier</button>
      <span class="sub">Modifiers with a condition are situational and left out of effective-stat totals.</span></div>
    ${tableHtml(["Stat", "Amount", "Condition", "Notes"], modifiers.map((m) => {
      const amt = `${m.amount > 0 ? "+" : ""}${m.amount}${m.mod_type === "percent" ? "%" : ""}`;
      return `<tr class="clickable" data-mod="${m.id}"><td>${esc(STAT_LABEL[m.stat] || m.stat)}</td><td class="num ${m.amount >= 0 ? "up" : "down"}">${amt}</td><td>${esc(m.condition ?? "")}</td><td class="trunc">${esc(m.notes ?? "")}</td></tr>`;
    }), "No modifiers.", ["num"])}
    <h3>Held by</h3>
    ${tableHtml(["Character", "From", "Until", "State"], holders.map((h) =>
      `<tr><td><a href="#/character/${h.character_id}">${esc(charName(h.character_id, h.character_name))}</a></td><td>${esc(h.from_label)}</td><td>${h.until_label ? esc(h.until_label) : '<span class="null">still held</span>'}</td><td>${h.equipped ? "equipped" : "carried"}</td></tr>`), "Nobody holds this item.")}
    <h3>In loadouts</h3>
    ${tableHtml(["Loadout", "Owner"], loadouts.map((l) =>
      `<tr><td><a href="#/loadout/${l.id}">${esc(l.name)}</a></td><td>${l.character_id ? esc(charName(l.character_id, l.character_name)) : '<span class="badge">generic</span>'}</td></tr>`), "Not part of any loadout.")}
    ${item.lore ? `<h3>Lore</h3><div class="prose">${esc(item.lore)}</div>` : ""}`;
  $("#edit-item").onclick = () => openForm("items", item, null, (saved) => saved ? reload() : (location.hash = "#/t/items"));
  $("#add-mod").onclick = () => openForm("item_modifiers", null, { item_id: id }, reload);
  main.querySelectorAll("[data-mod]").forEach((tr) => tr.onclick = () => openForm("item_modifiers", modifiers.find((m) => m.id === +tr.dataset.mod), null, reload));
}

// ------------------------------------------------------------------ loadout sheet
async function renderLoadoutSheet(id) {
  const { loadout: lo, items } = await api("GET", `loadouts/${id}/sheet`);
  const reload = () => renderLoadoutSheet(id);
  const owner = lo.character_id ? state.labels.characters.get(lo.character_id) : null;
  main.innerHTML = `
    <div class="page-head">
      <div><h1>${esc(lo.name)}</h1>
      <div class="sub">${owner ? `Loadout for <a href="#/character/${lo.character_id}">${esc(owner)}</a>` : '<span class="badge">generic</span> usable by any character'}
        ${lo.purpose ? ` · ${esc(lo.purpose)}` : ""}</div></div>
      <span class="spacer"></span>
      <a class="btn" href="#/t/loadouts">← Loadouts</a>
      <button class="btn" id="dup-lo">Duplicate</button>
      <button class="btn" id="edit-lo">Edit</button>
    </div>
    ${lo.description ? `<div class="prose">${esc(lo.description)}</div>` : ""}
    <h3>Items</h3>
    <div class="toolbar"><button class="btn primary" id="add-li">+ Add item</button>
      ${owner ? `<a class="btn" href="#/lab" id="lab-lo">⚖ Compare in Loadout Lab</a>` : ""}
      <span class="sub">Unequipped (carried) items count for nothing until equipped.</span></div>
    ${tableHtml(["Item", "Category", "Slot", "State", "Qty", "Notes"], items.map((li) =>
      `<tr class="clickable ${li.equipped ? "" : "carried"}" data-li="${li.id}"><td><a href="#/item/${li.item_id}" data-stop>${esc(li.item_name)}</a></td><td>${esc(li.category)}</td><td>${esc(li.slot ?? "-")}</td><td>${li.equipped ? '<span class="badge on">equipped</span>' : '<span class="badge">carried</span>'}</td><td class="num">${li.quantity}</td><td class="trunc">${esc(li.notes ?? "")}</td></tr>`),
      "Empty loadout. Add some items.")}
    ${lo.notes ? `<h3>Notes</h3><div class="prose">${esc(lo.notes)}</div>` : ""}`;
  $("#edit-lo").onclick = () => openForm("loadouts", lo, null, (saved) => saved ? reload() : (location.hash = "#/t/loadouts"));
  $("#add-li").onclick = () => openForm("loadout_items", null, { loadout_id: id }, reload);
  $("#dup-lo").onclick = async () => {
    const name = prompt("Name for the copy:", `${lo.name} (copy)`);
    if (!name) return;
    const { id: _, ...fields } = lo;
    const copy = await api("POST", "loadouts", { ...fields, name });
    for (const li of items) await api("POST", "loadout_items", { loadout_id: copy.id, item_id: li.item_id, equipped: li.equipped, quantity: li.quantity, notes: li.notes });
    await loadLookups(); toast("Duplicated");
    location.hash = `#/loadout/${copy.id}`;
  };
  if (owner) $("#lab-lo").onclick = () => setLabCharacter(lo.character_id);
  main.querySelectorAll("[data-li]").forEach((tr) => tr.onclick = (e) => {
    if (e.target.closest("[data-stop]")) return;
    const li = items.find((x) => x.id === +tr.dataset.li);
    const row = {}; for (const c of state.meta.loadout_items.columns) row[c.name] = li[c.name];
    openForm("loadout_items", row, null, reload);
  });
}

// ------------------------------------------------------------------ effect sheet
async function renderEffectSheet(id) {
  const { effect: ef, modifiers, characters } = await api("GET", `effects/${id}/sheet`);
  const reload = () => renderEffectSheet(id);
  main.innerHTML = `
    <div class="page-head">
      <div><h1>${esc(ef.name)}</h1>
      <div class="sub"><span class="badge ${ef.kind === "buff" ? "buff" : ef.kind === "debuff" ? "debuff" : ""}">${esc(ef.kind)}</span>
        ${[ef.category, ef.severity].filter(Boolean).map(esc).join(" · ")}</div></div>
      <span class="spacer"></span>
      <a class="btn" href="#/t/effects">← Effects</a>
      <button class="btn" id="edit-ef">Edit</button>
    </div>
    ${ef.description ? `<div class="prose">${esc(ef.description)}</div>` : ""}
    <h3>Modifiers</h3>
    <div class="toolbar"><button class="btn primary" id="add-em">+ Modifier</button>
      <span class="sub">Effects are generic; apply them to any character and loadout in the Loadout Lab.</span></div>
    ${tableHtml(["Stat", "Amount", "Condition", "Notes"], modifiers.map((m) =>
      `<tr class="clickable" data-em="${m.id}"><td>${esc(STAT_LABEL[m.stat] || m.stat)}</td><td class="num ${m.amount >= 0 ? "up" : "down"}">${signed(m.amount, m.mod_type === "percent")}</td><td>${esc(m.condition ?? "")}</td><td class="trunc">${esc(m.notes ?? "")}</td></tr>`),
      "No modifiers yet.", ["num"])}
    <h3>On the timeline</h3>
    ${tableHtml(["Character", "From", "Until", "Cause"], characters.map((c) =>
      `<tr><td><a href="#/character/${c.character_id}">${esc(charName(c.character_id, c.character_name))}</a></td><td>${esc(c.from_label)}</td><td>${c.until_label ? esc(c.until_label) : '<span class="null">ongoing</span>'}</td><td class="trunc">${esc(c.cause ?? "")}</td></tr>`),
      "No character has this effect in the story. Apply it from a character's sheet.")}
    ${ef.notes ? `<h3>Notes</h3><div class="prose">${esc(ef.notes)}</div>` : ""}`;
  $("#edit-ef").onclick = () => openForm("effects", ef, null, (saved) => saved ? reload() : (location.hash = "#/t/effects"));
  $("#add-em").onclick = () => openForm("effect_modifiers", null, { effect_id: id }, reload);
  main.querySelectorAll("[data-em]").forEach((tr) => tr.onclick = () => openForm("effect_modifiers", modifiers.find((m) => m.id === +tr.dataset.em), null, reload));
}

// ------------------------------------------------------------------ faction sheet
const EVENT_LABEL = { joined: "joined", rank: "rank change", "turned traitor": "turned traitor", "loyal again": "loyal again",
  "secretly joined": "secret member", "went undercover": "went undercover", revealed: "revealed", left: "left" };
async function renderFactionSheet(id) {
  const { faction: f, history, members } = await api("GET", `factions/${id}/sheet`);
  const reload = () => renderFactionSheet(id);
  const points = [...new Map(members.map((m) => [m.story_point_id, m.story_point])).entries()];
  const sel = state.factionPoint?.[id];
  const point = points.some(([pid]) => pid === sel) ? sel : points[points.length - 1]?.[0];
  const atPoint = members.filter((m) => m.story_point_id === point);
  const bad = new Set(["turned traitor", "left"]);
  main.innerHTML = `
    <div class="page-head">
      <div><h1>${esc(f.name)}</h1><div class="sub">${esc(f.kind ?? "faction")}</div></div>
      <span class="spacer"></span>
      <a class="btn" href="#/t/factions">← Factions</a>
      <button class="btn" id="edit-fa">Edit</button>
    </div>
    ${f.description ? `<div class="prose">${esc(f.description)}</div>` : ""}
    <h3>Members at
      ${points.length ? `<select id="fa-point">${points.map(([pid, label]) => `<option value="${pid}" ${pid === point ? "selected" : ""}>${esc(label)}</option>`).join("")}</select>` : ""}
    </h3>
    ${tableHtml(["Character", "Rank", "Membership"], atPoint.map((m) => {
      const open = m.faction_id === id;
      return `<tr><td><a href="#/character/${m.character_id}">${esc(charName(m.character_id, m.character_name))}</a></td><td>${esc(open ? m.rank ?? "" : "")}</td><td>${open
        ? (m.secret_faction_id ? `<span class="badge dead" title="Publicly a member, secretly loyal elsewhere">traitor: secretly ${esc(m.secret_faction)}</span>` : '<span class="badge on">member</span>')
        : `<span class="badge secret" title="Publicly ${esc(m.faction ?? "unaffiliated")}">secret member</span> <span class="null">publicly ${esc(m.faction ?? "unaffiliated")}${m.rank ? `, ${esc(m.rank)}` : ""}</span>`}</td></tr>`;
    }), "No members at this point.")}
    <h3>Timeline</h3>
    <div class="toolbar"><span class="sub">Joins, promotions, betrayals and departures, from each character's rank &amp; faction versions.</span></div>
    ${tableHtml(["Story point", "Character", "Event", "Now", "Reason"], history.map((h) =>
      `<tr><td>${esc(h.story_point)}</td><td><a href="#/character/${h.character_id}">${esc(charName(h.character_id, h.character_name))}</a></td><td><span class="badge ${bad.has(h.event) ? "dead" : h.event.includes("secret") || h.event === "went undercover" ? "secret" : "on"}">${esc(EVENT_LABEL[h.event] ?? h.event)}</span></td><td>${affilText(h, true)}</td><td class="trunc">${esc(h.change_reason ?? "")}</td></tr>`),
      "Nobody has been in this faction yet. Add a rank / faction version on a character's sheet.")}
    ${f.notes ? `<h3>Notes</h3><div class="prose">${esc(f.notes)}</div>` : ""}`;
  $("#edit-fa").onclick = () => openForm("factions", f, null, (saved) => saved ? reload() : (location.hash = "#/t/factions"));
  $("#fa-point")?.addEventListener("change", (e) => { (state.factionPoint ||= {})[id] = +e.target.value; reload(); });
}

// ------------------------------------------------------------------ loadout lab
const LAB_KEY = "lw.lab";
function labState() {
  if (!state.lab) {
    try { state.lab = JSON.parse(localStorage.getItem(LAB_KEY)); } catch { state.lab = null; }
    state.lab ||= { character_id: null, story_point_id: "", current: true, bare: false, story_effects: true, loadouts: [], effects: [] };
    state.lab.story_effects ??= true;
  }
  return state.lab;
}
function saveLab() { try { localStorage.setItem(LAB_KEY, JSON.stringify(state.lab)); } catch { /* storage unavailable */ } }
function setLabCharacter(cid, pointId = "") {
  const lab = labState();
  lab.character_id = cid;
  lab.story_point_id = pointId ?? "";
  lab.loadouts = state.lookups.loadouts.filter((l) => l.character_id === cid).map((l) => l.id);
  saveLab();
}

async function renderLab() {
  const lab = labState();
  const chars = state.lookups.characters;
  if (!chars.length) { main.innerHTML = `<div class="empty">Add a character first.</div>`; return; }
  if (!chars.some((c) => c.id === lab.character_id)) setLabCharacter(chars[0].id);
  const cid = lab.character_id;
  const own = state.lookups.loadouts.filter((l) => l.character_id === cid);
  const generic = state.lookups.loadouts.filter((l) => l.character_id === null);
  const validLo = new Set([...own, ...generic].map((l) => l.id));
  lab.loadouts = lab.loadouts.filter((x) => validLo.has(x));
  const effectIds = new Set(state.lookups.effects.map((e) => e.id));
  lab.effects = lab.effects.filter((x) => effectIds.has(x));

  const points = await api("GET", `effective_stats?character_id=${cid}`);
  if (lab.story_point_id && !points.some((p) => p.story_point_id === +lab.story_point_id)) lab.story_point_id = "";
  saveLab();

  const chip = (group, value, label, checked, cls = "", disabled = false) =>
    `<label class="chip ${cls}"${disabled ? ' title="Active in the story at this point. Turn off “Story effects” to remove it."' : ""}><input type="checkbox" data-group="${group}" value="${value}" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""}><span>${label}</span></label>`;
  const effChips = (kind) => state.lookups.effects.filter((e) => e.kind === kind).map((e) =>
    storyIds.has(e.id)
      ? chip("effects", e.id, `${esc(e.name)} <small>from story</small>`, true, `${kind} locked`, true)
      : chip("effects", e.id, esc(e.name) + (e.severity ? ` <small>${esc(e.severity)}</small>` : ""), lab.effects.includes(e.id), kind)).join("");

  let sim = null, simError = null;
  if (points.length) {
    const qs = new URLSearchParams({ character_id: cid, story_point_id: lab.story_point_id, loadouts: lab.loadouts.join(","),
      effects: lab.effects.join(","), current: lab.current ? "1" : "0", bare: lab.bare ? "1" : "0", story_effects: lab.story_effects ? "1" : "0" });
    try { sim = await api("GET", `simulate?${qs}`); } catch (e) { simError = e.message; }
  }
  const storyIds = new Set((sim?.effects || []).filter((e) => e.source === "story").map((e) => e.id));

  main.innerHTML = `
    <div class="page-head"><h1>Loadout Lab</h1><span class="sub">compare loadouts side by side, with buffs and debuffs applied</span></div>
    <div class="lab-controls">
      <div class="lab-row">
        <label class="lab-field">Character
          <select id="lab-char">${chars.map((c) => `<option value="${c.id}" ${c.id === cid ? "selected" : ""}>${esc(fullName(c))}</option>`).join("")}</select></label>
        <label class="lab-field">Base stats at
          <select id="lab-point" ${points.length ? "" : "disabled"}><option value="">Latest${points.length ? ` (${esc(points[points.length - 1].story_point)})` : ""}</option>
          ${points.map((p) => `<option value="${p.story_point_id}" ${String(lab.story_point_id) === String(p.story_point_id) ? "selected" : ""}>${esc(p.story_point)}</option>`).join("")}</select></label>
        <a class="btn small" href="#/character/${cid}">Open sheet</a>
      </div>
      <div class="lab-group"><span class="lab-label">Gear</span>
        ${chip("flag", "current", "Story gear at this point", lab.current)}
        ${chip("flag", "bare", "No gear", lab.bare)}
        ${own.map((l) => chip("loadouts", l.id, esc(l.name), lab.loadouts.includes(l.id))).join("")}
        ${generic.map((l) => chip("loadouts", l.id, `${esc(l.name)} <small>generic</small>`, lab.loadouts.includes(l.id), "generic")).join("")}
        <button class="btn small" id="lab-new-lo">+ Loadout</button>
      </div>
      <div class="lab-group"><span class="lab-label">Effects</span>
        ${chip("flag", "story_effects", "Story effects at this point", lab.story_effects)}
        ${effChips("debuff")}${effChips("mixed")}${effChips("buff")}
        ${state.lookups.effects.length ? "" : '<span class="sub">No effects defined yet.</span>'}
        <button class="btn small" id="lab-new-ef">+ Effect</button>
        ${lab.effects.length ? '<button class="btn small" id="lab-clear-ef">Clear effects</button>' : ""}
      </div>
    </div>
    <div id="lab-result">${!points.length ? `<div class="empty">This character has no stat versions yet. <a href="#/character/${cid}">Add one on their sheet.</a></div>`
      : simError ? `<div class="error">${esc(simError)}</div>` : labResult(sim)}</div>`;

  const rerender = () => { saveLab(); renderLab(); };
  $("#lab-char").onchange = (e) => { setLabCharacter(+e.target.value); renderLab(); };
  $("#lab-point").onchange = (e) => { lab.story_point_id = e.target.value; rerender(); };
  main.querySelectorAll(".lab-controls input[type=checkbox]").forEach((cb) => cb.onchange = () => {
    const g = cb.dataset.group, v = cb.value;
    if (g === "flag") lab[v] = cb.checked;
    else lab[g] = cb.checked ? [...lab[g], +v] : lab[g].filter((x) => x !== +v);
    rerender();
  });
  $("#lab-new-lo").onclick = () => openForm("loadouts", null, { character_id: cid }, (saved) => saved && (location.hash = `#/loadout/${saved.id}`));
  $("#lab-new-ef").onclick = () => openForm("effects", null, null, (saved) => saved && (location.hash = `#/effect/${saved.id}`));
  const clr = $("#lab-clear-ef"); if (clr) clr.onclick = () => { lab.effects = []; rerender(); };
}

function labResult(sim) {
  const cols = sim.columns;
  if (!cols.length) return `<div class="empty">Pick at least one loadout (or story gear) to compare.</div>`;
  const stats = [...BASE_STATS, ...GEAR_STATS];
  const innate = (s) => (BASE_STATS.includes(s) ? sim.base[s] : 0);
  const effLine = sim.effects.length
    ? `<p class="sub">Applied to every column: ${sim.effects.map((e) => `<b>${esc(e.name)}</b>${e.source === "story" ? ' <span class="badge">story</span>' : ""} (${e.modifiers.filter((m) => !m.condition).map(modText).join(", ") || "situational only"})`).join("; ")}</p>` : "";
  const baseNote = sim.base.story_point_id === sim.story_point.id ? "" : ` (carried from ${esc(sim.base.story_point)})`;
  const rows = stats.map((s) => {
    const vals = cols.map((c) => c.stats[s]);
    if (!BASE_STATS.includes(s) && vals.every((v) => v === 0)) return "";
    const max = Math.max(...vals), min = Math.min(...vals);
    return `<tr><th scope="row">${STAT_LABEL[s]}</th><td class="num innate">${innate(s)}</td>${cols.map((c) => {
      const v = c.stats[s], d = v - innate(s);
      return `<td class="num ${cols.length > 1 && max !== min && v === max ? "best" : ""}" title="${esc(partsText(c.parts[s], true))}">${v}${d ? ` <span class="${d > 0 ? "up" : "down"}">${signed(d)}</span>` : ""}</td>`;
    }).join("")}</tr>`;
  }).join("");
  const head = cols.map((c) => `<th class="num">${c.loadout_id ? `<a href="#/loadout/${c.loadout_id}">${esc(c.label)}</a>` : esc(c.label)}${c.generic ? ' <span class="badge">generic</span>' : ""}</th>`).join("");
  const details = cols.map((c) => `
    <div class="card lab-card">
      <div class="lab-card-title">${esc(c.label)}</div>
      ${c.gear.length ? `<ul class="gear-list">${c.gear.map((g) => `<li class="${g.equipped ? "" : "carried"}"><a href="#/item/${g.item_id}">${esc(g.name)}</a>${g.quantity > 1 ? ` ×${g.quantity}` : ""}${g.equipped ? "" : " <small>(carried)</small>"}</li>`).join("")}</ul>` : '<div class="sub">No gear</div>'}
      ${c.warnings.map((w) => `<div class="warn">⚠ ${esc(w)}</div>`).join("")}
      ${c.situational.length ? `<div class="situational"><span class="sub">Situational:</span> ${c.situational.map((m) => `${esc(m.source)}: ${modText(m)} <i>${esc(m.condition)}</i>`).join("; ")}</div>` : ""}
    </div>`).join("");
  return `
    <h3>${esc(fullName(sim.character))} @ ${esc(sim.story_point.label)}${baseNote}</h3>
    ${effLine}
    <div class="table-wrap"><table class="lab-table">
      <thead><tr><th>Stat</th><th class="num" title="Base stats with no gear and no effects">Innate</th>${head}</tr></thead>
      <tbody>${rows}</tbody></table></div>
    <p class="sub">Coloured numbers show the change from innate stats. <b>Bold</b> marks the best value in each row. Hover a value for its breakdown.</p>
    <div class="lab-cards">${details}</div>`;
}

// ------------------------------------------------------------------ effective stats overview
async function renderEffective() {
  const rows = await api("GET", "effective_stats");
  const pointSel = state.effPoint ?? "";
  const shown = pointSel ? rows.filter((r) => r.story_point_id === +pointSel) : rows;
  main.innerHTML = `
    <div class="page-head"><h1>Effective Stats</h1><span class="sub">base stats + equipped gear, per story point</span></div>
    <div class="toolbar"><select id="eff-point"><option value="">All story points</option>${state.lookups.story_points.map((s) =>
      `<option value="${s.id}" ${String(pointSel) === String(s.id) ? "selected" : ""}>${esc(s.label)}</option>`).join("")}</select></div>
    ${tableHtml(["Character", "Story point", ...[...BASE_STATS, ...GEAR_STATS].map((s) => STAT_LABEL[s])],
      shown.map((r) => `<tr><td><a href="#/character/${r.character_id}">${esc(charName(r.character_id, r.character_name))}</a></td><td>${esc(r.story_point)}${r.is_snapshot ? "" : ' <span class="badge">carried</span>'}</td>${[...BASE_STATS, ...GEAR_STATS].map((s) => `<td class="num">${r[s]}</td>`).join("")}</tr>`),
      "No stat versions recorded yet.", ["", ...[...BASE_STATS, ...GEAR_STATS].map(() => "num")])}`;
  $("#eff-point").onchange = (e) => { state.effPoint = e.target.value; renderEffective(); };
}

// ------------------------------------------------------------------ boot
$("#nav-toggle").onclick = () => $("#nav").classList.toggle("open");
window.addEventListener("hashchange", route);
(async () => {
  try {
    state.meta = await api("GET", "meta");
    await loadLookups();
    await route();
  } catch (e) {
    main.innerHTML = `<div class="error">Could not reach the API: ${esc(e.message)}</div>`;
  }
})();
