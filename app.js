// app.js

// --- Pallet constraints ---
const PALLET_L      = 120;  // cm
const PALLET_W      =  80;  // cm
const PALLET_MAX_H  = 170;  // cm total stack height
const PALLET_MAX_WT = 600;  // kg including pallet
const PALLET_WT     =  25;  // kg empty pallet

let products = {};
window.addEventListener('DOMContentLoaded', async () => {
  try {
    const res = await fetch(`products-detail.json?cb=${Date.now()}`);
    products = await res.json();
  } catch (e) {
    console.error('Error loading products-detail.json', e);
    alert('Could not load product master data.');
  }
});

document.getElementById('go').addEventListener('click', async () => {
  const customer = document.getElementById('customer').value.trim();
  const fileIn   = document.getElementById('fileInput');
  if (!customer || !fileIn.files.length) {
    return alert('Enter a customer name and select an Excel file.');
  }

  // 1) Read workbook
  const buf = await fileIn.files[0].arrayBuffer();
  const wb  = XLSX.read(buf, { type:'array' });
  const ws  = wb.Sheets[wb.SheetNames[0]];
  const rows= XLSX.utils.sheet_to_json(ws, { header:1, raw:true, blankrows:false });

  // 2) Detect header
  const LABELS = ['REF','PRODUCT','BOX USED (BOX1 OR BOX2)','ORDER IN UNITS'];
  let hr=-1, ci={};
  for (let i=0; i<Math.min(rows.length,20); i++){
    const up = rows[i].map(c=>c!=null?c.toString().toUpperCase().trim():'');
    if (LABELS.every(l=>up.includes(l))){
      hr = i;
      ci = {
        REF:   up.indexOf('REF'),
        PROD:  up.indexOf('PRODUCT'),
        BOX:   up.indexOf('BOX USED (BOX1 OR BOX2)'),
        UNITS: up.indexOf('ORDER IN UNITS')
      };
      break;
    }
  }
  if (hr<0) {
    return alert('Could not find header row with REF / PRODUCT / BOX USED / ORDER IN UNITS.');
  }

  // 3) Parse orders
  const orders = [];
  for (let i=hr+1; i<rows.length; i++){
    const r=rows[i], raw=r[ci.REF];
    if (raw==null||!raw.toString().trim()) break;
    const sku = raw.toString().trim();
    if (!products[sku]) continue;
    orders.push({
      sku,
      name:   (r[ci.PROD]||'').toString().trim()||sku,
      boxKey: (r[ci.BOX]||'').toString().trim().toLowerCase(),
      units:  Number(r[ci.UNITS])||0
    });
  }
  if (!orders.length) {
    return document.getElementById('output').innerHTML=
      '<p><em>No valid order lines found. Check your file.</em></p>';
  }

  // 4) Expand into box instances
  let instances = [];
  orders.forEach(o=>{
    const pd = products[o.sku], spec = pd[o.boxKey];
    if (!spec||!spec.units) return;
    const cnt = Math.ceil(o.units/spec.units),
          [L,D,H] = spec.dimensions;
    for (let k=0; k<cnt; k++){
      instances.push({
        sku:       o.sku,
        name:      o.name,
        fragility: pd.fragility.toLowerCase(),
        weight:    spec.weight,
        dims:      { l:L, w:D, h:H },
        canRotate: spec.orientation.toLowerCase()==='both'
      });
    }
  });
  if (!instances.length) {
    return document.getElementById('output').innerHTML=
      '<p><em>No boxes to pack after expansion.</em></p>';
  }

  // 5) Sort by fragility
  const orderF={strong:0,medium:1,fragile:2};
  instances.sort((a,b)=>orderF[a.fragility]-orderF[b.fragility]);

  // 6) Pack into pallets
  let remaining=instances.slice(), pallets=[];
  while (remaining.length){
    let usedH=0, usedWT=PALLET_WT;
    const pal={layers:[]};
    while (remaining.length){
      const {placed, notPlaced} = packLayer(remaining);
      if (!placed.length) break;
      const layerH  = Math.max(...placed.map(x=>x.box.dims.h)),
            layerWT = placed.reduce((s,x)=>s+x.box.weight,0);
      if (usedH+layerH>PALLET_MAX_H || usedWT+layerWT>PALLET_MAX_WT) break;
      pal.layers.push({boxes:placed,height:layerH,weight:layerWT});
      usedH  += layerH;
      usedWT += layerWT;
      remaining = notPlaced;
    }
    pallets.push(pal);
  }

  // 7) Render
  let html=`<h1>${customer}</h1>`,
      totBoxes=0, totUnits=0, totWT=0;

  pallets.forEach((p,pi)=>{
    html+=`<h2>PALLET ${pi+1}</h2>`;
    let pUnits=0, pBoxes=0, pWT=PALLET_WT, pH=0;
    p.layers.forEach((ly,li)=>{
      html+=`<h3>LAYER${li+1}</h3>
        <table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;">
          <thead><tr>
            <th>SKU</th><th>Product</th><th>Units</th>
            <th>Box Type</th><th>Boxes Needed</th>
          </tr></thead><tbody>`;
      const cnt = {};
      ly.boxes.forEach(b=>cnt[b.box.sku]=(cnt[b.box.sku]||0)+1);
      for (const [sku,n] of Object.entries(cnt)){
        const o = orders.find(x=>x.sku===sku),
              per = products[sku][o.boxKey].units,
              u = per*n;
        html+=`<tr>
          <td>${sku}</td>
          <td>${o.name}</td>
          <td style="text-align:right">${u}</td>
          <td>${o.boxKey.toUpperCase()}</td>
          <td style="text-align:right">${n}</td>
        </tr>`;
        pUnits+=u;
        pBoxes+=n;
      }
      pWT+=ly.weight;
      pH +=ly.height;
      html+=`</tbody></table>`;
    });
    html+=`<p><strong>Summary pallet ${pi+1}:</strong>
      ${pUnits} units | ${pBoxes} Boxes |
      Total Weight: ${pWT.toFixed(1)} Kg |
      Total Height: ${pH} cm</p>`;
    totBoxes+=pBoxes;
    totUnits+=pUnits;
    totWT+=pWT;
  });

  html+=`<h2>ORDER RESUME:</h2>
    <p>Total Pallets: ${pallets.length}<br>
       Total Weight: ${totWT.toFixed(1)} Kg</p>`;
  document.getElementById('output').innerHTML = html;
});


// === packLayer now picks the single largest SKU/dims group ===
function packLayer(boxes){
  // group by sku+footprint
  const map = new Map();
  boxes.forEach(b=>{
    const key = `${b.sku}|${b.dims.l}x${b.dims.w}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(b);
  });
  // find the largest group
  let maxGroup=[], maxKey=null;
  for (const [k,arr] of map) {
    if (arr.length>maxGroup.length) {
      maxGroup = arr;
      maxKey   = k;
    }
  }
  // if >1 box in that group, do the 5+2 homogeneous pack
  if (maxGroup.length>1) {
    const {placed, notPlaced: leftoverGroup} = homogeneousPack(maxGroup);
    // remove 'placed' from the global boxes
    const notPlaced = boxes.slice();
    placed.forEach(p=>{
      const idx = notPlaced.indexOf(p.box);
      if (idx>=0) notPlaced.splice(idx,1);
    });
    return {placed, notPlaced};
  }
  // otherwise fallback
  return guillotinePack(boxes);
}

// fast “5 + 2” split for identical dims
function homogeneousPack(boxes){
  const b = boxes[0];
  const opts = [
    {l:b.dims.l, w:b.dims.w},
    {l:b.dims.w, w:b.dims.l}
  ];
  // row1: best orientation along pallet length
  let r1={count:-1,opt:null,h:0};
  opts.forEach(o=>{
    const c = Math.floor(PALLET_L/o.l);
    if (c>r1.count) r1={count:c,opt:o,h:o.w};
  });
  // row2: try stacking over row1
  const remH = PALLET_W - r1.h;
  let r2={count:0,opt:null};
  opts.forEach(o=>{
    if (o.w<=remH) {
      const c = Math.floor(PALLET_L/o.l);
      if (c>r2.count) r2={count:c,opt:o};
    }
  });
  // place them
  const placed=[];
  // row1 at y=0
  for(let i=0;i<r1.count;i++){
    placed.push({box:b,x:i*r1.opt.l,y:0,dims:r1.opt});
  }
  // row2 at y=row1.h
  for(let i=0;i<r2.count;i++){
    placed.push({box:b,x:i*r2.opt.l,y:r1.h,dims:r2.opt});
  }
  // leftover from this group
  const notPlacedGroup = boxes.slice(r1.count + r2.count);
  return {placed, notPlaced: notPlacedGroup};
}

// classic guillotine pack
function guillotinePack(boxes){
  const free=[{x:0,y:0,w:PALLET_L,h:PALLET_W}], placed=[], notPlaced=boxes.slice();
  boxes.forEach(b=>{
    const opts=[{l:b.dims.l,w:b.dims.w}];
    if (b.canRotate) opts.push({l:b.dims.w,w:b.dims.l});
    let fit=null;
    for(const slot of free){
      for(const d of opts){
        if (d.l<=slot.w && d.w<=slot.h){
          fit={slot,d}; break;
        }
      }
      if (fit) break;
    }
    if (!fit) return;
    placed.push({box:b,x:fit.slot.x,y:fit.slot.y,dims:fit.d});
    free.splice(free.indexOf(fit.slot),1);
    free.push(
      { x:fit.slot.x+fit.d.l, y:fit.slot.y,       w:fit.slot.w-fit.d.l, h:fit.d.w },
      { x:fit.slot.x,         y:fit.slot.y+fit.d.w, w:fit.slot.w,             h:fit.slot.h-fit.d.w }
    );
    const idx = notPlaced.indexOf(b);
    if (idx>=0) notPlaced.splice(idx,1);
  });
  return {placed, notPlaced};
}
