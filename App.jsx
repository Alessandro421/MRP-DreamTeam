import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer, BarChart, Bar, Legend } from "recharts";
import { supabase } from "./supabaseClient";

const CATEGORIES = ["Brushes","Detergents","Squeegees","Filters","Batteries","Spare Parts"];
const CATEGORY_DEFAULTS = {
  Brushes:      { leadTime:21, moq:10, orderMultiple:5,  safetyStock:15, reviewCycle:7  },
  Detergents:   { leadTime:14, moq:20, orderMultiple:10, safetyStock:30, reviewCycle:7  },
  Squeegees:    { leadTime:28, moq:5,  orderMultiple:5,  safetyStock:10, reviewCycle:14 },
  Filters:      { leadTime:35, moq:50, orderMultiple:25, safetyStock:50, reviewCycle:14 },
  Batteries:    { leadTime:42, moq:10, orderMultiple:10, safetyStock:20, reviewCycle:14 },
  "Spare Parts":{ leadTime:60, moq:1,  orderMultiple:1,  safetyStock:5,  reviewCycle:30 },
};
const SKUS_DEFAULT = [
  { id:"BR-001", name:"Cylindrical Brush 70cm",  category:"Brushes",     stock:45,  avgDaily:3.2,  overrides:{} },
  { id:"BR-002", name:"Disk Brush 55cm",          category:"Brushes",     stock:8,   avgDaily:2.1,  overrides:{leadTime:28} },
  { id:"BR-003", name:"Side Brush Kit",           category:"Brushes",     stock:22,  avgDaily:1.8,  overrides:{} },
  { id:"DT-001", name:"Floor Cleaner 10L",        category:"Detergents",  stock:120, avgDaily:8.5,  overrides:{} },
  { id:"DT-002", name:"Degreaser Concentrate",    category:"Detergents",  stock:35,  avgDaily:4.2,  overrides:{moq:30} },
  { id:"DT-003", name:"Disinfectant 5L",          category:"Detergents",  stock:18,  avgDaily:6.0,  overrides:{} },
  { id:"SQ-001", name:"Rear Squeegee 85cm",       category:"Squeegees",   stock:12,  avgDaily:1.1,  overrides:{} },
  { id:"SQ-002", name:"Front Blade Set",          category:"Squeegees",   stock:3,   avgDaily:0.9,  overrides:{} },
  { id:"FL-001", name:"HEPA Filter Main",         category:"Filters",     stock:200, avgDaily:5.5,  overrides:{} },
  { id:"FL-002", name:"Pre-Filter Set",           category:"Filters",     stock:40,  avgDaily:7.0,  overrides:{safetyStock:70} },
  { id:"BA-001", name:"Traction Battery 36V",     category:"Batteries",   stock:6,   avgDaily:0.4,  overrides:{} },
  { id:"BA-002", name:"Charger Unit",             category:"Batteries",   stock:4,   avgDaily:0.2,  overrides:{leadTime:56} },
  { id:"SP-001", name:"Motor Drive Belt",         category:"Spare Parts", stock:15,  avgDaily:0.3,  overrides:{} },
  { id:"SP-002", name:"Wheel Assembly",           category:"Spare Parts", stock:2,   avgDaily:0.15, overrides:{} },
  { id:"SP-003", name:"Control Board",            category:"Spare Parts", stock:1,   avgDaily:0.05, overrides:{leadTime:90} },
];
const OPEN_POS_DEFAULT = {
  "BR-001":[{qty:20,eta:10}],
  "DT-001":[{qty:100,eta:5},{qty:50,eta:20}],
  "FL-001":[{qty:200,eta:15}],
  "BA-001":[{qty:10,eta:30}],
};

function buildSKU(raw, catOverrides) {
  const cat = catOverrides[raw.category] || CATEGORY_DEFAULTS[raw.category];
  return {
    ...raw,
    leadTime:      raw.overrides.leadTime      ?? cat.leadTime,
    moq:           raw.overrides.moq           ?? cat.moq,
    orderMultiple: raw.overrides.orderMultiple ?? cat.orderMultiple,
    safetyStock:   raw.overrides.safetyStock   ?? cat.safetyStock,
    reviewCycle:   raw.overrides.reviewCycle   ?? cat.reviewCycle,
  };
}

function calcMRP(sku, openPOs, horizon=90) {
  const pos = openPOs[sku.id] || [];
  let proj = sku.stock;
  const curve = [], orders = [];
  for (let d=0; d<=horizon; d++) {
    const receipts = pos.filter(p=>p.eta===d).reduce((s,p)=>s+p.qty,0);
    const planned  = orders.filter(o=>o.receiptDay===d).reduce((s,o)=>s+o.qty,0);
    proj += receipts + planned - sku.avgDaily;
    curve.push({ day:d, stock:Math.round(proj), safety:sku.safetyStock });
    if (d % sku.reviewCycle === 0) {
      const futureDay = d + sku.leadTime;
      const stockAtFuture = proj - sku.avgDaily*sku.leadTime
        + orders.filter(o=>o.receiptDay>d&&o.receiptDay<=futureDay).reduce((s,o)=>s+o.qty,0);
      if (stockAtFuture < sku.safetyStock && futureDay<=horizon) {
        const need = sku.safetyStock + sku.avgDaily*sku.leadTime - stockAtFuture;
        const raw2 = Math.max(need, sku.moq);
        const qty  = Math.ceil(raw2/sku.orderMultiple)*sku.orderMultiple;
        orders.push({ orderDay:d, receiptDay:futureDay, qty });
      }
    }
  }
  const days = proj / sku.avgDaily;
  const rop  = sku.safetyStock + sku.avgDaily * sku.leadTime;
  const status = proj<0 ? "critical" : proj<sku.safetyStock ? "at-risk" : days<sku.leadTime/7 ? "watch" : "ok";
  return { curve, orders, finalStock:proj, daysOfStock:days, rop, status };
}

const STATUS_COLOR = { critical:"#ef4444","at-risk":"#f97316", watch:"#eab308", ok:"#22c55e" };
const STATUS_LABEL = { critical:"CRITICAL","at-risk":"AT RISK", watch:"WATCH",   ok:"OK" };

// CSV helpers
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  const firstLine = lines[0];
  const delim = (firstLine.split(';').length > firstLine.split(',').length) ? ';' : ',';
  const headers = firstLine.split(delim).map(h=>h.trim().toLowerCase().replace(/['"]/g,''));
  return lines.slice(1).filter(l=>l.trim()).map(l=>{
    const vals = l.split(delim).map(v=>v.trim().replace(/^['"]|['"]$/g,''));
    const obj = {};
    headers.forEach((h,i)=>{ obj[h]=vals[i]??''; });
    return obj;
  });
}
function rowsToSkus(rows) {
  const groups = {};
  rows.filter(r => r.id || r.sku).forEach(r => {
    const id = (r.id || r.sku || '').toUpperCase();
    if (!groups[id]) groups[id] = [];
    groups[id].push(r);
  });
  return Object.values(groups).map(grp => {
    const first = grp[0];
    const avgOr = (...keys) => {
      for (const k of keys) {
        const vals = grp.map(r => parseFloat(r[k] || 0)).filter(v => !isNaN(v) && v > 0);
        if (vals.length) return vals.reduce((a, b) => a + b, 0) / vals.length;
      }
      return 0;
    };
    return {
      id: (first.id || first.sku || '').toUpperCase(),
      name: first.name || first.description || first.id || first.sku || '',
      category: first.category || 'Spare Parts',
      stock: avgOr('stock') || parseFloat(first['current stock'] || 0),
      avgDaily: avgOr('avgdaily', 'avg daily', 'daily usage'),
      overrides: {
        ...(avgOr('leadtime', 'lead time') ? { leadTime: avgOr('leadtime', 'lead time') } : {}),
        ...(avgOr('moq') ? { moq: avgOr('moq') } : {}),
        ...(avgOr('ordermultiple', 'order multiple') ? { orderMultiple: avgOr('ordermultiple', 'order multiple') } : {}),
        ...(avgOr('safetystock', 'safety stock') ? { safetyStock: avgOr('safetystock', 'safety stock') } : {}),
      }
    };
  });
}
function rowsToPOs(rows) {
  const pos = {};
  rows.filter(r => r.id || r.sku).forEach(r => {
    const id = (r.id || r.sku || '').toUpperCase();
    if (!pos[id]) pos[id] = [];
    const qty = parseFloat(r.poqty || r['po qty'] || r.qty || 0);
    const eta = parseFloat(r.eta || r['eta day'] || 0);
    if (qty > 0) {
      const existing = pos[id].find(p => p.eta === eta);
      if (existing) { existing.qty += qty; }
      else { pos[id].push({ qty, eta }); }
    }
  });
  return pos;
}
function toCSV(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(','), ...rows.map(r=>headers.map(h=>r[h]??'').join(','))];
  return lines.join('\n');
}
function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ─────────────────────────────────────────────
//  SUPABASE SYNC HELPERS
// ─────────────────────────────────────────────

/** Fetch every row from a table, bypassing Supabase's 1000-row default limit */
async function fetchAll(table) {
  const PAGE = 1000;
  let from = 0;
  let allRows = [];
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select("*")
      .range(from, from + PAGE - 1);
    if (error) return { data: null, error };
    allRows = allRows.concat(data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return { data: allRows, error: null };
}

/** Transform Supabase mrp_skus rows → app format */
function dbSkusToApp(rows) {
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    category: r.category,
    stock: parseFloat(r.stock) || 0,
    avgDaily: parseFloat(r.avg_daily) || 0,
    overrides: {},
  }));
}

/** Transform Supabase mrp_open_pos rows → app format { SKU_ID: [{qty, eta}] } */
function dbPosToApp(rows) {
  const pos = {};
  rows.forEach(r => {
    if (!pos[r.sku_id]) pos[r.sku_id] = [];
    pos[r.sku_id].push({ qty: parseFloat(r.qty), eta: parseInt(r.eta_day) });
  });
  return pos;
}

/** Transform Supabase mrp_sku_overrides rows → app format { SKU_ID: {leadTime, moq, ...} } */
function dbOverridesToApp(rows) {
  const ov = {};
  rows.forEach(r => {
    ov[r.sku_id] = {
      ...(r.lead_time != null   ? { leadTime: r.lead_time }           : {}),
      ...(r.moq != null         ? { moq: r.moq }                      : {}),
      ...(r.order_multiple != null ? { orderMultiple: r.order_multiple } : {}),
      ...(r.safety_stock != null   ? { safetyStock: r.safety_stock }    : {}),
    };
  });
  return ov;
}

/** Transform Supabase mrp_category_params rows → app format { Category: {...} } */
function dbCatParamsToApp(rows) {
  const cp = { ...CATEGORY_DEFAULTS };
  rows.forEach(r => {
    cp[r.category] = {
      leadTime:      r.lead_time      ?? CATEGORY_DEFAULTS[r.category]?.leadTime,
      moq:           r.moq            ?? CATEGORY_DEFAULTS[r.category]?.moq,
      orderMultiple: r.order_multiple ?? CATEGORY_DEFAULTS[r.category]?.orderMultiple,
      safetyStock:   r.safety_stock   ?? CATEGORY_DEFAULTS[r.category]?.safetyStock,
      reviewCycle:   r.review_cycle   ?? CATEGORY_DEFAULTS[r.category]?.reviewCycle,
    };
  });
  return cp;
}

// ─────────────────────────────────────────────
//  MAIN APP
// ─────────────────────────────────────────────
export default function MRPPlanner() {
  const [view,          setView]          = useState("workbench");
  const [selectedSKU,   setSelectedSKU]   = useState(null);
  const [filterCat,     setFilterCat]     = useState("All");
  const [filterStatus,  setFilterStatus]  = useState("All");
  const [search,        setSearch]        = useState("");
  const [editingParams, setEditingParams] = useState(null);

  // Data state — starts from defaults, overwritten by Supabase on load
  const [catParams,     setCatParams]     = useState({ ...CATEGORY_DEFAULTS });
  const [skusRaw,       setSkusRaw]       = useState(SKUS_DEFAULT);
  const [openPOs,       setOpenPOs]       = useState(OPEN_POS_DEFAULT);
  const [skuOverrides,  setSkuOverrides]  = useState(
    Object.fromEntries(SKUS_DEFAULT.map((s) => [s.id, s.overrides]))
  );

  const [dbStatus, setDbStatus] = useState("loading"); // "loading" | "live" | "offline"
  const [realtimeStatus, setRealtimeStatus] = useState("connecting"); // "connecting" | "subscribed" | "error"
  const [uploadMsg, setUploadMsg] = useState("");
  const [lastDbError, setLastDbError] = useState("");
  const [syncMsg, setSyncMsg] = useState("");
  const fileRef = useRef();
  const channelName = useRef("mrp_global_v1");
  const channelRef = useRef(null);
  const debounceTimer = useRef(null);

  function formatDbError(error, fallback) {
    if (!error) return fallback;
    return error.message || error.details || error.hint || fallback;
  }

  const loadFromDB = useCallback(async () => {
    try {
      setSyncMsg("Refreshing from DB...");

      const [skusRes, posRes, ovRes, catRes] = await Promise.all([
        fetchAll("mrp_skus"),
        fetchAll("mrp_open_pos"),
        fetchAll("mrp_sku_overrides"),
        fetchAll("mrp_category_params"),
      ]);

      const firstError =
        skusRes.error || posRes.error || ovRes.error || catRes.error;

      if (firstError) {
        setDbStatus("offline");
        setLastDbError(
          formatDbError(firstError, "Failed to load data from Supabase.")
        );
        setSyncMsg("");
        return false;
      }

      setSkusRaw(skusRes.data?.length ? dbSkusToApp(skusRes.data) : SKUS_DEFAULT);
      setOpenPOs(posRes.data?.length ? dbPosToApp(posRes.data) : {});
      setSkuOverrides(ovRes.data?.length ? dbOverridesToApp(ovRes.data) : {});
      setCatParams(
        catRes.data?.length
          ? dbCatParamsToApp(catRes.data)
          : { ...CATEGORY_DEFAULTS }
      );

      setDbStatus("live");
      setLastDbError("");
      setSyncMsg("DB sync complete");
      return true;
    } catch (err) {
      setDbStatus("offline");
      setLastDbError(formatDbError(err, "DB connection failed."));
      setSyncMsg("");
      return false;
    }
  }, []);

  const debouncedLoad = useCallback(() => {
    clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => loadFromDB(), 300);
  }, [loadFromDB]);

  const broadcastChange = useCallback(() => {
    channelRef.current?.send({ type: "broadcast", event: "data_changed", payload: {} });
  }, []);

  // ── Load all data from Supabase on mount ──
  useEffect(() => {
    loadFromDB();
  }, [loadFromDB]);

  // ── Realtime subscription: auto-refresh when DB changes ──
  useEffect(() => {
    setRealtimeStatus("connecting");

    const channel = supabase
      .channel(channelName.current)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "mrp_skus" },
        () => { debouncedLoad(); }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "mrp_open_pos" },
        () => { debouncedLoad(); }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "mrp_sku_overrides" },
        () => { debouncedLoad(); }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "mrp_category_params" },
        () => { debouncedLoad(); }
      )
      .on("broadcast", { event: "data_changed" }, () => { debouncedLoad(); })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          setRealtimeStatus("subscribed");
          console.log("[Realtime] Subscription active");
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          setRealtimeStatus("error");
          console.warn("[Realtime] Connection issue:", status);
          debouncedLoad();
        }
      });

    channelRef.current = channel;

    return () => {
      supabase.removeChannel(channel);
      channelRef.current = null;
      clearTimeout(debounceTimer.current);
    };
  }, [loadFromDB, debouncedLoad]);

  // ── Save SKU overrides to Supabase ──
  const saveSkuOverride = useCallback(
    async (skuId, overrides) => {
      const previousOverrides = skuOverrides[skuId] || {};
      setSkuOverrides((prev) => ({ ...prev, [skuId]: overrides }));

      if (dbStatus !== "live") return;

      const row = {
        sku_id: skuId,
        lead_time: overrides.leadTime ?? null,
        moq: overrides.moq ?? null,
        order_multiple: overrides.orderMultiple ?? null,
        safety_stock: overrides.safetyStock ?? null,
      };

      const { error } = await supabase
        .from("mrp_sku_overrides")
        .upsert(row, { onConflict: "sku_id" });

      if (error) {
        setSkuOverrides((prev) => ({ ...prev, [skuId]: previousOverrides }));
        setLastDbError(formatDbError(error, "Failed to save SKU override."));
        return;
      }

      setLastDbError("");
      broadcastChange();
      await loadFromDB();
    },
    [dbStatus, skuOverrides, loadFromDB, broadcastChange]
  );

  // ── Save category params to Supabase ──
  const saveCatParams = useCallback(
    async (newParams) => {
      const previousParams = catParams;
      setCatParams(newParams);

      if (dbStatus !== "live") return;

      const rows = Object.entries(newParams).map(([cat, vals]) => ({
        category: cat,
        lead_time: vals.leadTime,
        moq: vals.moq,
        order_multiple: vals.orderMultiple,
        safety_stock: vals.safetyStock,
        review_cycle: vals.reviewCycle,
      }));

      const { error } = await supabase
        .from("mrp_category_params")
        .upsert(rows, { onConflict: "category" });

      if (error) {
        setCatParams(previousParams);
        setLastDbError(
          formatDbError(error, "Failed to save category parameters.")
        );
        return;
      }

      setLastDbError("");
      broadcastChange();
      await loadFromDB();
    },
    [dbStatus, catParams, loadFromDB, broadcastChange]
  );

  // ── File upload handler ──
  function handleUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const rows = parseCSV(ev.target.result);
        const newSkus = rowsToSkus(rows);
        const newPOs = rowsToPOs(rows);

        if (newSkus.length) {
          setSkusRaw(newSkus);
          const newOv = Object.fromEntries(newSkus.map((s) => [s.id, s.overrides]));
          setSkuOverrides(newOv);
          setUploadMsg(`Loaded ${newSkus.length} SKUs from ${file.name}`);

          if (dbStatus === "live") {
            const skuRows = newSkus.map((s) => ({
              id: s.id,
              name: s.name,
              category: s.category,
              stock: s.stock,
              avg_daily: s.avgDaily,
            }));

            const { error: deleteSkusErr } = await supabase
              .from("mrp_skus")
              .delete()
              .neq("id", "");

            if (deleteSkusErr) {
              setLastDbError(formatDbError(deleteSkusErr, "Delete SKUs error"));
              return;
            }

            const { error: skuErr } = await supabase
              .from("mrp_skus")
              .insert(skuRows);

            if (skuErr) {
              setLastDbError(formatDbError(skuErr, "Insert SKUs error"));
              return;
            }

            const ovRows = newSkus
              .filter((s) => Object.keys(s.overrides).length > 0)
              .map((s) => ({
                sku_id: s.id,
                lead_time: s.overrides.leadTime ?? null,
                moq: s.overrides.moq ?? null,
                order_multiple: s.overrides.orderMultiple ?? null,
                safety_stock: s.overrides.safetyStock ?? null,
              }));

            const { error: deleteOvErr } = await supabase
              .from("mrp_sku_overrides")
              .delete()
              .neq("sku_id", "");

            if (deleteOvErr) {
              setLastDbError(
                formatDbError(deleteOvErr, "Delete overrides error")
              );
              return;
            }

            if (ovRows.length) {
              const { error: ovErr } = await supabase
                .from("mrp_sku_overrides")
                .insert(ovRows);

              if (ovErr) {
                setLastDbError(formatDbError(ovErr, "Insert overrides error"));
                return;
              }
            }
          }
        }

        const poCount = Object.values(newPOs).flat().length;
        if (poCount) {
          setOpenPOs(newPOs);
          setUploadMsg((prev) => prev + ` + ${poCount} open POs`);

          if (dbStatus === "live") {
            const { error: deletePoErr } = await supabase
              .from("mrp_open_pos")
              .delete()
              .neq("id", 0);

            if (deletePoErr) {
              setLastDbError(formatDbError(deletePoErr, "Delete POs error"));
              return;
            }

            const poRows = [];
            Object.entries(newPOs).forEach(([skuId, entries]) => {
              entries.forEach((p) =>
                poRows.push({ sku_id: skuId, qty: p.qty, eta_day: p.eta })
              );
            });

            if (poRows.length) {
              const { error: poErr } = await supabase
                .from("mrp_open_pos")
                .insert(poRows);

              if (poErr) {
                setLastDbError(formatDbError(poErr, "Insert POs error"));
                return;
              }
            }
          }
        }

        if (dbStatus === "live") {
          broadcastChange();
          await loadFromDB();
          setLastDbError("");
        }

        if (!newSkus.length && !poCount) {
          setUploadMsg("No valid SKU data found — check column headers.");
        }
      } catch (err) {
        setUploadMsg("Parse error: " + err.message);
      }
    };

    reader.readAsText(file);
    e.target.value = "";
  }

  // ── Download MRP results ──
  function downloadResults() {
    const rows = enriched.map((s) => ({
      SKU: s.id,
      Description: s.name,
      Category: s.category,
      Stock: s.stock,
      SafetyStock: s.safetyStock,
      ReorderPoint: Math.round(s.mrp.rop),
      LeadTime_d: s.leadTime,
      MOQ: s.moq,
      AvgDaily: s.avgDaily,
      DaysCover: s.mrp.daysOfStock > 0 ? Math.round(s.mrp.daysOfStock) : "STOCKOUT",
      PlannedOrders: s.mrp.orders.length,
      NextOrderQty: s.mrp.orders[0]?.qty ?? "",
      NextOrderDay: s.mrp.orders[0]?.orderDay ?? "",
      NextReceiptDay: s.mrp.orders[0]?.receiptDay ?? "",
      Status: STATUS_LABEL[s.mrp.status],
    }));
    downloadFile(toCSV(rows), "mrp-results.csv", "text/csv");
  }

  const skus = useMemo(
    () =>
      skusRaw.map((raw) =>
        buildSKU({ ...raw, overrides: skuOverrides[raw.id] || {} }, catParams)
      ),
    [skusRaw, skuOverrides, catParams]
  );

  const mrpResults = useMemo(
    () => Object.fromEntries(skus.map((s) => [s.id, calcMRP(s, openPOs)])),
    [skus, openPOs]
  );

  const enriched = useMemo(
    () => skus.map((s) => ({ ...s, mrp: mrpResults[s.id] })),
    [skus, mrpResults]
  );

  const filtered = useMemo(
    () =>
      enriched.filter((s) => {
        if (filterCat !== "All" && s.category !== filterCat) return false;
        if (filterStatus !== "All" && s.mrp.status !== filterStatus) return false;
        if (
          search &&
          !s.name.toLowerCase().includes(search.toLowerCase()) &&
          !s.id.toLowerCase().includes(search.toLowerCase())
        )
          return false;
        return true;
      }),
    [enriched, filterCat, filterStatus, search]
  );

  const exceptions = useMemo(
    () =>
      enriched
        .filter((s) => s.mrp.status === "critical" || s.mrp.status === "at-risk")
        .sort((a, b) => a.mrp.finalStock - b.mrp.finalStock),
    [enriched]
  );

  const catSummary = useMemo(
    () =>
      Object.keys(catParams).sort().map((cat) => {
        const items = enriched.filter((s) => s.category === cat);
        const counts = { critical: 0, "at-risk": 0, watch: 0, ok: 0 };
        items.forEach((s) => counts[s.mrp.status]++);
        return { cat, total: items.length, ...counts };
      }),
    [enriched, catParams]
  );

  const dbDot =
    dbStatus === "live" ? "#16a34a" : dbStatus === "loading" ? "#f59e0b" : "#dc2626";
  const dbLabel =
    dbStatus === "live" ? "DB LIVE" : dbStatus === "loading" ? "CONNECTING..." : "OFFLINE";

  const rtDot =
    realtimeStatus === "subscribed" ? "#16a34a" : realtimeStatus === "connecting" ? "#f59e0b" : "#ca8a04";
  const rtLabel =
    realtimeStatus === "subscribed" ? "REALTIME" : realtimeStatus === "connecting" ? "RT CONN..." : "RT ERROR";

  return (
    <div style={{fontFamily:"'Salesforce Sans','Inter',Arial,sans-serif",background:"#f3f3f3",minHeight:"100vh",color:"#181818"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        body{background:#f3f3f3}
        ::-webkit-scrollbar{width:6px;height:6px}
        ::-webkit-scrollbar-track{background:#f3f3f3}
        ::-webkit-scrollbar-thumb{background:#dddbda;border-radius:4px}

        .nav-btn{background:none;border:none;padding:0 16px;height:100%;cursor:pointer;font-family:'Inter',Arial,sans-serif;font-size:13px;font-weight:400;transition:all 0.15s;color:#3e3e3c;position:relative;white-space:nowrap}
        .nav-btn:hover{color:#0176d3;background:#f3f2f2}
        .nav-btn.active{color:#0176d3;font-weight:600;box-shadow:inset 0 -3px 0 #0176d3}

        .sku-row{transition:background 0.1s;cursor:pointer}
        .sku-row:hover td{background:#f3f2f2!important}

        .pill{display:inline-flex;align-items:center;padding:2px 10px;border-radius:4px;font-size:11px;font-weight:700;letter-spacing:0.02em}

        .btn{border:1px solid #dddbda;background:#fff;color:#3e3e3c;padding:7px 16px;font-family:'Inter',Arial,sans-serif;font-size:13px;font-weight:400;cursor:pointer;transition:all 0.15s;border-radius:4px}
        .btn:hover{border-color:#0176d3;color:#0176d3;background:#f3f8fd}
        .btn:disabled{opacity:0.4;cursor:not-allowed}
        .btn-primary{background:#0176d3;border-color:#0176d3;color:white;font-weight:600}
        .btn-primary:hover{background:#0160ae;border-color:#0160ae;color:white}
        .btn-green{background:#2e844a;border-color:#2e844a;color:white;font-weight:600}
        .btn-green:hover{background:#236b3b;border-color:#236b3b;color:white}

        .input{background:#fff;border:1px solid #dddbda;color:#181818;padding:8px 12px;font-family:'Inter',Arial,sans-serif;font-size:13px;border-radius:4px;outline:none;transition:border-color 0.15s,box-shadow 0.15s;height:36px}
        .input::placeholder{color:#939393}
        .input:focus{border-color:#0176d3;box-shadow:0 0 3px 0 rgba(1,118,211,0.5)}
        .select{background:#fff;border:1px solid #dddbda;color:#181818;padding:7px 12px;font-family:'Inter',Arial,sans-serif;font-size:13px;border-radius:4px;outline:none;cursor:pointer;transition:border-color 0.15s;height:36px}
        .select:focus{border-color:#0176d3;box-shadow:0 0 3px 0 rgba(1,118,211,0.5)}

        .card{background:#fff;border:1px solid #dddbda;border-radius:4px;box-shadow:0 2px 3px rgba(0,0,0,0.07)}
        .stat-card{background:#fff;border:1px solid #dddbda;border-radius:4px;padding:16px 20px;box-shadow:0 2px 3px rgba(0,0,0,0.07);position:relative;overflow:hidden;transition:box-shadow 0.15s}
        .stat-card:hover{box-shadow:0 4px 10px rgba(0,0,0,0.12)}

        .tag{font-size:11px;padding:2px 8px;background:#e8f4fd;color:#0176d3;border-radius:4px;font-weight:600;border:1px solid #b0d4f0}

        .modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:1000}
        .modal{background:#fff;border:1px solid #dddbda;border-radius:4px;padding:0;min-width:460px;box-shadow:0 8px 32px rgba(0,0,0,0.2)}

        table{width:100%;border-collapse:collapse}
        th{background:#f3f3f3;color:#3e3e3c;font-size:11px;letter-spacing:0.05em;text-transform:uppercase;padding:10px 16px;text-align:left;border-bottom:1px solid #dddbda;font-weight:700;white-space:nowrap}
        td{padding:10px 16px;font-size:13px;border-bottom:1px solid #e0e0e0;color:#3e3e3c;vertical-align:middle}

        .anim-in{animation:fadeSlide 0.2s ease}
        @keyframes fadeSlide{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}

        .badge-critical{background:#fce9e9;color:#ba0517}
        .badge-at-risk{background:#fff3e0;color:#dd7a01}
        .badge-watch{background:#fff9c4;color:#706504}
        .badge-ok{background:#e8f5e9;color:#2e844a}

        .slds-section-title{font-size:12px;font-weight:700;color:#3e3e3c;text-transform:uppercase;letter-spacing:0.06em;padding:0 0 10px;border-bottom:1px solid #dddbda;margin-bottom:14px}

        .page-header{background:#fff;border-bottom:1px solid #dddbda;padding:12px 24px;display:flex;align-items:center;gap:12px;margin-bottom:16px;border-radius:4px;box-shadow:0 2px 3px rgba(0,0,0,0.07)}
      `}</style>

      {/* GLOBAL HEADER — SLDS dark navy */}
      <div style={{background:"#032D60",height:52,display:"flex",alignItems:"center",padding:"0 16px",gap:0,position:"sticky",top:0,zIndex:100,boxShadow:"0 2px 4px rgba(0,0,0,0.3)"}}>
        {/* Logo/Brand */}
        <div style={{display:"flex",alignItems:"center",gap:10,paddingRight:20,borderRight:"1px solid rgba(255,255,255,0.15)",marginRight:16,flexShrink:0}}>
          <div style={{width:28,height:28,background:"#0176d3",borderRadius:4,display:"flex",alignItems:"center",justifyContent:"center",border:"1px solid rgba(255,255,255,0.25)"}}>
            <span style={{color:"white",fontSize:14,fontWeight:800}}>M</span>
          </div>
          <div>
            <div style={{fontSize:14,fontWeight:700,color:"#ffffff",letterSpacing:"0.01em",lineHeight:1.2}}>MRP Planner</div>
            <div style={{fontSize:10,color:"rgba(255,255,255,0.55)",letterSpacing:"0.06em",textTransform:"uppercase"}}>EMEA Supply Chain</div>
          </div>
        </div>
        {/* Nav tabs */}
        <div style={{display:"flex",alignItems:"stretch",height:"100%",flex:1}}>
          {[
            {k:"workbench", label:"Planner Workbench"},
            {k:"exceptions",label:`Exceptions${exceptions.length>0?` (${exceptions.length})`:""}` },
            {k:"categories",label:"Category Summary"},
            {k:"demand",    label:"Demand Analysis"},
          ].map(({k,label})=>(
            <button key={k}
              style={{background:"none",border:"none",padding:"0 16px",height:"100%",cursor:"pointer",fontFamily:"'Inter',Arial,sans-serif",fontSize:13,fontWeight:view===k||(view==="detail"&&k==="workbench")?700:400,color:view===k||(view==="detail"&&k==="workbench")?"#fff":"rgba(255,255,255,0.65)",transition:"all 0.15s",borderBottom:view===k||(view==="detail"&&k==="workbench")?"3px solid #1589ee":"3px solid transparent",whiteSpace:"nowrap"}}
              onClick={()=>setView(k)}>{label}</button>
          ))}
        </div>
        {/* Right actions */}
        <div style={{display:"flex",gap:6,alignItems:"center",flexShrink:0}}>
          <input ref={fileRef} type="file" accept=".csv,.tsv,.txt" style={{display:"none"}} onChange={handleUpload}/>
          <button onClick={()=>fileRef.current.click()} style={{background:"rgba(255,255,255,0.1)",border:"1px solid rgba(255,255,255,0.2)",color:"#fff",padding:"5px 12px",borderRadius:4,fontFamily:"'Inter',Arial,sans-serif",fontSize:12,fontWeight:500,cursor:"pointer",transition:"background 0.15s"}} onMouseOver={e=>e.target.style.background="rgba(255,255,255,0.18)"} onMouseOut={e=>e.target.style.background="rgba(255,255,255,0.1)"}>↑ Upload</button>
          <button onClick={loadFromDB} style={{background:"rgba(255,255,255,0.1)",border:"1px solid rgba(255,255,255,0.2)",color:"#fff",padding:"5px 12px",borderRadius:4,fontFamily:"'Inter',Arial,sans-serif",fontSize:12,fontWeight:500,cursor:"pointer",transition:"background 0.15s"}} onMouseOver={e=>e.target.style.background="rgba(255,255,255,0.18)"} onMouseOut={e=>e.target.style.background="rgba(255,255,255,0.1)"}>↻ Sync</button>
          <button onClick={downloadResults} style={{background:"#2e844a",border:"1px solid #236b3b",color:"#fff",padding:"5px 12px",borderRadius:4,fontFamily:"'Inter',Arial,sans-serif",fontSize:12,fontWeight:600,cursor:"pointer"}}>↓ Export CSV</button>
          <div style={{width:1,height:20,background:"rgba(255,255,255,0.2)",margin:"0 6px"}}/>
          <div style={{display:"flex",alignItems:"center",gap:5,padding:"4px 10px",background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:4}}>
            <div style={{width:7,height:7,background:dbDot,borderRadius:"50%",boxShadow:`0 0 5px ${dbDot}`,animation:dbStatus==="loading"?"pulse 1.5s infinite":"none"}}/>
            <span style={{fontSize:10,fontWeight:600,color:"rgba(255,255,255,0.75)",letterSpacing:"0.06em"}}>{dbLabel}</span>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:5,padding:"4px 10px",background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:4}}>
            <div style={{width:7,height:7,background:rtDot,borderRadius:"50%",animation:realtimeStatus==="subscribed"?"pulse 2s infinite":"none"}}/>
            <span style={{fontSize:10,fontWeight:600,color:"rgba(255,255,255,0.75)",letterSpacing:"0.06em"}}>{rtLabel}</span>
          </div>
        </div>
      </div>

      {/* BANNERS */}
      {uploadMsg&&<div style={{background:"#e8f4fd",borderBottom:"1px solid #b0d4f0",padding:"8px 24px",fontSize:12,color:"#0176d3",display:"flex",justifyContent:"space-between",alignItems:"center",fontWeight:500}}><span>✓ {uploadMsg}</span><button style={{background:"none",border:"none",cursor:"pointer",color:"#706e6b",fontSize:16}} onClick={()=>setUploadMsg("")}>×</button></div>}
      {syncMsg&&<div style={{background:"#e8f5e9",borderBottom:"1px solid #a3d9a5",padding:"8px 24px",fontSize:12,color:"#2e844a",fontWeight:500}}>✓ {syncMsg}</div>}
      {lastDbError&&<div style={{background:"#fce9e9",borderBottom:"1px solid #f5b0b0",padding:"8px 24px",fontSize:12,color:"#ba0517",fontWeight:500}}>✕ DB Error: {lastDbError}</div>}
      {dbStatus==="offline"&&<div style={{background:"#fff3e0",borderBottom:"1px solid #ffcc80",padding:"8px 24px",fontSize:12,color:"#dd7a01",fontWeight:500}}>⚠ Supabase unreachable — showing local defaults.</div>}

      {/* KPI SUMMARY BAR */}
      <div style={{background:"#fff",borderBottom:"1px solid #dddbda",padding:"12px 24px",display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:1}}>
        {[
          {label:"Total SKUs",    val:enriched.length,                                                  color:"#0176d3",  bg:"#f3f8fd"},
          {label:"Critical",      val:enriched.filter(s=>s.mrp.status==="critical").length,             color:"#ba0517",  bg:"#fce9e9"},
          {label:"At Risk",       val:enriched.filter(s=>s.mrp.status==="at-risk").length,              color:"#dd7a01",  bg:"#fff3e0"},
          {label:"Watch",         val:enriched.filter(s=>s.mrp.status==="watch").length,                color:"#706504",  bg:"#fffde0"},
          {label:"OK",            val:enriched.filter(s=>s.mrp.status==="ok").length,                   color:"#2e844a",  bg:"#e8f5e9"},
          {label:"Planned Orders",val:Object.values(mrpResults).reduce((s,r)=>s+r.orders.length,0),    color:"#5c4aad",  bg:"#f3eeff"},
        ].map((k,i)=>(
          <div key={k.label} style={{padding:"8px 20px",borderLeft:i>0?"1px solid #e8e8e8":"none",background:k.bg}}>
            <div style={{fontSize:28,fontWeight:700,color:k.color,lineHeight:1,fontVariantNumeric:"tabular-nums"}}>{k.val}</div>
            <div style={{fontSize:11,color:"#3e3e3c",fontWeight:600,marginTop:4,textTransform:"uppercase",letterSpacing:"0.04em"}}>{k.label}</div>
          </div>
        ))}
      </div>

      <div style={{padding:"16px 24px 32px"}} className="anim-in">
        {(view==="workbench"||view==="detail")&&view!=="detail"&&(
          <WorkbenchView enriched={filtered} filterCat={filterCat} setFilterCat={setFilterCat}
            filterStatus={filterStatus} setFilterStatus={setFilterStatus}
            search={search} setSearch={setSearch} openPOs={openPOs}
            onOpenDetail={s=>{setSelectedSKU(s);setView("detail");}}
            onEditParams={s=>setEditingParams(s)} catParams={catParams}
            categories={Object.keys(catParams).sort()}/>
        )}
        {view==="detail"&&selectedSKU&&(
          <DetailView sku={enriched.find(s=>s.id===selectedSKU.id)||selectedSKU} mrp={mrpResults[selectedSKU.id]}
            openPOs={openPOs[selectedSKU.id]||[]}
            onBack={()=>setView("workbench")} onEditParams={()=>setEditingParams(selectedSKU)}/>
        )}
        {view==="exceptions"&&(
          <ExceptionView exceptions={exceptions} onOpenDetail={s=>{setSelectedSKU(s);setView("detail");}}/>
        )}
        {view==="categories"&&(
          <CategoryView catSummary={catSummary} catParams={catParams}
            setCatParams={saveCatParams} enriched={enriched}/>
        )}
        {view==="demand"&&<DemandView/>}
      </div>

      {editingParams&&(
        <ParamModal sku={editingParams} catParams={catParams}
          skuOverrides={skuOverrides[editingParams.id]||{}}
          onSave={ov=>{saveSkuOverride(editingParams.id, ov);setEditingParams(null);}}
          onClose={()=>setEditingParams(null)}/>
      )}
    </div>
  );
}


// ─────────────────────────────────────────────
//  WORKBENCH VIEW (unchanged)
// ─────────────────────────────────────────────
function WorkbenchView({enriched,filterCat,setFilterCat,filterStatus,setFilterStatus,search,setSearch,openPOs,onOpenDetail,onEditParams,categories=CATEGORIES}) {
  const PAGE_SIZE = 50;
  const [page, setPage] = useState(1);
  useEffect(()=>{setPage(1);},[filterCat,filterStatus,search]);
  const totalPages = Math.max(1, Math.ceil(enriched.length / PAGE_SIZE));
  const paged = enriched.slice((page-1)*PAGE_SIZE, page*PAGE_SIZE);
  return (
    <div>
      {/* SLDS List Header */}
      <div style={{display:"flex",gap:8,marginBottom:12,alignItems:"center",flexWrap:"wrap",padding:"12px 16px",background:"#fff",border:"1px solid #dddbda",borderRadius:"4px 4px 0 0",borderBottom:"none"}}>
        <span style={{fontSize:13,fontWeight:700,color:"#181818",marginRight:8}}>SKU List</span>
        <span style={{fontSize:12,color:"#706e6b",marginRight:"auto"}}>{enriched.length} items</span>
        <input className="input" placeholder="Search SKU or name…" value={search} onChange={e=>setSearch(e.target.value)} style={{width:200}}/>
        <select className="select" value={filterCat} onChange={e=>setFilterCat(e.target.value)}>
          <option>All</option>
          {categories.map(c=><option key={c}>{c}</option>)}
        </select>
        <select className="select" value={filterStatus} onChange={e=>setFilterStatus(e.target.value)}>
          <option value="All">All Status</option>
          <option value="critical">Critical</option>
          <option value="at-risk">At Risk</option>
          <option value="watch">Watch</option>
          <option value="ok">OK</option>
        </select>
      </div>
      <div className="card" style={{overflow:"auto",borderRadius:"0 0 4px 4px"}}>
        <table>
          <thead>
            <tr>
              {["SKU","Description","Category","Stock","Safety Stock","Reorder Point","Days Cover","Lead Time","MOQ","Open Orders","Planned","Status",""].map(h=>(
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {paged.map(s=>{
              const pos = openPOs[s.id]||[];
              const totalOpen = pos.reduce((sum,p)=>sum+p.qty,0);
              const status = s.mrp.status;
              return (
                <tr key={s.id} className="sku-row" onClick={()=>onOpenDetail(s)}
                  style={{background:status==="critical"?"#fff1f1":status==="at-risk"?"#fff7ed":"transparent"}}>
                  <td><span style={{color:"#2563eb",fontWeight:600}}>{s.id}</span></td>
                  <td style={{color:"#0f172a",maxWidth:180}}>{s.name}</td>
                  <td><span className="tag">{s.category}</span></td>
                  <td style={{color:s.stock<s.safetyStock?"#dc2626":"#334155"}}>{Math.floor(s.stock)}</td>
                  <td style={{color:"#94a3b8"}}>{Math.floor(s.safetyStock)}</td>
                  <td style={{color:"#7c3aed",fontWeight:500}}>{Math.floor(s.mrp.rop)}</td>
                  <td style={{color:s.mrp.daysOfStock<s.leadTime/7?"#ea580c":"#334155"}}>
                    {s.mrp.daysOfStock>0?Math.floor(s.mrp.daysOfStock)+"d":<span style={{color:"#dc2626"}}>STOCKOUT</span>}
                  </td>
                  <td style={{color:"#94a3b8"}}>{s.leadTime}d</td>
                  <td style={{color:"#94a3b8"}}>{s.moq}</td>
                  <td style={{color:totalOpen>0?"#7c3aed":"#94a3b8"}}>{totalOpen>0?Math.floor(totalOpen):""}</td>
                  <td style={{color:s.mrp.orders.length>0?"#2563eb":"#94a3b8"}}>
                    {s.mrp.orders.length>0?`${s.mrp.orders.length}   ${s.mrp.orders[0]?.qty}`:""}
                  </td>
                  <td><span className={`pill badge-${status}`}>{STATUS_LABEL[status]}</span></td>
                  <td>
                    <button className="btn" style={{padding:"3px 8px",fontSize:10}} onClick={e=>{e.stopPropagation();onEditParams(s);}}>PARAMS</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {totalPages>1&&(
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 16px",borderTop:"1px solid #dddbda",background:"#fafaf9"}}>
            <span style={{fontSize:12,color:"#706e6b"}}>
              {(page-1)*PAGE_SIZE+1}–{Math.min(page*PAGE_SIZE,enriched.length)} of {enriched.length} items
            </span>
            <div style={{display:"flex",gap:4,alignItems:"center"}}>
              <button className="btn" style={{padding:"4px 12px",fontSize:12}} disabled={page===1} onClick={()=>setPage(p=>p-1)}>‹ Previous</button>
              <span style={{padding:"4px 12px",fontSize:12,color:"#3e3e3c",background:"#e8f4fd",borderRadius:4,fontWeight:600}}>Page {page} / {totalPages}</span>
              <button className="btn" style={{padding:"4px 12px",fontSize:12}} disabled={page===totalPages} onClick={()=>setPage(p=>p+1)}>Next ›</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
//  DETAIL VIEW (unchanged)
// ─────────────────────────────────────────────
function DetailView({sku,mrp,openPOs,onBack,onEditParams}) {
  const chartData = mrp.curve.filter((_,i)=>i%3===0);
  const status = mrp.status;
  return (
    <div>
      {/* SLDS Page Header */}
      <div className="page-header" style={{marginBottom:16}}>
        <button className="btn" onClick={onBack} style={{fontSize:12,padding:"5px 12px"}}>← Back</button>
        <div style={{width:1,height:24,background:"#dddbda",margin:"0 4px"}}/>
        <div style={{flex:1}}>
          <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
            <span style={{fontSize:18,fontWeight:700,color:"#0176d3",letterSpacing:"0.01em"}}>{sku.id}</span>
            <span style={{fontSize:15,color:"#181818",fontWeight:500}}>{sku.name}</span>
            <span className="tag">{sku.category}</span>
            <span className={`pill badge-${status}`}>{STATUS_LABEL[status]}</span>
          </div>
        </div>
        <button className="btn btn-primary" style={{fontSize:12,padding:"6px 16px"}} onClick={onEditParams}>Edit Parameters</button>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:12,marginBottom:20}}>
        {[
          {label:"Current Stock",  val:Math.floor(sku.stock),                                          unit:"units",  color:sku.stock<sku.safetyStock?"#ba0517":"#181818", border:sku.stock<sku.safetyStock?"3px solid #ba0517":"3px solid #dddbda"},
          {label:"Safety Stock",   val:Math.floor(sku.safetyStock),                                    unit:"units",  color:"#3e3e3c", border:"3px solid #dddbda"},
          {label:"Reorder Point",  val:Math.floor(mrp.rop),                                            unit:"units",  color:"#5c4aad", border:"3px solid #5c4aad"},
          {label:"Days of Cover",  val:mrp.daysOfStock>0?Math.floor(mrp.daysOfStock):"STOCKOUT",       unit:mrp.daysOfStock>0?"days":"", color:mrp.daysOfStock<sku.leadTime/7?"#dd7a01":"#181818", border:mrp.daysOfStock<sku.leadTime/7?"3px solid #dd7a01":"3px solid #dddbda"},
          {label:"Lead Time",      val:sku.leadTime,                                                   unit:"days",   color:"#0176d3", border:"3px solid #0176d3"},
          {label:"Avg Daily Use",  val:Math.floor(sku.avgDaily),                                       unit:"units/d",color:"#3e3e3c", border:"3px solid #dddbda"},
        ].map(k=>(
          <div key={k.label} className="stat-card" style={{borderTop:k.border}}>
            <div style={{fontSize:24,fontWeight:700,color:k.color,lineHeight:1,fontVariantNumeric:"tabular-nums"}}>
              {k.val}<span style={{fontSize:11,fontWeight:400,color:"#706e6b",marginLeft:5}}>{k.unit}</span>
            </div>
            <div style={{fontSize:11,fontWeight:700,color:"#3e3e3c",letterSpacing:"0.04em",textTransform:"uppercase",marginTop:8}}>{k.label}</div>
          </div>
        ))}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"2fr 1fr",gap:16}}>
        <div className="card" style={{padding:20}}>
          <div className="slds-section-title">Projected Stock Curve — 90 Day Horizon</div>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={chartData} margin={{top:5,right:20,bottom:5,left:0}}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e8e8e8"/>
              <XAxis dataKey="day" stroke="#dddbda" tick={{fontSize:11,fill:"#706e6b"}} label={{value:"Days",position:"insideBottom",offset:-2,fontSize:10,fill:"#706e6b"}}/>
              <YAxis stroke="#dddbda" tick={{fontSize:11,fill:"#706e6b"}}/>
              <Tooltip contentStyle={{background:"#fff",border:"1px solid #dddbda",borderRadius:4,fontSize:12,color:"#181818",boxShadow:"0 4px 12px rgba(0,0,0,0.15)"}} labelFormatter={d=>`Day ${d}`}/>
              <ReferenceLine y={sku.safetyStock} stroke="#dd7a01" strokeDasharray="4 3" label={{value:"Safety Stock",fill:"#dd7a01",fontSize:10,position:"insideTopLeft"}}/>
              <ReferenceLine y={mrp.rop} stroke="#5c4aad" strokeDasharray="4 3" label={{value:"ROP",fill:"#5c4aad",fontSize:10,position:"insideTopLeft"}}/>
              <ReferenceLine y={0} stroke="#ba0517" strokeDasharray="2 2"/>
              <Line type="monotone" dataKey="stock" stroke="#0176d3" strokeWidth={2} dot={false} name="Projected Stock"/>
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          <div className="card" style={{padding:16,flex:"none"}}>
            <div className="slds-section-title">Open Purchase Orders</div>
            {openPOs.length===0?<div style={{color:"#706e6b",fontSize:13,padding:"8px 0"}}>No open POs</div>
              :openPOs.map((po,i)=>(
              <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderBottom:"1px solid #f1f5f9",fontSize:12}}>
                <span style={{color:"#7c3aed"}}>+{po.qty} units</span>
                <span style={{color:"#64748b"}}>ETA Day {po.eta}</span>
              </div>
            ))}
          </div>
          <div className="card" style={{padding:16,flex:1}}>
            <div className="slds-section-title">Planned Orders (MRP)</div>
            {mrp.orders.length===0?<div style={{color:"#706e6b",fontSize:13,padding:"8px 0"}}>No planned orders</div>
              :mrp.orders.slice(0,6).map((o,i)=>(
              <div key={i} style={{padding:"9px 0",borderBottom:"1px solid #f3f3f3",fontSize:13}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <span style={{color:"#0176d3",fontWeight:700}}>{o.qty} units</span>
                  <span style={{color:"#2e844a",fontSize:11,fontWeight:600,background:"#e8f5e9",padding:"1px 7px",borderRadius:4}}>MOQ</span>
                </div>
                <div style={{display:"flex",justifyContent:"space-between",marginTop:4}}>
                  <span style={{color:"#706e6b",fontSize:11}}>Order Day {o.orderDay}</span>
                  <span style={{color:"#706e6b",fontSize:11}}>Receipt Day {o.receiptDay}</span>
                </div>
              </div>
            ))}
          </div>
          <div className="card" style={{padding:16}}>
            <div className="slds-section-title">Parameters</div>
            {[["Lead Time",sku.leadTime+"d"],["MOQ",sku.moq],["Order Multiple",sku.orderMultiple],["Reorder Point",Math.round(mrp.rop)+" units"],["Review Cycle",sku.reviewCycle+"d"]].map(([l,v])=>(
              <div key={l} style={{display:"flex",justifyContent:"space-between",padding:"7px 0",fontSize:13,borderBottom:"1px solid #f3f3f3"}}>
                <span style={{color:"#706e6b",fontWeight:500}}>{l}</span>
                <span style={{color:l==="Reorder Point"?"#5c4aad":"#181818",fontWeight:l==="Reorder Point"?700:500}}>{v}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
//  EXCEPTION VIEW (unchanged)
// ─────────────────────────────────────────────
function ExceptionView({exceptions,onOpenDetail}) {
  return (
    <div>
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:16,padding:"12px 16px",background:"#fff",border:"1px solid #dddbda",borderRadius:4,boxShadow:"0 2px 3px rgba(0,0,0,0.07)"}}>
        <span style={{fontSize:14,fontWeight:700,color:"#181818"}}>Exception Report</span>
        {exceptions.length>0&&<span style={{background:"#fce9e9",color:"#ba0517",fontWeight:700,fontSize:12,padding:"2px 10px",borderRadius:4,border:"1px solid #f5b0b0"}}>{exceptions.length} item{exceptions.length!==1?"s":""} at risk</span>}
      </div>
      {exceptions.length===0&&(
        <div className="card" style={{padding:40,textAlign:"center",color:"#16a34a"}}>
          <div style={{fontSize:32,marginBottom:8,color:"#2e844a"}}>✓</div>
          <div style={{fontWeight:600,color:"#181818",fontSize:14}}>No exceptions — all SKUs within parameters</div>
        </div>
      )}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(340px,1fr))",gap:12}}>
        {exceptions.map(s=>{
          const status=s.mrp.status;
          const borderColor = status==="critical"?"#ba0517":status==="at-risk"?"#dd7a01":"#706e6b";
          return (
            <div key={s.id} className="card" style={{padding:0,borderLeft:`4px solid ${borderColor}`,cursor:"pointer",overflow:"hidden"}} onClick={()=>onOpenDetail(s)}>
              <div style={{padding:"14px 16px",borderBottom:"1px solid #f3f3f3",display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                <div>
                  <div style={{color:"#0176d3",fontWeight:700,fontSize:14,letterSpacing:"0.01em"}}>{s.id}</div>
                  <div style={{color:"#3e3e3c",fontSize:12,marginTop:2,fontWeight:400}}>{s.name}</div>
                </div>
                <span className={`pill badge-${status}`} style={{flexShrink:0}}>{STATUS_LABEL[status]}</span>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:0,background:"#fafaf9"}}>
                {[
                  {l:"Stock",  v:Math.floor(s.stock),                                         color:s.stock<s.safetyStock?borderColor:"#181818"},
                  {l:"Safety", v:Math.floor(s.safetyStock),                                   color:"#3e3e3c"},
                  {l:"ROP",    v:Math.floor(s.mrp.rop),                                       color:"#5c4aad"},
                  {l:"Cover",  v:s.mrp.daysOfStock>0?Math.floor(s.mrp.daysOfStock)+"d":"OUT", color:borderColor},
                ].map((k,i)=>(
                  <div key={k.l} style={{padding:"10px 12px",borderLeft:i>0?"1px solid #e8e8e8":"none"}}>
                    <div style={{fontSize:18,fontWeight:700,color:k.color,fontVariantNumeric:"tabular-nums"}}>{k.v}</div>
                    <div style={{fontSize:10,color:"#706e6b",textTransform:"uppercase",letterSpacing:"0.06em",marginTop:2,fontWeight:600}}>{k.l}</div>
                  </div>
                ))}
              </div>
              {s.mrp.orders.length>0&&(
                <div style={{padding:"8px 14px",fontSize:12,color:"#0176d3",background:"#e8f4fd",borderTop:"1px solid #b0d4f0",fontWeight:500}}>
                  → {s.mrp.orders.length} planned order(s) · Next: {s.mrp.orders[0].qty} units (Day {s.mrp.orders[0].orderDay})
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
//  CATEGORY VIEW (unchanged logic, saveCatParams injected)
// ─────────────────────────────────────────────
function CategoryView({catSummary,catParams,setCatParams,enriched}) {
  const [editCat,setEditCat]=useState(null);
  const [draft,setDraft]=useState({});
  const chartData=Object.keys(catParams).sort().map(cat=>{
    const items=enriched.filter(s=>s.category===cat);
    return {
      cat:cat.split(" ")[0],
      critical:items.filter(s=>s.mrp.status==="critical").length,
      "at-risk":items.filter(s=>s.mrp.status==="at-risk").length,
      watch:items.filter(s=>s.mrp.status==="watch").length,
      ok:items.filter(s=>s.mrp.status==="ok").length,
    };
  });
  return (
    <div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20,marginBottom:20}}>
        <div className="card" style={{padding:20}}>
          <div className="slds-section-title">SKU Status by Category</div>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={chartData} margin={{top:0,right:10,bottom:0,left:-10}}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e8e8e8"/>
              <XAxis dataKey="cat" stroke="#dddbda" tick={{fontSize:11,fill:"#706e6b"}}/>
              <YAxis stroke="#dddbda" tick={{fontSize:11,fill:"#706e6b"}}/>
              <Tooltip contentStyle={{background:"#fff",border:"1px solid #dddbda",borderRadius:4,fontSize:12,color:"#181818",boxShadow:"0 4px 12px rgba(0,0,0,0.15)"}}/>
              <Legend wrapperStyle={{fontSize:11,color:"#3e3e3c"}}/>
              <Bar dataKey="critical" fill="#ba0517" stackId="a"/>
              <Bar dataKey="at-risk"  fill="#dd7a01" stackId="a"/>
              <Bar dataKey="watch"    fill="#c2a812" stackId="a"/>
              <Bar dataKey="ok"       fill="#2e844a" stackId="a" radius={[3,3,0,0]}/>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="card" style={{padding:20}}>
          <div className="slds-section-title">Planning Logic</div>
          <div style={{fontSize:13,color:"#3e3e3c",lineHeight:1.9}}>
            <p style={{marginBottom:8}}><span style={{color:"#5c4aad",fontWeight:700}}>Reorder Point</span> = Safety Stock + (Avg Daily × Lead Time)</p>
            <p style={{marginBottom:8}}><span style={{color:"#0176d3",fontWeight:700}}>Order Qty</span> = CEIL(Net Req / Order Multiple) × OM, min MOQ</p>
            <p style={{marginBottom:8}}><span style={{color:"#ba0517",fontWeight:700}}>CRITICAL</span> = Projected stock &lt; 0 at horizon</p>
            <p style={{marginBottom:8}}><span style={{color:"#dd7a01",fontWeight:700}}>AT RISK</span> = Stock &lt; Safety Stock at horizon</p>
            <p><span style={{color:"#706504",fontWeight:700}}>WATCH</span> = Days cover &lt; Lead Time (weeks)</p>
          </div>
        </div>
      </div>
      <div className="card" style={{overflow:"auto"}}>
        <table>
          <thead>
            <tr>
              {["Category","SKUs","Critical","At Risk","Watch","OK","Lead Time","MOQ","Order Multiple","Safety Stock","Review Cycle",""].map(h=>(
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {catSummary.map(row=>(
              <tr key={row.cat}>
                <td style={{color:"#181818",fontWeight:700}}>{row.cat}</td>
                <td style={{color:"#3e3e3c",fontWeight:600}}>{row.total}</td>
                <td>{row.critical>0?<span style={{color:"#ba0517",fontWeight:700}}>{row.critical}</span>:<span style={{color:"#dddbda"}}>—</span>}</td>
                <td>{row["at-risk"]>0?<span style={{color:"#dd7a01",fontWeight:700}}>{row["at-risk"]}</span>:<span style={{color:"#dddbda"}}>—</span>}</td>
                <td>{row.watch>0?<span style={{color:"#706504",fontWeight:700}}>{row.watch}</span>:<span style={{color:"#dddbda"}}>—</span>}</td>
                <td><span style={{color:"#2e844a",fontWeight:700}}>{row.ok}</span></td>
                <td>{catParams[row.cat]?.leadTime}d</td>
                <td>{catParams[row.cat]?.moq}</td>
                <td>{catParams[row.cat]?.orderMultiple}</td>
                <td>{catParams[row.cat]?.safetyStock}</td>
                <td>{catParams[row.cat]?.reviewCycle}d</td>
                <td>
                  <button className="btn" style={{padding:"3px 8px",fontSize:10}}
                    onClick={()=>{setEditCat(row.cat);setDraft({...catParams[row.cat]});}}>EDIT</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editCat&&(
        <div className="modal-overlay" onClick={()=>setEditCat(null)}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <div style={{background:"#032D60",padding:"16px 20px",borderRadius:"4px 4px 0 0",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div style={{fontSize:14,fontWeight:700,color:"#fff"}}>Edit Category Defaults — {editCat}</div>
              <button onClick={()=>setEditCat(null)} style={{background:"none",border:"none",color:"rgba(255,255,255,0.7)",fontSize:18,cursor:"pointer",lineHeight:1}}>×</button>
            </div>
            <div style={{padding:"20px"}}>
              {Object.entries(draft).map(([key,val])=>(
                <div key={key} style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
                  <label style={{fontSize:13,color:"#3e3e3c",fontWeight:600,textTransform:"capitalize"}}>{key.replace(/([A-Z])/g," $1")}</label>
                  <input className="input" type="number" value={val} style={{width:120,textAlign:"right"}}
                    onChange={e=>setDraft(d=>({...d,[key]:+e.target.value}))}/>
                </div>
              ))}
            </div>
            <div style={{display:"flex",gap:8,justifyContent:"flex-end",padding:"12px 20px",borderTop:"1px solid #dddbda",background:"#fafaf9",borderRadius:"0 0 4px 4px"}}>
              <button className="btn" onClick={()=>setEditCat(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={()=>{setCatParams({...catParams,[editCat]:draft});setEditCat(null);}}>Save to DB</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
//  PARAM MODAL (unchanged)
// ─────────────────────────────────────────────
function ParamModal({sku,catParams,skuOverrides,onSave,onClose}) {
  const cat=catParams[sku.category];
  const [draft,setDraft]=useState({
    leadTime:      skuOverrides.leadTime      ?? "",
    moq:           skuOverrides.moq           ?? "",
    orderMultiple: skuOverrides.orderMultiple ?? "",
    safetyStock:   skuOverrides.safetyStock   ?? "",
  });
  const fields=[
    {key:"leadTime",      label:"Lead Time (days)", catVal:cat?.leadTime},
    {key:"moq",           label:"MOQ",              catVal:cat?.moq},
    {key:"orderMultiple", label:"Order Multiple",   catVal:cat?.orderMultiple},
    {key:"safetyStock",   label:"Safety Stock",     catVal:cat?.safetyStock},
  ];
  const rop = (draft.safetyStock!==""?+draft.safetyStock:(cat?.safetyStock||0))
            + sku.avgDaily * (draft.leadTime!==""?+draft.leadTime:(cat?.leadTime||0));
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e=>e.stopPropagation()} style={{minWidth:480}}>
        {/* SLDS Modal Header */}
        <div style={{background:"#032D60",padding:"16px 20px",borderRadius:"4px 4px 0 0",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div>
            <div style={{fontSize:14,fontWeight:700,color:"#fff"}}>SKU Parameters — {sku.id}</div>
            <div style={{fontSize:11,color:"rgba(255,255,255,0.6)",marginTop:2}}>Leave blank to inherit from category: {sku.category}</div>
          </div>
          <button onClick={onClose} style={{background:"none",border:"none",color:"rgba(255,255,255,0.7)",fontSize:18,cursor:"pointer",lineHeight:1}}>×</button>
        </div>
        {/* Body */}
        <div style={{padding:"20px"}}>
          {fields.map(f=>(
            <div key={f.key} style={{display:"flex",alignItems:"center",gap:12,marginBottom:14,paddingBottom:14,borderBottom:"1px solid #f3f3f3"}}>
              <label style={{fontSize:13,color:"#3e3e3c",fontWeight:600,width:160,flexShrink:0}}>{f.label}</label>
              <input className="input" type="number" placeholder={`Default: ${f.catVal}`} value={draft[f.key]} style={{width:120,textAlign:"right"}}
                onChange={e=>setDraft(d=>({...d,[f.key]:e.target.value}))}/>
              {draft[f.key]!==""&&<span style={{fontSize:11,color:"#0176d3",fontWeight:700,background:"#e8f4fd",padding:"2px 8px",borderRadius:4}}>OVERRIDE</span>}
              <button className="btn" style={{fontSize:11,padding:"4px 10px",marginLeft:"auto"}} onClick={()=>setDraft(d=>({...d,[f.key]:""}))}>Reset</button>
            </div>
          ))}
          <div style={{background:"#f3eeff",border:"1px solid #c9b8f5",borderRadius:4,padding:"12px 16px",marginTop:4,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <span style={{fontSize:13,color:"#5c4aad",fontWeight:700}}>Calculated Reorder Point</span>
            <span style={{fontSize:20,fontWeight:700,color:"#5c4aad"}}>{Math.round(rop)} <span style={{fontSize:12,fontWeight:400,color:"#706e6b"}}>units</span></span>
          </div>
        </div>
        {/* Footer */}
        <div style={{display:"flex",gap:8,justifyContent:"flex-end",padding:"12px 20px",borderTop:"1px solid #dddbda",background:"#fafaf9",borderRadius:"0 0 4px 4px"}}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={()=>{
            const ov={};
            Object.entries(draft).forEach(([k,v])=>{ if(v!=="") ov[k]=+v; });
            onSave(ov);
          }}>Save to DB</button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
//  DEMAND ANALYSIS VIEW (unchanged)
// ─────────────────────────────────────────────
function parseDemandCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  return lines.slice(1).filter(l => l.trim()).map(l => {
    const vals = l.split(',').map(v => v.trim());
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i] ?? ''; });
    return obj;
  });
}
function parseMasterCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  const map = {};
  lines.slice(1).filter(l => l.trim()).forEach(l => {
    const vals = l.split(',').map(v => v.trim());
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i] ?? ''; });
    const id = (obj.sku || obj.id || '').toUpperCase();
    if (id) map[id] = {
      lt: parseFloat(obj.lt || obj.leadtime || obj['lead time'] || 0),
      moq: parseFloat(obj.moq || 0),
      multipleLot: parseFloat(obj.multiplelot || obj['multiple lot'] || obj.ordermultiple || 0),
    };
  });
  return map;
}
function calcDemandStats(rows) {
  const MONTHS = [1,2,3,4,5,6,7,8,9,10,11,12];
  return rows.filter(r => r.sku || r.id).map(r => {
    const sku = (r.sku || r.id || '').toUpperCase();
    const desc = r.description || r.name || r.desc || '';
    const vals = MONTHS.map(m => parseFloat(r['month'+m] || r['m'+m] || 0));
    const total = vals.reduce((a, b) => a + b, 0);
    const avg = total / 12;
    const mean = total / vals.length;
    const variance = vals.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / vals.length;
    const stdDev = Math.sqrt(variance);
    return { sku, desc, months: vals, total, avg, stdDev };
  });
}
function assignABC(items) {
  const sorted = [...items].sort((a, b) => b.total - a.total);
  const grandTotal = sorted.reduce((s, i) => s + i.total, 0);
  let cumulative = 0;
  return sorted.map(item => {
    cumulative += item.total;
    const pct = grandTotal > 0 ? cumulative / grandTotal : 0;
    const skuClass = pct <= 0.70 ? 'A' : pct <= 0.90 ? 'B' : 'C';
    const z = skuClass === 'A' ? 1.88 : skuClass === 'B' ? 1.64 : 1.28;
    return { ...item, cumPct: pct, skuClass, z };
  });
}
function enrichWithMaster(items, masterMap) {
  return items.map(item => {
    const m = masterMap[item.sku] || {};
    const lt = m.lt || 0;
    const moq = m.moq || 0;
    const multipleLot = m.multipleLot || 0;
    const safetyStock = lt > 0 ? item.z * item.stdDev * Math.sqrt(lt) : null;
    const rop = lt > 0 ? item.avg * lt + safetyStock : null;
    return { ...item, lt, moq, multipleLot, safetyStock, rop };
  });
}
function DemandView() {
  const [rows, setRows] = useState([]);
  const [masterMap, setMasterMap] = useState({});
  const [demandMsg, setDemandMsg] = useState('');
  const [masterMsg, setMasterMsg] = useState('');
  const [search, setSearch] = useState('');
  const [filterClass, setFilterClass] = useState('All');
  const [sortCol, setSortCol] = useState('total');
  const [sortDir, setSortDir] = useState('desc');
  const [demandPage, setDemandPage] = useState(1);
  const DEMAND_PAGE_SIZE = 50;
  const demandFileRef = useRef();
  const masterFileRef = useRef();
  const hasMaster = Object.keys(masterMap).length > 0;
  const analyzed = useMemo(() => {
    const base = assignABC(calcDemandStats(rows));
    return hasMaster ? enrichWithMaster(base, masterMap) : base;
  }, [rows, masterMap, hasMaster]);
  const filtered = useMemo(() => {
    let r = analyzed;
    if (filterClass !== 'All') r = r.filter(x => x.skuClass === filterClass);
    if (search) r = r.filter(x => x.sku.toLowerCase().includes(search.toLowerCase()) || x.desc.toLowerCase().includes(search.toLowerCase()));
    return [...r].sort((a, b) => {
      const av = a[sortCol] ?? 0, bv = b[sortCol] ?? 0;
      if (typeof av === 'string') return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      return sortDir === 'asc' ? av - bv : bv - av;
    });
  }, [analyzed, filterClass, search, sortCol, sortDir]);
  const counts = useMemo(() => ({
    A: analyzed.filter(x => x.skuClass === 'A').length,
    B: analyzed.filter(x => x.skuClass === 'B').length,
    C: analyzed.filter(x => x.skuClass === 'C').length,
    total: analyzed.length,
  }), [analyzed]);
  useEffect(()=>{setDemandPage(1);},[filterClass,search,sortCol,sortDir]);
  const totalDemandPages = Math.max(1, Math.ceil(filtered.length / DEMAND_PAGE_SIZE));
  const pagedFiltered = filtered.slice((demandPage-1)*DEMAND_PAGE_SIZE, demandPage*DEMAND_PAGE_SIZE);
  function handleDemandUpload(e) {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => { try { setRows(parseDemandCSV(ev.target.result)); setDemandMsg('Loaded from ' + file.name); } catch(err) { setDemandMsg('Error: ' + err.message); } };
    reader.readAsText(file); e.target.value = '';
  }
  function handleMasterUpload(e) {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => { try { const map = parseMasterCSV(ev.target.result); setMasterMap(map); setMasterMsg('Loaded ' + Object.keys(map).length + ' SKUs from ' + file.name); } catch(err) { setMasterMsg('Error: ' + err.message); } };
    reader.readAsText(file); e.target.value = '';
  }
  function handleExport() {
    const MONTHS = [1,2,3,4,5,6,7,8,9,10,11,12];
    const hdr = ['SKU','Description',...MONTHS.map(m=>'Month'+m),'Average','StdDeviation','SKU Class','Z',...(hasMaster?['LT','MOQ','MultipleLot','SafetyStock','ROP']:[])].join(',');
    const data = filtered.map(r => [r.sku,'"'+r.desc+'"',...r.months.map(v=>v.toFixed(2)),r.avg.toFixed(2),r.stdDev.toFixed(2),r.skuClass,r.z.toFixed(2),...(hasMaster?[r.lt||'',r.moq||'',r.multipleLot||'',r.safetyStock!=null?r.safetyStock.toFixed(2):'',r.rop!=null?r.rop.toFixed(2):'']:[])].join(','));
    const csv = '\uFEFF' + [hdr,...data].join('\n');
    const blob = new Blob([csv],{type:'text/csv;charset=utf-8;'}); const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href=url; a.download='demand-analysis.csv'; a.click(); URL.revokeObjectURL(url);
  }
  function toggleSort(col) { if (sortCol===col) setSortDir(d=>d==='asc'?'desc':'asc'); else { setSortCol(col); setSortDir('desc'); } }
  const MONTHS=[1,2,3,4,5,6,7,8,9,10,11,12];
  const CB={A:'#16a34a',B:'#2563eb',C:'#94a3b8'};
  const BG={A:'#dcfce7',B:'#dbeafe',C:'#f1f5f9'};
  const SH=(col,label,extra={})=><th style={{textAlign:'right',cursor:'pointer',whiteSpace:'nowrap',color:sortCol===col?'#2563eb':'#94a3b8',...extra}} onClick={()=>toggleSort(col)}>{label}{sortCol===col?(sortDir==='desc'?' ↓':' ↑'):''}</th>;
  return (
    <div>
      <div style={{display:'flex',gap:8,marginBottom:12,alignItems:'center',flexWrap:'wrap'}}>
        <input ref={demandFileRef} type="file" accept=".csv,.tsv,.txt" style={{display:'none'}} onChange={handleDemandUpload}/>
        <input ref={masterFileRef} type="file" accept=".csv,.tsv,.txt" style={{display:'none'}} onChange={handleMasterUpload}/>
        <button className="btn btn-primary" style={{fontSize:10,padding:'4px 12px'}} onClick={()=>demandFileRef.current.click()}>↑ Demand CSV</button>
        <button className={hasMaster?'btn btn-green':'btn'} style={{fontSize:10,padding:'4px 12px'}} onClick={()=>masterFileRef.current.click()}>↑ Master Data</button>
        {analyzed.length>0&&<button className="btn btn-green" style={{fontSize:10,padding:'4px 12px'}} onClick={handleExport}>↓ Export</button>}
        <input className="input" placeholder="Search…" value={search} onChange={e=>setSearch(e.target.value)} style={{width:200}}/>
        <select className="select" value={filterClass} onChange={e=>setFilterClass(e.target.value)}>
          <option value="All">All Classes</option><option value="A">Class A</option><option value="B">Class B</option><option value="C">Class C</option>
        </select>
        <span style={{marginLeft:'auto',fontSize:11,color:'#475569'}}>{filtered.length} SKUs</span>
      </div>
      {demandMsg&&<div style={{background:'#eff6ff',border:'1px solid #bfdbfe',borderRadius:3,padding:'5px 12px',fontSize:11,color:'#2563eb',marginBottom:6}}>{demandMsg}</div>}
      {masterMsg&&<div style={{background:'#f0fdf4',border:'1px solid #bbf7d0',borderRadius:3,padding:'5px 12px',fontSize:11,color:'#16a34a',marginBottom:6}}>{masterMsg}</div>}
      {!hasMaster&&rows.length>0&&<div style={{background:'#fffbeb',border:'1px solid #fde68a',borderRadius:3,padding:'7px 14px',fontSize:11,color:'#92400e',marginBottom:10}}>⚠ Upload <strong>Master Data CSV</strong> to compute Safety Stock and ROP</div>}
      {analyzed.length>0&&(
        <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,marginBottom:16}}>
          {[{label:'Total SKUs',val:counts.total,color:'#2563eb'},{label:'Class A – Z=1.88',val:counts.A,color:'#16a34a'},{label:'Class B – Z=1.64',val:counts.B,color:'#2563eb'},{label:'Class C – Z=1.28',val:counts.C,color:'#94a3b8'}].map(k=>(
            <div key={k.label} className="stat-card"><div style={{fontSize:22,fontWeight:600,color:k.color,fontFamily:"'IBM Plex Sans',sans-serif"}}>{k.val}</div><div style={{fontSize:10,color:'#94a3b8',letterSpacing:'0.08em',textTransform:'uppercase',marginTop:2}}>{k.label}</div></div>
          ))}
        </div>
      )}
      {rows.length===0&&(
        <div className="card" style={{padding:48,textAlign:'center'}}>
          <div style={{fontSize:32,marginBottom:12}}>📊</div>
          <div style={{fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:600,fontSize:14,color:'#0f172a',marginBottom:8}}>Demand Analysis</div>
          <div style={{display:'flex',gap:20,justifyContent:'center',flexWrap:'wrap',marginTop:16}}>
            <div style={{background:'#f8fafc',border:'1px solid #e2e8f0',borderRadius:3,padding:'12px 18px',fontSize:10,fontFamily:'monospace',textAlign:'left'}}><div style={{color:'#2563eb',marginBottom:4,fontWeight:600}}>DemandTable.csv</div><div>sku, description, month1…month12</div></div>
            <div style={{background:'#f0fdf4',border:'1px solid #bbf7d0',borderRadius:3,padding:'12px 18px',fontSize:10,fontFamily:'monospace',textAlign:'left'}}><div style={{color:'#16a34a',marginBottom:4,fontWeight:600}}>MasterDataTable.csv</div><div>sku, description, lt, moq, multiplelot</div></div>
          </div>
        </div>
      )}
      {rows.length>0&&(
        <div className="card" style={{overflow:'auto'}}>
          <table style={{minWidth:hasMaster?1900:1450}}>
            <thead><tr>
              <th style={{minWidth:90}}>SKU</th>
              <th style={{minWidth:150}}>Description</th>
              {MONTHS.map(m=><th key={m} style={{textAlign:'right',minWidth:52,color:'#94a3b8',cursor:'pointer'}} onClick={()=>toggleSort('m'+m)}>M{m}</th>)}
              {SH('avg','Average',{minWidth:78})}
              {SH('stdDev','Std Dev',{minWidth:78})}
              {SH('total','Total',{minWidth:72})}
              <th style={{textAlign:'center',minWidth:62}}>Class</th>
              <th style={{textAlign:'center',minWidth:52}}>Z</th>
              {hasMaster&&<>
                <th style={{textAlign:'right',minWidth:52,color:'#94a3b8'}}>LT</th>
                <th style={{textAlign:'right',minWidth:62,color:'#94a3b8'}}>MOQ</th>
                <th style={{textAlign:'right',minWidth:72,color:'#94a3b8'}}>Mult.Lot</th>
                {SH('safetyStock','Safety Stock',{minWidth:92,color:'#7c3aed'})}
                {SH('rop','ROP',{minWidth:80,color:'#7c3aed'})}
              </>}
              <th style={{textAlign:'right',minWidth:65}}>Cum %</th>
            </tr></thead>
            <tbody>
              {pagedFiltered.map((r,i)=>(
                <tr key={r.sku+i} style={{background:i%2===0?'transparent':'#fafafa'}}>
                  <td style={{color:'#2563eb',fontWeight:600}}>{r.sku}</td>
                  <td style={{color:'#0f172a',maxWidth:150,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{r.desc}</td>
                  {r.months.map((v,mi)=><td key={mi} style={{textAlign:'right',color:v===0?'#cbd5e1':'#334155',fontSize:11}}>{v>0?Math.floor(v):''}</td>)}
                  <td style={{textAlign:'right',fontWeight:600}}>{Math.floor(r.avg)}</td>
                  <td style={{textAlign:'right',color:'#7c3aed'}}>{Math.floor(r.stdDev)}</td>
                  <td style={{textAlign:'right',fontWeight:600}}>{Math.floor(r.total)}</td>
                  <td style={{textAlign:'center'}}><span style={{display:'inline-block',padding:'2px 10px',borderRadius:2,fontSize:11,fontWeight:700,background:BG[r.skuClass],color:CB[r.skuClass]}}>{r.skuClass}</span></td>
                  <td style={{textAlign:'center',fontWeight:600,color:CB[r.skuClass]}}>{r.z.toFixed(2)}</td>
                  {hasMaster&&<>
                    <td style={{textAlign:'right',color:'#64748b'}}>{r.lt||''}</td>
                    <td style={{textAlign:'right',color:'#64748b'}}>{r.moq||''}</td>
                    <td style={{textAlign:'right',color:'#64748b'}}>{r.multipleLot||''}</td>
                    <td style={{textAlign:'right',fontWeight:600,color:'#7c3aed'}}>{r.safetyStock!=null?Math.floor(r.safetyStock):''}</td>
                    <td style={{textAlign:'right',fontWeight:600,color:'#7c3aed'}}>{r.rop!=null?Math.floor(r.rop):''}</td>
                  </>}
                  <td style={{textAlign:'right',color:'#64748b',fontSize:11}}>{Math.floor(r.cumPct*100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          {totalDemandPages>1&&(
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'10px 14px',borderTop:'1px solid #e2e8f0',background:'#f8fafc'}}>
              <span style={{fontSize:11,color:'#64748b'}}>
                {(demandPage-1)*DEMAND_PAGE_SIZE+1}–{Math.min(demandPage*DEMAND_PAGE_SIZE,filtered.length)} di {filtered.length} SKU
              </span>
              <div style={{display:'flex',gap:4,alignItems:'center'}}>
                <button className="btn" style={{padding:'3px 10px',fontSize:11}} disabled={demandPage===1} onClick={()=>setDemandPage(p=>p-1)}>‹ Prec</button>
                <span style={{padding:'3px 10px',fontSize:11,color:'#334155'}}>{demandPage} / {totalDemandPages}</span>
                <button className="btn" style={{padding:'3px 10px',fontSize:11}} disabled={demandPage===totalDemandPages} onClick={()=>setDemandPage(p=>p+1)}>Succ ›</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

