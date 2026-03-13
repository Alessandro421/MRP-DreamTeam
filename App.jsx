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
  const headers = lines[0].split(',').map(h=>h.trim().toLowerCase());
  return lines.slice(1).map(l=>{
    const vals = l.split(',').map(v=>v.trim());
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
  const [catParams,     setCatParams]     = useState({...CATEGORY_DEFAULTS});
  const [skusRaw,       setSkusRaw]       = useState(SKUS_DEFAULT);
  const [openPOs,       setOpenPOs]       = useState(OPEN_POS_DEFAULT);
  const [skuOverrides,  setSkuOverrides]  = useState(
    Object.fromEntries(SKUS_DEFAULT.map(s=>[s.id, s.overrides]))
  );

  const [dbStatus, setDbStatus] = useState("loading"); // "loading" | "live" | "offline"
  const [uploadMsg, setUploadMsg] = useState('');
  const fileRef = useRef();

  // ── Load all data from Supabase on mount ──
  useEffect(() => {
    let cancelled = false;
    async function loadFromDB() {
      try {
        const [skusRes, posRes, ovRes, catRes] = await Promise.all([
          supabase.from('mrp_skus').select('*'),
          supabase.from('mrp_open_pos').select('*'),
          supabase.from('mrp_sku_overrides').select('*'),
          supabase.from('mrp_category_params').select('*'),
        ]);

        if (cancelled) return;

        if (skusRes.error || posRes.error || ovRes.error || catRes.error) {
          console.error('Supabase load error', skusRes.error || posRes.error || ovRes.error || catRes.error);
          setDbStatus("offline");
          return;
        }

        if (skusRes.data?.length)  setSkusRaw(dbSkusToApp(skusRes.data));
        if (posRes.data?.length)   setOpenPOs(dbPosToApp(posRes.data));
        if (ovRes.data?.length)    setSkuOverrides(dbOverridesToApp(ovRes.data));
        if (catRes.data?.length)   setCatParams(dbCatParamsToApp(catRes.data));

        setDbStatus("live");
      } catch (err) {
        if (!cancelled) {
          console.error('DB connection failed:', err);
          setDbStatus("offline");
        }
      }
    }
    loadFromDB();
    return () => { cancelled = true; };
  }, []);

  // ── Realtime subscription: auto-refresh when DB changes ──
  useEffect(() => {
    if (dbStatus !== "live") return;
    const channel = supabase
      .channel('mrp_realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'mrp_skus' }, async () => {
        const { data } = await supabase.from('mrp_skus').select('*');
        if (data) setSkusRaw(dbSkusToApp(data));
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'mrp_open_pos' }, async () => {
        const { data } = await supabase.from('mrp_open_pos').select('*');
        if (data) setOpenPOs(dbPosToApp(data));
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'mrp_sku_overrides' }, async () => {
        const { data } = await supabase.from('mrp_sku_overrides').select('*');
        if (data) setSkuOverrides(dbOverridesToApp(data));
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'mrp_category_params' }, async () => {
        const { data } = await supabase.from('mrp_category_params').select('*');
        if (data) setCatParams(dbCatParamsToApp(data));
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [dbStatus]);

  // ── Save SKU overrides to Supabase ──
  const saveSkuOverride = useCallback(async (skuId, overrides) => {
    setSkuOverrides(prev => ({ ...prev, [skuId]: overrides }));
    if (dbStatus !== "live") return;
    const row = {
      sku_id:         skuId,
      lead_time:      overrides.leadTime      ?? null,
      moq:            overrides.moq           ?? null,
      order_multiple: overrides.orderMultiple ?? null,
      safety_stock:   overrides.safetyStock   ?? null,
    };
    const { error } = await supabase.from('mrp_sku_overrides').upsert(row, { onConflict: 'sku_id' });
    if (error) console.error('Failed to save override:', error);
  }, [dbStatus]);

  // ── Save category params to Supabase ──
  const saveCatParams = useCallback(async (newParams) => {
    setCatParams(newParams);
    if (dbStatus !== "live") return;
    const rows = Object.entries(newParams).map(([cat, vals]) => ({
      category:       cat,
      lead_time:      vals.leadTime,
      moq:            vals.moq,
      order_multiple: vals.orderMultiple,
      safety_stock:   vals.safetyStock,
      review_cycle:   vals.reviewCycle,
    }));
    const { error } = await supabase.from('mrp_category_params').upsert(rows, { onConflict: 'category' });
    if (error) console.error('Failed to save cat params:', error);
  }, [dbStatus]);

  // ── File upload handler ──
  function handleUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const rows = parseCSV(ev.target.result);
        const newSkus = rowsToSkus(rows);
        const newPOs  = rowsToPOs(rows);

        if (newSkus.length) {
          setSkusRaw(newSkus);
          const newOv = Object.fromEntries(newSkus.map(s=>[s.id, s.overrides]));
          setSkuOverrides(newOv);
          setUploadMsg(`Loaded ${newSkus.length} SKUs from ${file.name}`);

          // Push to Supabase if connected
          if (dbStatus === "live") {
            const skuRows = newSkus.map(s => ({
              id:        s.id,
              name:      s.name,
              category:  s.category,
              stock:     s.stock,
              avg_daily: s.avgDaily,
            }));
            // Delete all existing SKUs, then insert fresh from CSV (replace semantics)
            await supabase.from('mrp_skus').delete().neq('id', '');
            const { error: skuErr } = await supabase.from('mrp_skus').insert(skuRows);
            if (skuErr) console.error('Insert SKUs error:', skuErr);

            // Save overrides
            const ovRows = newSkus.filter(s=>Object.keys(s.overrides).length>0).map(s=>({
              sku_id:         s.id,
              lead_time:      s.overrides.leadTime      ?? null,
              moq:            s.overrides.moq           ?? null,
              order_multiple: s.overrides.orderMultiple ?? null,
              safety_stock:   s.overrides.safetyStock   ?? null,
            }));
            // Delete all existing overrides, then insert fresh from CSV
            await supabase.from('mrp_sku_overrides').delete().neq('sku_id', '');
            if (ovRows.length) {
              const { error: ovErr } = await supabase.from('mrp_sku_overrides').insert(ovRows);
              if (ovErr) console.error('Insert overrides error:', ovErr);
            }
          }
        }

        const poCount = Object.values(newPOs).flat().length;
        if (poCount) {
          setOpenPOs(newPOs);
          setUploadMsg(prev => prev + ` + ${poCount} open POs`);

          if (dbStatus === "live") {
            // Delete existing, re-insert
            await supabase.from('mrp_open_pos').delete().neq('id', 0);
            const poRows = [];
            Object.entries(newPOs).forEach(([skuId, entries]) => {
              entries.forEach(p => poRows.push({ sku_id: skuId, qty: p.qty, eta_day: p.eta }));
            });
            if (poRows.length) {
              const { error: poErr } = await supabase.from('mrp_open_pos').insert(poRows);
              if (poErr) console.error('Insert POs error:', poErr);
            }
          }
        }

        if (!newSkus.length && !poCount) setUploadMsg('No valid SKU data found — check column headers.');
      } catch(err) {
        setUploadMsg('Parse error: ' + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  // ── Download MRP results ──
  function downloadResults() {
    const rows = enriched.map(s=>({
      SKU:            s.id,
      Description:    s.name,
      Category:       s.category,
      Stock:          s.stock,
      SafetyStock:    s.safetyStock,
      ReorderPoint:   Math.round(s.mrp.rop),
      LeadTime_d:     s.leadTime,
      MOQ:            s.moq,
      AvgDaily:       s.avgDaily,
      DaysCover:      s.mrp.daysOfStock>0?Math.round(s.mrp.daysOfStock):'STOCKOUT',
      PlannedOrders:  s.mrp.orders.length,
      NextOrderQty:   s.mrp.orders[0]?.qty??'',
      NextOrderDay:   s.mrp.orders[0]?.orderDay??'',
      NextReceiptDay: s.mrp.orders[0]?.receiptDay??'',
      Status:         STATUS_LABEL[s.mrp.status],
    }));
    downloadFile(toCSV(rows), 'mrp-results.csv', 'text/csv');
  }

  const skus = useMemo(()=>
    skusRaw.map(raw=>buildSKU({...raw, overrides:skuOverrides[raw.id]||{}}, catParams)),
    [skusRaw, skuOverrides, catParams]
  );
  const mrpResults = useMemo(()=>
    Object.fromEntries(skus.map(s=>[s.id, calcMRP(s, openPOs)])),
    [skus, openPOs]
  );
  const enriched = useMemo(()=>skus.map(s=>({...s, mrp:mrpResults[s.id]})), [skus, mrpResults]);
  const filtered = useMemo(()=>enriched.filter(s=>{
    if (filterCat!=='All' && s.category!==filterCat) return false;
    if (filterStatus!=='All' && s.mrp.status!==filterStatus) return false;
    if (search && !s.name.toLowerCase().includes(search.toLowerCase()) && !s.id.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  }), [enriched, filterCat, filterStatus, search]);
  const exceptions = useMemo(()=>enriched.filter(s=>s.mrp.status==="critical"||s.mrp.status==="at-risk")
    .sort((a,b)=>a.mrp.finalStock-b.mrp.finalStock), [enriched]);
  const catSummary = useMemo(()=>CATEGORIES.map(cat=>{
    const items=enriched.filter(s=>s.category===cat);
    const counts={critical:0,"at-risk":0,watch:0,ok:0};
    items.forEach(s=>counts[s.mrp.status]++);
    return {cat,total:items.length,...counts};
  }), [enriched]);

  const dbDot = dbStatus==="live" ? "#16a34a" : dbStatus==="loading" ? "#f59e0b" : "#dc2626";
  const dbLabel = dbStatus==="live" ? "DB LIVE" : dbStatus==="loading" ? "CONNECTING..." : "OFFLINE";

  return (
    <div style={{fontFamily:"'IBM Plex Mono','Courier New',monospace",background:"#f0f2f5",minHeight:"100vh",color:"#1e293b"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:6px;height:6px}
        ::-webkit-scrollbar-track{background:#e2e8f0}
        ::-webkit-scrollbar-thumb{background:#94a3b8;border-radius:3px}
        .nav-btn{background:none;border:none;padding:8px 16px;cursor:pointer;font-family:inherit;font-size:11px;letter-spacing:0.1em;text-transform:uppercase;transition:all 0.15s;border-bottom:2px solid transparent;color:#64748b}
        .nav-btn:hover{color:#2563eb}
        .nav-btn.active{color:#2563eb;border-bottom-color:#2563eb}
        .sku-row{transition:background 0.1s;cursor:pointer}
        .sku-row:hover{background:#e8edf5!important}
        .pill{display:inline-block;padding:2px 8px;border-radius:2px;font-size:10px;font-weight:600;letter-spacing:0.08em}
        .btn{border:1px solid #cbd5e1;background:#ffffff;color:#64748b;padding:6px 14px;font-family:inherit;font-size:11px;cursor:pointer;transition:all 0.15s;border-radius:2px}
        .btn:hover{border-color:#2563eb;color:#2563eb}
        .btn-primary{background:#2563eb;border-color:#2563eb;color:white}
        .btn-primary:hover{background:#1d4ed8;border-color:#1d4ed8;color:white}
        .btn-green{background:#16a34a;border-color:#16a34a;color:white}
        .btn-green:hover{background:#15803d;border-color:#15803d;color:white}
        .input{background:#ffffff;border:1px solid #cbd5e1;color:#1e293b;padding:6px 10px;font-family:inherit;font-size:12px;border-radius:2px;outline:none}
        .input:focus{border-color:#2563eb}
        .select{background:#ffffff;border:1px solid #cbd5e1;color:#1e293b;padding:6px 10px;font-family:inherit;font-size:12px;border-radius:2px;outline:none;cursor:pointer}
        .card{background:#ffffff;border:1px solid #e2e8f0;border-radius:4px;box-shadow:0 1px 3px rgba(0,0,0,0.06)}
        .stat-card{background:#ffffff;border:1px solid #e2e8f0;border-radius:4px;padding:16px 20px;box-shadow:0 1px 3px rgba(0,0,0,0.06)}
        .tag{font-size:10px;padding:2px 6px;background:#dbeafe;color:#2563eb;border-radius:2px;letter-spacing:0.05em}
        .modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;z-index:100}
        .modal{background:#ffffff;border:1px solid #e2e8f0;border-radius:6px;padding:24px;min-width:400px;box-shadow:0 8px 30px rgba(0,0,0,0.12)}
        table{width:100%;border-collapse:collapse}
        th{background:#f8fafc;color:#94a3b8;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;padding:10px 12px;text-align:left;border-bottom:1px solid #e2e8f0;font-weight:500}
        td{padding:10px 12px;font-size:12px;border-bottom:1px solid #f1f5f9;color:#334155}
        .anim-in{animation:fadeSlide 0.2s ease}
        @keyframes fadeSlide{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
        .badge-critical{background:#fee2e2;color:#dc2626}
        .badge-at-risk{background:#ffedd5;color:#ea580c}
        .badge-watch{background:#fef9c3;color:#ca8a04}
        .badge-ok{background:#dcfce7;color:#16a34a}
      `}</style>

      {/* HEADER */}
      <div style={{borderBottom:"1px solid #e2e8f0",padding:"0 24px",display:"flex",alignItems:"center",gap:24,height:52,background:"#ffffff",boxShadow:"0 1px 3px rgba(0,0,0,0.06)"}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginRight:16}}>
          <div style={{width:8,height:8,background:"#2563eb",borderRadius:"50%",boxShadow:"0 0 8px #93c5fd"}}/>
          <span style={{fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:700,fontSize:14,color:"#0f172a",letterSpacing:"0.05em"}}>MRP PLANNER</span>
          <span style={{color:"#94a3b8",fontSize:12}}>// EMEA</span>
        </div>
        {["workbench","exceptions","categories","demand"].map(v=>(
          <button key={v} className={`nav-btn${view===v||(view==="detail"&&v==="workbench")?" active":""}`}
            onClick={()=>setView(v)}>
            {v==="workbench"?"Planner Workbench":v==="exceptions"?`Exceptions (${exceptions.length})`:v==="categories"?"Category Summary":"Demand Analysis"}
          </button>
        ))}
        <div style={{marginLeft:"auto",display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
          <input ref={fileRef} type="file" accept=".csv,.tsv,.txt" style={{display:"none"}} onChange={handleUpload}/>
          <button className="btn" style={{fontSize:10,padding:"4px 10px"}} onClick={()=>fileRef.current.click()}>
            ↑ Upload CSV
          </button>
          <button className="btn btn-green" style={{fontSize:10,padding:"4px 10px"}} onClick={downloadResults}>
            ↓ Export CSV
          </button>
          <span className="tag">Horizon: 90d</span>
          <span className="tag">SKUs: {skusRaw.length}</span>
          {/* DB Status indicator */}
          <div style={{display:"flex",alignItems:"center",gap:5,padding:"3px 8px",background:"#f8fafc",border:"1px solid #e2e8f0",borderRadius:2}}>
            <div style={{width:7,height:7,background:dbDot,borderRadius:"50%",boxShadow:`0 0 6px ${dbDot}`}}/>
            <span style={{fontSize:10,color:"#64748b",letterSpacing:"0.06em"}}>{dbLabel}</span>
          </div>
        </div>
      </div>

      {/* Upload message banner */}
      {uploadMsg&&(
        <div style={{background:"#eff6ff",borderBottom:"1px solid #bfdbfe",padding:"6px 24px",fontSize:11,color:"#2563eb",display:"flex",justifyContent:"space-between"}}>
          <span>{uploadMsg}</span>
          <button style={{background:"none",border:"none",cursor:"pointer",color:"#94a3b8",fontSize:12}} onClick={()=>setUploadMsg('')}>✕</button>
        </div>
      )}

      {/* DB offline warning */}
      {dbStatus==="offline"&&(
        <div style={{background:"#fef9c3",borderBottom:"1px solid #fde047",padding:"6px 24px",fontSize:11,color:"#854d0e"}}>
          ⚠ Supabase unreachable — showing local defaults. Check your anon key in supabaseClient.js and RLS policies.
        </div>
      )}

      {/* KPI BAR */}
      <div style={{display:"flex",gap:1,padding:"12px 24px",borderBottom:"1px solid #e2e8f0",background:"#f8fafc"}}>
        {[
          {label:"Total SKUs",     val:enriched.length,                                                    color:"#2563eb"},
          {label:"Critical",       val:enriched.filter(s=>s.mrp.status==="critical").length,               color:"#dc2626"},
          {label:"At Risk",        val:enriched.filter(s=>s.mrp.status==="at-risk").length,                color:"#ea580c"},
          {label:"Watch",          val:enriched.filter(s=>s.mrp.status==="watch").length,                  color:"#ca8a04"},
          {label:"OK",             val:enriched.filter(s=>s.mrp.status==="ok").length,                     color:"#16a34a"},
          {label:"Planned Orders", val:Object.values(mrpResults).reduce((s,r)=>s+r.orders.length,0),       color:"#7c3aed"},
        ].map(k=>(
          <div key={k.label} className="stat-card" style={{flex:1}}>
            <div style={{fontSize:22,fontWeight:600,color:k.color,fontFamily:"'IBM Plex Sans',sans-serif"}}>{k.val}</div>
            <div style={{fontSize:10,color:"#94a3b8",letterSpacing:"0.08em",textTransform:"uppercase",marginTop:2}}>{k.label}</div>
          </div>
        ))}
      </div>

      <div style={{padding:24}} className="anim-in">
        {(view==="workbench"||view==="detail")&&view!=="detail"&&(
          <WorkbenchView enriched={filtered} filterCat={filterCat} setFilterCat={setFilterCat}
            filterStatus={filterStatus} setFilterStatus={setFilterStatus}
            search={search} setSearch={setSearch} openPOs={openPOs}
            onOpenDetail={s=>{setSelectedSKU(s);setView("detail");}}
            onEditParams={s=>setEditingParams(s)} catParams={catParams}/>
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
function WorkbenchView({enriched,filterCat,setFilterCat,filterStatus,setFilterStatus,search,setSearch,openPOs,onOpenDetail,onEditParams}) {
  const PAGE_SIZE = 50;
  const [page, setPage] = useState(1);
  useEffect(()=>{setPage(1);},[filterCat,filterStatus,search]);
  const totalPages = Math.max(1, Math.ceil(enriched.length / PAGE_SIZE));
  const paged = enriched.slice((page-1)*PAGE_SIZE, page*PAGE_SIZE);
  return (
    <div>
      <div style={{display:"flex",gap:10,marginBottom:16,alignItems:"center",flexWrap:"wrap"}}>
        <input className="input" placeholder="Search SKU / name…" value={search} onChange={e=>setSearch(e.target.value)} style={{width:220}}/>
        <select className="select" value={filterCat} onChange={e=>setFilterCat(e.target.value)}>
          <option>All</option>
          {CATEGORIES.map(c=><option key={c}>{c}</option>)}
        </select>
        <select className="select" value={filterStatus} onChange={e=>setFilterStatus(e.target.value)}>
          <option value="All">All Status</option>
          <option value="critical">Critical</option>
          <option value="at-risk">At Risk</option>
          <option value="watch">Watch</option>
          <option value="ok">OK</option>
        </select>
        <span style={{marginLeft:"auto",fontSize:11,color:"#475569"}}>{enriched.length} SKUs</span>
      </div>
      <div className="card" style={{overflow:"auto"}}>
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
                    {s.mrp.orders.length>0?`${s.mrp.orders.length} × ${s.mrp.orders[0]?.qty}`:""}
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
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 14px",borderTop:"1px solid #e2e8f0",background:"#f8fafc"}}>
            <span style={{fontSize:11,color:"#64748b"}}>
              {(page-1)*PAGE_SIZE+1}–{Math.min(page*PAGE_SIZE,enriched.length)} di {enriched.length} SKU
            </span>
            <div style={{display:"flex",gap:4,alignItems:"center"}}>
              <button className="btn" style={{padding:"3px 10px",fontSize:11}} disabled={page===1} onClick={()=>setPage(p=>p-1)}>‹ Prec</button>
              <span style={{padding:"3px 10px",fontSize:11,color:"#334155"}}>{page} / {totalPages}</span>
              <button className="btn" style={{padding:"3px 10px",fontSize:11}} disabled={page===totalPages} onClick={()=>setPage(p=>p+1)}>Succ ›</button>
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
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:20}}>
        <button className="btn" onClick={onBack}>← Back</button>
        <span style={{color:"#2563eb",fontWeight:600,fontSize:16}}>{sku.id}</span>
        <span style={{color:"#0f172a",fontSize:14}}>{sku.name}</span>
        <span className="tag">{sku.category}</span>
        <span className={`pill badge-${status}`} style={{marginLeft:8}}>{STATUS_LABEL[status]}</span>
        <button className="btn" style={{marginLeft:"auto"}} onClick={onEditParams}>Edit Parameters</button>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:12,marginBottom:20}}>
        {[
          {label:"Current Stock",  val:Math.floor(sku.stock),           unit:"units", highlight:sku.stock<sku.safetyStock},
          {label:"Safety Stock",   val:Math.floor(sku.safetyStock),     unit:"units"},
          {label:"Reorder Point",  val:Math.floor(mrp.rop), unit:"units", highlight:sku.stock<=mrp.rop, color:"#7c3aed"},
          {label:"Days of Cover",  val:mrp.daysOfStock>0?Math.floor(mrp.daysOfStock):"STCKOUT", unit:mrp.daysOfStock>0?"days":"", highlight:mrp.daysOfStock<sku.leadTime/7},
          {label:"Lead Time",      val:sku.leadTime,        unit:"days"},
          {label:"Avg Daily Use",  val:Math.floor(sku.avgDaily),        unit:"units/day"},
        ].map(k=>(
          <div key={k.label} className="stat-card">
            <div style={{fontSize:20,fontWeight:600,color:k.color||(k.highlight?"#dc2626":"#0f172a"),fontFamily:"'IBM Plex Sans',sans-serif"}}>
              {k.val}<span style={{fontSize:11,color:"#94a3b8",marginLeft:4}}>{k.unit}</span>
            </div>
            <div style={{fontSize:10,color:"#94a3b8",letterSpacing:"0.08em",textTransform:"uppercase",marginTop:3}}>{k.label}</div>
          </div>
        ))}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"2fr 1fr",gap:16}}>
        <div className="card" style={{padding:20}}>
          <div style={{fontSize:11,color:"#475569",letterSpacing:"0.08em",textTransform:"uppercase",marginBottom:16}}>
            Projected Stock Curve — 90 Day Horizon
          </div>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={chartData} margin={{top:5,right:20,bottom:5,left:0}}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0"/>
              <XAxis dataKey="day" stroke="#cbd5e1" tick={{fontSize:10,fill:"#94a3b8"}}/>
              <YAxis stroke="#cbd5e1" tick={{fontSize:10,fill:"#94a3b8"}}/>
              <Tooltip contentStyle={{background:"#ffffff",border:"1px solid #e2e8f0",borderRadius:4,fontSize:11,color:"#334155"}} labelFormatter={d=>`Day ${d}`}/>
              <ReferenceLine y={sku.safetyStock} stroke="#ea580c" strokeDasharray="4 3" label={{value:"Safety",fill:"#ea580c",fontSize:10}}/>
              <ReferenceLine y={mrp.rop} stroke="#7c3aed" strokeDasharray="4 3" label={{value:"ROP",fill:"#7c3aed",fontSize:10}}/>
              <ReferenceLine y={0} stroke="#dc2626" strokeDasharray="2 2"/>
              <Line type="monotone" dataKey="stock" stroke="#2563eb" strokeWidth={2} dot={false} name="Projected Stock"/>
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          <div className="card" style={{padding:16}}>
            <div style={{fontSize:10,color:"#475569",letterSpacing:"0.08em",textTransform:"uppercase",marginBottom:12}}>Open Purchase Orders</div>
            {openPOs.length===0?<div style={{color:"#334155",fontSize:12}}>No open POs</div>
              :openPOs.map((po,i)=>(
              <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderBottom:"1px solid #f1f5f9",fontSize:12}}>
                <span style={{color:"#7c3aed"}}>+{po.qty} units</span>
                <span style={{color:"#64748b"}}>ETA Day {po.eta}</span>
              </div>
            ))}
          </div>
          <div className="card" style={{padding:16,flex:1}}>
            <div style={{fontSize:10,color:"#475569",letterSpacing:"0.08em",textTransform:"uppercase",marginBottom:12}}>Planned Orders (MRP)</div>
            {mrp.orders.length===0?<div style={{color:"#334155",fontSize:12}}>No planned orders</div>
              :mrp.orders.slice(0,6).map((o,i)=>(
              <div key={i} style={{padding:"8px 0",borderBottom:"1px solid #f1f5f9",fontSize:12}}>
                <div style={{display:"flex",justifyContent:"space-between"}}>
                  <span style={{color:"#2563eb"}}>{o.qty} units</span>
                  <span style={{color:"#16a34a",fontSize:10}}>MOQ</span>
                </div>
                <div style={{display:"flex",justifyContent:"space-between",marginTop:2}}>
                  <span style={{color:"#94a3b8",fontSize:10}}>Order Day {o.orderDay}</span>
                  <span style={{color:"#94a3b8",fontSize:10}}>Receipt Day {o.receiptDay}</span>
                </div>
              </div>
            ))}
          </div>
          <div className="card" style={{padding:16}}>
            <div style={{fontSize:10,color:"#475569",letterSpacing:"0.08em",textTransform:"uppercase",marginBottom:10}}>Parameters</div>
            {[["Lead Time",sku.leadTime+"d"],["MOQ",sku.moq],["Order Multiple",sku.orderMultiple],["Reorder Point",Math.round(mrp.rop)],["Review Cycle",sku.reviewCycle+"d"]].map(([l,v])=>(
              <div key={l} style={{display:"flex",justifyContent:"space-between",padding:"4px 0",fontSize:12}}>
                <span style={{color:"#64748b"}}>{l}</span>
                <span style={{color:l==="Reorder Point"?"#7c3aed":"#334155",fontWeight:l==="Reorder Point"?600:400}}>{v}</span>
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
      <div style={{marginBottom:16,fontSize:11,color:"#475569",letterSpacing:"0.08em",textTransform:"uppercase"}}>
        {exceptions.length} SKUs requiring immediate attention
      </div>
      {exceptions.length===0&&(
        <div className="card" style={{padding:40,textAlign:"center",color:"#16a34a"}}>
          <div style={{fontSize:24,marginBottom:8}}>✓</div>
          <div style={{fontFamily:"'IBM Plex Sans',sans-serif",fontWeight:600,color:"#0f172a"}}>No exceptions — all SKUs within parameters</div>
        </div>
      )}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(340px,1fr))",gap:12}}>
        {exceptions.map(s=>{
          const status=s.mrp.status;
          return (
            <div key={s.id} className="card" style={{padding:18,borderColor:STATUS_COLOR[status]+"44",cursor:"pointer"}} onClick={()=>onOpenDetail(s)}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:12}}>
                <div>
                  <div style={{color:"#2563eb",fontWeight:600,fontSize:13}}>{s.id}</div>
                  <div style={{color:"#0f172a",fontSize:12,marginTop:2}}>{s.name}</div>
                </div>
                <span className={`pill badge-${status}`}>{STATUS_LABEL[status]}</span>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:8}}>
                {[
                  {l:"Stock",  v:Math.floor(s.stock),                warn:s.stock<s.safetyStock},
                  {l:"Safety", v:Math.floor(s.safetyStock)},
                  {l:"ROP",    v:Math.floor(s.mrp.rop),  color:"#7c3aed"},
                  {l:"Cover",  v:s.mrp.daysOfStock>0?Math.floor(s.mrp.daysOfStock)+"d":"OUT", warn:true},
                ].map(k=>(
                  <div key={k.l} style={{background:"#f8fafc",border:"1px solid #e2e8f0",padding:"8px 10px",borderRadius:3}}>
                    <div style={{fontSize:16,fontWeight:600,color:k.color||(k.warn?STATUS_COLOR[status]:"#0f172a"),fontFamily:"'IBM Plex Sans',sans-serif"}}>{k.v}</div>
                    <div style={{fontSize:9,color:"#94a3b8",textTransform:"uppercase",letterSpacing:"0.06em"}}>{k.l}</div>
                  </div>
                ))}
              </div>
              {s.mrp.orders.length>0&&(
                <div style={{marginTop:10,fontSize:11,color:"#2563eb",background:"#eff6ff",border:"1px solid #bfdbfe",padding:"6px 10px",borderRadius:3}}>
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
  const chartData=CATEGORIES.map(cat=>{
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
          <div style={{fontSize:10,color:"#475569",letterSpacing:"0.08em",textTransform:"uppercase",marginBottom:16}}>SKU Status by Category</div>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={chartData} margin={{top:0,right:10,bottom:0,left:-10}}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0"/>
              <XAxis dataKey="cat" stroke="#cbd5e1" tick={{fontSize:10,fill:"#94a3b8"}}/>
              <YAxis stroke="#cbd5e1" tick={{fontSize:10,fill:"#94a3b8"}}/>
              <Tooltip contentStyle={{background:"#ffffff",border:"1px solid #e2e8f0",borderRadius:4,fontSize:11,color:"#334155"}}/>
              <Legend wrapperStyle={{fontSize:10}}/>
              <Bar dataKey="critical" fill="#dc2626" stackId="a"/>
              <Bar dataKey="at-risk"  fill="#ea580c" stackId="a"/>
              <Bar dataKey="watch"    fill="#ca8a04" stackId="a"/>
              <Bar dataKey="ok"       fill="#16a34a" stackId="a"/>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="card" style={{padding:20}}>
          <div style={{fontSize:10,color:"#475569",letterSpacing:"0.08em",textTransform:"uppercase",marginBottom:12}}>Planning Logic</div>
          <div style={{fontSize:11,color:"#64748b",lineHeight:1.8}}>
            <p style={{marginBottom:8}}><span style={{color:"#7c3aed"}}>Reorder Point</span> = Safety Stock + (Avg Daily × Lead Time)</p>
            <p style={{marginBottom:8}}><span style={{color:"#2563eb"}}>Order Qty</span> = CEIL(Net Req / Order Multiple) × OM, min MOQ</p>
            <p style={{marginBottom:8}}><span style={{color:"#dc2626"}}>CRITICAL</span> = Projected stock &lt; 0 at horizon</p>
            <p style={{marginBottom:8}}><span style={{color:"#ea580c"}}>AT RISK</span> = Stock &lt; Safety Stock at horizon</p>
            <p><span style={{color:"#ca8a04"}}>WATCH</span> = Days cover &lt; Lead Time (weeks)</p>
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
                <td style={{color:"#0f172a",fontWeight:600}}>{row.cat}</td>
                <td>{row.total}</td>
                <td style={{color:row.critical>0?"#dc2626":"#94a3b8"}}>{row.critical||""}</td>
                <td style={{color:row["at-risk"]>0?"#ea580c":"#94a3b8"}}>{row["at-risk"]||""}</td>
                <td style={{color:row.watch>0?"#ca8a04":"#94a3b8"}}>{row.watch||""}</td>
                <td style={{color:"#16a34a"}}>{row.ok}</td>
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
            <div style={{fontSize:13,fontWeight:600,color:"#0f172a",marginBottom:20}}>Edit Category Defaults — {editCat}</div>
            {Object.entries(draft).map(([key,val])=>(
              <div key={key} style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
                <label style={{fontSize:12,color:"#94a3b8",textTransform:"uppercase",letterSpacing:"0.06em"}}>{key}</label>
                <input className="input" type="number" value={val} style={{width:100,textAlign:"right"}}
                  onChange={e=>setDraft(d=>({...d,[key]:+e.target.value}))}/>
              </div>
            ))}
            <div style={{display:"flex",gap:8,justifyContent:"flex-end",marginTop:20}}>
              <button className="btn" onClick={()=>setEditCat(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={()=>{
                setCatParams({...catParams,[editCat]:draft});
                setEditCat(null);
              }}>Save to DB</button>
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
      <div className="modal" onClick={e=>e.stopPropagation()} style={{minWidth:460}}>
        <div style={{fontSize:13,fontWeight:600,color:"#0f172a",marginBottom:4}}>SKU Parameters — {sku.id}</div>
        <div style={{fontSize:11,color:"#94a3b8",marginBottom:20}}>Leave blank to inherit from category ({sku.category})</div>
        {fields.map(f=>(
          <div key={f.key} style={{display:"flex",alignItems:"center",gap:12,marginBottom:14}}>
            <label style={{fontSize:11,color:"#94a3b8",textTransform:"uppercase",letterSpacing:"0.06em",width:140}}>{f.label}</label>
            <input className="input" type="number" placeholder={`Cat: ${f.catVal}`} value={draft[f.key]} style={{width:100,textAlign:"right"}}
              onChange={e=>setDraft(d=>({...d,[f.key]:e.target.value}))}/>
            {draft[f.key]!==""&&<span style={{fontSize:10,color:"#2563eb"}}>OVERRIDE</span>}
            <button className="btn" style={{fontSize:9,padding:"2px 7px",marginLeft:"auto"}}
              onClick={()=>setDraft(d=>({...d,[f.key]:""}))} >RESET</button>
          </div>
        ))}
        <div style={{background:"#f5f3ff",border:"1px solid #ddd6fe",borderRadius:3,padding:"10px 14px",marginTop:8,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <span style={{fontSize:11,color:"#7c3aed",fontWeight:600}}>Calculated Reorder Point</span>
          <span style={{fontSize:16,fontWeight:700,color:"#7c3aed",fontFamily:"'IBM Plex Sans',sans-serif"}}>{Math.round(rop)} units</span>
        </div>
        <div style={{display:"flex",gap:8,justifyContent:"flex-end",marginTop:20}}>
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
