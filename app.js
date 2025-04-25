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

  // Read workbook
  const buf = await fileIn.files[0].arrayBuffer();
  const wb  = XLSX.read(buf, { type:'array' });
  const ws  = wb.Sheets[wb.SheetNames[0]];
  const rows= XLSX.utils.sheet_to_json(ws, { header:1, raw:true, blankrows:false });

  // Find header
  const LABELS = ['REF','PRODUCT','BOX USED (BOX1 OR BOX2)','ORDER IN UNITS'];
  let headerRow=-1, ci={};
  for (let i=0; i<Math.min(rows.length,20); i++){
    const up = rows[i].map(c=>c!=null?c.toString().toUpperCase().trim():'');
    if (LABELS.every(l=>up.includes(l))){
      headerRow=i;
      ci = {
        REF:   up.indexOf('REF'),
        PROD:  up.indexOf('PRODUCT'),
        BOX:   up.indexOf('BOX USED (BOX1 OR BOX2)'),
        UNITS: up.indexOf('ORDER IN UNITS')
      };
      break;
    }
  }
  if (headerRow<0) {
    return alert('Could not find header row with REF / PRODUCT / BOX USED / ORDER IN UNITS.');
  }

  // Build orders[]
  const orders = [];
  for (let i=headerRow+1; i<rows.length; i++){
    const r = rows[i], raw=r[ci.REF];
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

  // Expand into instances
  let instances=[];
  orders.forEach(o=>{
    const pd = products[o.sku], spec=pd[o.boxKey];
    if (!spec||!spec.units) return;
    const count = Math.ceil(o.units/spec.units);
    const [L,D,H] = spec.dimensions;
    for(let k=0;k<count;k++){
      instances.push({
        sku: o.sku,
        name: o.name,
        fragility: pd.fragility.toLowerCase(),
        weight: spec.weight,
        dims: {l:L,w:D,h:H},
        canRotate: spec.orientation.toLowerCase()==='both'
      });
    }
  });
  if (!instances.length) {
    return document.getElementById('output').innerHTML=
      '<p><em>No boxes to pack after expansion.</em></p>';
  }

  // Sort by fragility
  const fragOrder={strong:0,medium:1,fragile:2};
  instances.sort((a,b)=>fragOrder[a.fragility]-fragOrder[b.fragility]);

  // Pack into pallets
  let remaining=instances.slice(), pallets=[];
  while(remaining.length){
    let usedH=0, usedWT=PALLET_WT;
    const pal={layers:[]};
    while(remaining.length){
      const {placed,notPlaced} = packLayer(remaining);
      if (!placed.length) break;
      const layerH  = Math.max(...placed.map(x=>x.box.dims.h));
      const layerWT = placed.reduce((s,x)=>s+x.box.weight,0);
      if (usedH+layerH>PALLET_MAX_H || usedWT+layerWT>PALLET_MAX_WT) break;
      pal.layers.push({boxes:placed,height:layerH,weight:layerWT});
      usedH  += layerH;
      usedWT += layerWT;
      remaining = notPlaced;
    }
    pallets.push(pal);
  }

  // Render
  let html=`<h1>${customer}</h1>`, totalBoxes=0, totalUnits=0, totalWT=0;
  pallets.forEach((p,i)=>{
    html+=`<h2>PALLET ${i+1}</h2>`;
    let pUnits=0,pBoxes=0,pWT=PALLET_WT,pH=0;
    p.layers.forEach((ly,li)=>{
      html+=`<h3>LAYER${li+1}</h3>
        <table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;">
          <thead><tr>
            <th>SKU</th><th>Product</th><th>Units</th>
            <th>Box Type</th><th>Boxes Needed</th>
          </tr></thead><tbody>`;
      const cnt={};
      ly.boxes.forEach(b=>cnt[b.box.sku]=(cnt[b.box.sku]||0)+1);
      for(const [sku,n] of Object.entries(cnt)){
        const ord=orders.find(o=>o.sku===sku);
        const perBox=products[sku][ord.boxKey].units;
        const units=perBox*n;
        html+=`<tr>
          <td>${sku}</td>
          <td>${ord.name}</td>
          <td style="text-align:right">${units}</td>
          <td>${ord.boxKey.toUpperCase()}</td>
          <td style="text-align:right">${n}</td>
        </tr>`;
        pUnits+=units; pBoxes+=n;
      }
      pWT+=ly.weight; pH+=ly.height;
      html+=`</tbody></table>`;
    });
    html+=`<p><strong>Summary pallet ${i+1}:</strong>
      ${pUnits} units | ${pBoxes} Boxes |
      Total Weight: ${pWT.toFixed(1)} Kg |
      Total Height: ${pH} cm</p>`;
    totalBoxes+=pBoxes; totalUnits+=pUnits; totalWT+=pWT;
  });
  html+=`<h2>ORDER RESUME:</h2>
    <p>Total Pallets: ${pallets.length}<br>
       Total Weight: ${totalWT.toFixed(1)} Kg</p>`;
  document.getElementById('output').innerHTML=html;
});

// packLayer now has a homogeneous SKU fast-path
function packLayer(boxes){
  // detect homogeneous
  const first = boxes[0].box||boxes[0];
  const same = boxes.every(b=>b.sku===first.sku
    && b.dims.l===first.dims.l && b.dims.w===first.dims.w
    && b.canRotate
  );
  if (same){
    return homogeneousPack(boxes);
  }
  // else fall back to guillotine
  return guillotinePack(boxes);
}

// if all boxes are identical and rotatable, do two‐row fill:
function homogeneousPack(boxes){
  const b = boxes[0];
  const L=b.dims.l, W=b.dims.w;
  // orient A = [L×W], B = [W×L]
  const opts = [{l:L,w:W},{l:W,w:L}];
  // first row: pick orientation that gives max across:
  let best = {count:-1, opt:null, rowH:0};
  for(const o of opts){
    const cnt = Math.floor(PALLET_L/o.l);
    if (cnt>best.count){
      best = {count:cnt,opt:o, rowH:o.w};
    }
  }
  const first = best.opt, firstCnt=best.count, rowH=best.rowH;
  const remH = PALLET_W - rowH;
  // second row: pick orientation that fits remH and maximizes
  let secondCnt=0, secondOpt=null;
  for(const o of opts){
    if (o.w<=remH){
      const cnt = Math.floor(PALLET_L/o.l);
      if (cnt>secondCnt){
        secondCnt=cnt; secondOpt=o;
      }
    }
  }
  // now build placements:
  const placed=[];
  // row1:
  for(let i=0;i<firstCnt;i++){
    placed.push({
      box:b,
      x: i*first.l, y:0,
      dims:first
    });
  }
  // row2:
  if (secondCnt>0){
    for(let i=0;i<secondCnt;i++){
      placed.push({
        box:b,
        x: i*secondOpt.l,
        y:rowH,
        dims:secondOpt
      });
    }
  }
  const used = firstCnt+secondCnt;
  return {
    placed,
    notPlaced: boxes.slice(used)
  };
}

// standard guillotine pack (unchanged)
function guillotinePack(boxes){
  const free=[{x:0,y:0,w:PALLET_L,h:PALLET_W}];
  const placed=[];
  let notPlaced=boxes.slice();
  boxes.forEach(b=>{
    const opts=[{l:b.dims.l,w:b.dims.w}];
    if(b.canRotate) opts.push({l:b.dims.w,w:b.dims.l});
    let fit=null;
    for(const slot of free){
      for(const d of opts){
        if(d.l<=slot.w && d.w<=slot.h){
          fit={slot,d}; break;
        }
      }
      if(fit) break;
    }
    if(!fit) return;
    placed.push({box:b, x:fit.slot.x,y:fit.slot.y,dims:fit.d});
    free.splice(free.indexOf(fit.slot),1);
    free.push({
      x: fit.slot.x+fit.d.l,
      y: fit.slot.y,
      w: fit.slot.w-fit.d.l,
      h: fit.d.w
    },{
      x: fit.slot.x,
      y: fit.slot.y+fit.d.w,
      w: fit.slot.w,
      h: fit.slot.h-fit.d.w
    });
    notPlaced=notPlaced.filter(x=>x!==b);
  });
  return {placed, notPlaced};
}
