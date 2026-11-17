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

async function loadLookups() {
  const [characters, items, story_points] = await Promise.all(
    ["characters", "items", "story_points"].map((t) => api("GET", t)));
  state.lookups = { characters, items, story_points };
  state.labels = {};
  for (const [t, rows] of Object.entries(state.lookups)) {
    const col = state.meta[t].label;
    state.labels[t] = new Map(rows.map((r) => [r.id, r[col]]));
  }
  state.seq = new Map(story_points.map((s) => [s.id, s.sequence]));
}

function colMeta(table, name) { return state.meta[table].columns.find((c) => c.name === name); }

function fmtCell(table, col, v) {
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
  if (table === "character_stats") return `${state.labels.characters.get(row.character_id)} @ ${state.labels.story_points.get(row.story_point_id)}`;
  if (table === "character_equipment") return `${state.labels.items.get(row.item_id)} → ${state.labels.characters.get(row.character_id)}`;
  if (table === "item_modifiers") return `${state.labels.items.get(row.item_id)}: ${row.amount > 0 ? "+" : ""}${row.amount}${row.mod_type === "percent" ? "%" : ""} ${row.stat}`;
  return `#${row.id}`;
}

// ------------------------------------------------------------------ nav / routing
function renderNav(active) {
  const links = Object.entries(state.meta).map(([t, m]) =>
    `<a href="#/t/${t}" class="${active === t ? "active" : ""}">${esc(m.title)}</a>`);
  $("#nav").innerHTML = links.join("") +
    `<div class="sep"></div><a href="#/t/effective" class="${active === "effective" ? "active" : ""}">Effective Stats</a>`;
}

async function route() {
  $("#nav").classList.remove("open");
  const [, kind, arg] = (location.hash || "#/t/characters").split("/");
  try {
    if (kind === "character") { renderNav("characters"); await renderCharacterSheet(+arg); }
    else if (kind === "item") { renderNav("items"); await renderItemSheet(+arg); }
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
  const cols = m.columns.filter((c) => !LIST_HIDDEN.has(c.name));
  const fkCols = m.columns.filter((c) => c.fk);
  const hasSheet = table === "characters" || table === "items";

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
          ${hasSheet ? `<td><a class="btn small" href="#/${table === "characters" ? "character" : "item"}/${r.id}" data-stop>Sheet →</a></td>` : ""}</tr>`).join("")}
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
    const blank = c.notnull ? `<option value="" disabled ${v === "" ? "selected" : ""}>Choose…</option>` : `<option value="">${c.name.startsWith("until") ? "- still held -" : "-"}</option>`;
    input = `<select id="${id}" name="${c.name}" ${req ? "required" : ""}>${blank}${opts}</select>`;
  } else if (c.options) {
    input = `<select id="${id}" name="${c.name}">${c.notnull ? "" : '<option value="">-</option>'}${c.options.map((o) =>
      `<option ${String(v) === String(o) ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
  } else if (TEXTAREA.has(c.name)) {
    input = `<textarea id="${id}" name="${c.name}">${esc(v)}</textarea>`;
  } else if (isNum(c)) {
    input = `<input type="number" id="${id}" name="${c.name}" value="${esc(v)}" step="${c.type === "REAL" ? "any" : "1"}" ${req ? "required" : ""}>`;
  } else {
    input = `<input type="text" id="${id}" name="${c.name}" value="${esc(v)}" ${req ? "required" : ""}>`;
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
  $("#drawer-fields").innerHTML = m.columns.filter((c) => !SYSTEM_COLS.has(c.name))
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
  const { character: ch, stats, equipment, effective } = sheet;
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

  const fact = (k, v) => v ? `<div><div class="k">${k}</div>${esc(v)}</div>` : "";
  const cell = (e, s, prev) => {
    const isBase = BASE_STATS.includes(s);
    const base = isBase ? statById.get(e.stats_id)[s] : 0;
    const gear = isBase ? e[s] - base : 0;
    const d = prev ? e[s] - prev[s] : 0;
    return `<td class="num">${e[s]}${gear ? `<span class="gear" title="base ${base}, gear ${gear > 0 ? "+" : ""}${gear}">(${gear > 0 ? "+" : ""}${gear})</span>` : ""}${d ? ` <span class="${d > 0 ? "up" : "down"}">${d > 0 ? "▲" : "▼"}${Math.abs(d)}</span>` : ""}</td>`;
  };

  main.innerHTML = `
    <div class="page-head">
      <div><h1>${esc(ch.name)}${ch.epithet ? ` <span class="sub">${esc(ch.epithet)}</span>` : ""}</h1>
      <div class="sub">${[ch.race, ch.class, ch.subclass].filter(Boolean).map(esc).join(" · ") || "No class set"}
        <span class="badge ${ch.status === "alive" ? "on" : ch.status === "dead" ? "dead" : ""}">${esc(ch.status)}</span>
        ${ch.role ? `<span class="badge">${esc(ch.role)}</span>` : ""}</div></div>
      <span class="spacer"></span>
      <a class="btn" href="#/t/characters">← Roster</a>
      <button class="btn" id="edit-char">Edit</button>
    </div>
    <div class="detail">${fact("Faction", ch.faction)}${fact("Alignment", ch.alignment)}${fact("Age", ch.age)}</div>
    ${ch.bio ? `<h3>Bio</h3><div class="prose">${esc(ch.bio)}</div>` : ""}

    <h3>Effective stats at
      <select id="point">${effective.map((e) => `<option value="${e.story_point_id}" ${e.story_point_id === point ? "selected" : ""}>${esc(e.story_point)}</option>`).join("")}</select>
    </h3>
    ${cur ? `<div class="cards">${[...BASE_STATS, ...usedGear].map((s) => {
      const base = statById.get(cur.stats_id)[s] ?? 0, gear = cur[s] - base;
      return `<div class="card"><div class="k">${STAT_LABEL[s]}</div><div class="v">${cur[s]}${BASE_STATS.includes(s) && gear ? `<small>${base} ${gear > 0 ? "+" : "−"} ${Math.abs(gear)} gear</small>` : ""}</div></div>`;
    }).join("")}</div>
    ${cur.is_snapshot ? "" : `<p class="sub">No stat version recorded at this point; base stats carried forward from <b>${esc(statById.get(cur.stats_id).story_point)}</b>.</p>`}`
    : `<div class="empty">No stat versions yet. Add one below.</div>`}

    <h3>Gear at this point</h3>
    ${tableHtml(["Item", "Category", "Slot", "State"], equipment.filter(activeAt).map((e) =>
      `<tr class="${e.equipped ? "" : "carried"}"><td><a href="#/item/${e.item_id}">${esc(e.item_name)}</a>${e.quantity > 1 ? ` ×${e.quantity}` : ""}</td><td>${esc(e.category)}</td><td>${esc(e.slot ?? "-")}</td><td>${e.equipped ? '<span class="badge on">equipped</span>' : '<span class="badge">carried</span>'}</td></tr>`), "Nothing held at this point.")}

    <h3>Progression <span class="spacer"></span></h3>
    <div class="toolbar"><button class="btn primary" id="add-stats">+ Stat version</button>
      <span class="sub">Numbers include gear (gear part in brackets); ▲▼ is the change from the previous point. Click a row to edit its stat version.</span></div>
    ${tableHtml(["Story point", ...BASE_STATS.map((s) => STAT_LABEL[s]), ...usedGear.map((s) => STAT_LABEL[s]), "Reason"],
      effective.map((e, i) => {
        const sv = statById.get(e.stats_id);
        return `<tr class="clickable ${e.story_point_id === point ? "selected" : ""}" data-stats="${e.stats_id}"><td>${esc(e.story_point)}${e.is_snapshot ? "" : ' <span class="badge" title="No stat version here; carried forward">carried</span>'}</td>${[...BASE_STATS, ...usedGear].map((s) => cell(e, s, effective[i - 1])).join("")}<td class="trunc">${e.is_snapshot ? esc(sv.change_reason ?? "") : ""}</td></tr>`;
      }), "No stat versions yet.", [...BASE_STATS, ...usedGear].map(() => "num"))}

    <h3>Equipment history</h3>
    <div class="toolbar"><button class="btn primary" id="add-gear">+ Give item</button></div>
    ${tableHtml(["Item", "From", "Until", "State", "Qty", "Notes"], equipment.map((e) =>
      `<tr class="clickable" data-eq="${e.id}"><td>${esc(e.item_name)}</td><td>${esc(e.from_label)}</td><td>${e.until_label ? esc(e.until_label) : '<span class="null">still held</span>'}</td><td>${e.equipped ? "equipped" : "carried"}</td><td class="num">${e.quantity}</td><td class="trunc">${esc(e.notes ?? "")}</td></tr>`), "No gear yet.")}
    ${ch.notes ? `<h3>Notes</h3><div class="prose">${esc(ch.notes)}</div>` : ""}`;

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
  const { item, modifiers, holders } = await api("GET", `items/${id}/sheet`);
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
      `<tr><td><a href="#/character/${h.character_id}">${esc(h.character_name)}</a></td><td>${esc(h.from_label)}</td><td>${h.until_label ? esc(h.until_label) : '<span class="null">still held</span>'}</td><td>${h.equipped ? "equipped" : "carried"}</td></tr>`), "Nobody holds this item.")}
    ${item.lore ? `<h3>Lore</h3><div class="prose">${esc(item.lore)}</div>` : ""}`;
  $("#edit-item").onclick = () => openForm("items", item, null, (saved) => saved ? reload() : (location.hash = "#/t/items"));
  $("#add-mod").onclick = () => openForm("item_modifiers", null, { item_id: id }, reload);
  main.querySelectorAll("[data-mod]").forEach((tr) => tr.onclick = () => openForm("item_modifiers", modifiers.find((m) => m.id === +tr.dataset.mod), null, reload));
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
      shown.map((r) => `<tr><td><a href="#/character/${r.character_id}">${esc(r.character_name)}</a></td><td>${esc(r.story_point)}${r.is_snapshot ? "" : ' <span class="badge">carried</span>'}</td>${[...BASE_STATS, ...GEAR_STATS].map((s) => `<td class="num">${r[s]}</td>`).join("")}</tr>`),
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
